import crypto from "crypto";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import yaml from "js-yaml";
import {
  ArtifactKind,
  ArtifactRef,
  RegistryMode,
} from "./IUapfRegistry";
import { AlgorithmCard } from "../types/uapf";
import { ARTIFACT_CACHE_DIR } from "../config";

export interface LoadedPackage {
  manifest: any;
  packageId: string;
  version?: string;
  sourcePath: string;
  artifacts: ArtifactRef[];
  policies?: any;
  resources?: any;
  guardrails?: any;            // G7: parsed resources/guardrails.* if present
  algorithmCards?: Record<string, AlgorithmCard>;  // v2.4.0: cards keyed by id
  warnings: string[];
  sourceMode?: RegistryMode;
}

const MANIFEST_FILES = ["manifest.json", "uapf.json", "uapf.manifest.json"];
const RESOURCE_FILES = ["resources.json", "resources.yaml", "resources.yml"];
const POLICY_FILES = ["policies.json", "policies.yaml", "policies.yml"];
// G7: guardrails travel inside the package under resources/. The runtime must
// resolve them into the session so they are enforced at every capability call.
const GUARDRAILS_FILES = [
  "resources/guardrails.yaml",
  "resources/guardrails.yml",
  "resources/guardrails.json",
];

function sanitizeEntryName(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/g, "");
  const parts = normalized
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join(path.sep);
}

function mediaTypeForPath(kind: ArtifactKind, filePath: string): string {
  if (kind === "manifest") return "application/json";
  if (kind === "bpmn" || kind === "dmn" || kind === "cmmn") {
    return "application/xml";
  }
  if (kind === "docs") {
    if (filePath.toLowerCase().endsWith(".md")) return "text/markdown";
    return "text/plain";
  }
  if (kind === "algorithm-card") {
    if (filePath.toLowerCase().endsWith(".json")) return "application/json";
    return "application/yaml";
  }
  return "application/json";
}

function ensureCacheDir(base: string): string {
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function readJsonBuffer(buffer: Buffer): any {
  return JSON.parse(buffer.toString("utf-8"));
}

function readYamlBuffer(buffer: Buffer): any {
  return yaml.load(buffer.toString("utf-8"));
}

async function isZipFile(filePath: string): Promise<boolean> {
  const fd = await fs.promises.open(filePath, "r");
  const probe = Buffer.alloc(2);
  try {
    await fd.read(probe, 0, 2, 0);
  } finally {
    await fd.close();
  }
  return probe[0] === 0x50 && probe[1] === 0x4b;
}

export class UapfLoader {
  static async loadFromFile(filePath: string): Promise<LoadedPackage> {
    if (await isZipFile(filePath)) {
      return this.loadFromZip(filePath);
    }
    return this.loadFromJsonStub(filePath);
  }

  private static async loadFromJsonStub(filePath: string): Promise<LoadedPackage> {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const manifest = parsed.manifest ?? parsed;
    const warnings: string[] = [];

    if (!parsed.manifest) {
      warnings.push("Legacy stub detected: using root object as manifest");
    }

    const packageId = manifest?.id || path.basename(filePath, path.extname(filePath));
    const artifacts: ArtifactRef[] = [
      {
        kind: "manifest",
        path: filePath,
        mediaType: "application/json",
        id: manifest?.id,
      },
    ];

    const policies = parsed.policies || manifest?.policies;
    const resources = parsed.resources || manifest?.resources;

    return {
      manifest,
      packageId,
      version: manifest?.version,
      sourcePath: filePath,
      artifacts,
      policies,
      resources,
      warnings,
    };
  }

  private static async loadFromZip(filePath: string): Promise<LoadedPackage> {
    const zip = new AdmZip(filePath);
    const warnings: string[] = [];
    const artifacts: ArtifactRef[] = [];

    const cacheBase = ensureCacheDir(
      path.join(
        ARTIFACT_CACHE_DIR,
        crypto.createHash("sha1").update(filePath).digest("hex")
      )
    );

    const entries = zip.getEntries();
    const toPosix = (s: string): string =>
      s.replace(/\\/g, "/").replace(/^\/+/, "");

    // -- Locate the package root --------------------------------------------
    // A UAPF package is defined by the location of its manifest, not by the
    // archive root. The manifest (uapf.yaml, kind: uapf.package) may live in a
    // subdirectory of a multi-level workspace repo (e.g.
    // processes/L4/<pkg>/uapf.yaml). Find it and treat its directory as the
    // package root; cornerstone folders (bpmn/, dmn/, cmmn/, docs/) resolve
    // relative to that root. Falls back to a legacy JSON manifest at the
    // archive root for backward compatibility.
    let manifest: any = null;
    let rootPrefix = "";

    const yamlManifestEntries = entries
      .filter(
        (e) =>
          !e.isDirectory && /(^|\/)uapf\.ya?ml$/i.test(toPosix(e.entryName))
      )
      .sort(
        (a, b) =>
          toPosix(a.entryName).split("/").length -
          toPosix(b.entryName).split("/").length
      );
    for (const e of yamlManifestEntries) {
      try {
        const doc: any = readYamlBuffer(e.getData());
        if (doc && doc.kind === "uapf.package") {
          manifest = doc;
          const posix = toPosix(e.entryName);
          const slash = posix.lastIndexOf("/");
          rootPrefix = slash >= 0 ? posix.slice(0, slash + 1) : "";
          if (rootPrefix) {
            warnings.push(
              `Package root detected at '${rootPrefix}' (nested package)`
            );
          }
          break;
        }
      } catch (err) {
        warnings.push(
          `Failed to parse ${e.entryName}: ${(err as Error).message}`
        );
      }
    }

    // Legacy fallback: JSON manifest at the archive root.
    if (!manifest) {
      for (const candidate of MANIFEST_FILES) {
        const entry = zip.getEntry(candidate) || zip.getEntry(`/${candidate}`);
        if (entry) {
          try {
            manifest = readJsonBuffer(entry.getData());
          } catch (err) {
            warnings.push(
              `Failed to parse manifest ${candidate}: ${(err as Error).message}`
            );
          }
          break;
        }
      }
    }

    if (!manifest) {
      warnings.push(
        "No manifest found in archive; attempting best-effort load"
      );
    }

    // Persist the manifest as a JSON artifact so getArtifact(pkg,'manifest')
    // resolves regardless of the manifest's original format/location.
    const manifestPath = path.join(cacheBase, "manifest.json");
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest ?? {}, null, 2)
    );
    artifacts.push({
      kind: "manifest",
      path: manifestPath,
      mediaType: "application/json",
      id: manifest?.id,
    });

    // -- Artifact discovery, resolved relative to the package root ----------
    let policies: any = undefined;
    let resources: any = undefined;
    let guardrails: any = undefined; // G7
    let algorithmCards: Record<string, AlgorithmCard> | undefined = undefined; // v2.4.0

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      // Rebase the entry path onto the package root; skip anything outside it.
      let rel = toPosix(entry.entryName);
      if (rootPrefix) {
        if (!rel.startsWith(rootPrefix)) continue;
        rel = rel.slice(rootPrefix.length);
      }
      if (!rel) continue;

      const safeRelPath = sanitizeEntryName(rel);
      if (!safeRelPath) continue;
      const lowerName = safeRelPath.toLowerCase();
      const posixLower = lowerName.split(path.sep).join("/");

      // G7: capture resources/guardrails.{yaml,yml,json} for session enforcement.
      if (GUARDRAILS_FILES.includes(posixLower)) {
        try {
          guardrails = posixLower.endsWith(".json")
            ? readJsonBuffer(entry.getData())
            : readYamlBuffer(entry.getData());
        } catch (err) {
          warnings.push(
            `Failed to parse guardrails: ${(err as Error).message}`
          );
        }
        continue;
      }

      const kind: ArtifactKind | null = (() => {
        if (MANIFEST_FILES.some((m) => lowerName.endsWith(m))) return "manifest";
        if (lowerName.startsWith(`bpmn${path.sep}`)) return "bpmn";
        if (lowerName.startsWith(`dmn${path.sep}`)) return "dmn";
        if (lowerName.startsWith(`cmmn${path.sep}`)) return "cmmn";
        if (lowerName.startsWith(`docs${path.sep}`)) return "docs";
        if (lowerName.startsWith(`tests${path.sep}`)) return "tests";
        // v2.4.0: algorithm cards under algorithms/*.card.{yaml,yml,json}
        if (lowerName.startsWith(`algorithms${path.sep}`) &&
            (lowerName.endsWith(".card.yaml") || lowerName.endsWith(".card.yml") || lowerName.endsWith(".card.json"))) {
          return "algorithm-card";
        }
        if (RESOURCE_FILES.some((name) => lowerName.endsWith(name))) return "docs";
        if (POLICY_FILES.some((name) => lowerName.endsWith(name))) return "docs";
        return null;
      })();

      if (!kind) continue;

      const destPath = path.join(cacheBase, safeRelPath);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, entry.getData());

      if (RESOURCE_FILES.some((name) => lowerName.endsWith(name))) {
        try {
          resources = lowerName.endsWith(".json")
            ? readJsonBuffer(entry.getData())
            : readYamlBuffer(entry.getData());
        } catch (err) {
          warnings.push(`Failed to parse resources: ${(err as Error).message}`);
        }
        continue;
      }

      if (POLICY_FILES.some((name) => lowerName.endsWith(name))) {
        try {
          policies = lowerName.endsWith(".json")
            ? readJsonBuffer(entry.getData())
            : readYamlBuffer(entry.getData());
        } catch (err) {
          warnings.push(`Failed to parse policies: ${(err as Error).message}`);
        }
        continue;
      }

      if (kind === "algorithm-card") {
        try {
          const parsed = lowerName.endsWith(".card.json")
            ? readJsonBuffer(entry.getData())
            : readYamlBuffer(entry.getData());
          if (parsed && typeof parsed === "object" && (parsed as any).id) {
            algorithmCards = algorithmCards || {};
            algorithmCards[(parsed as any).id as string] = parsed as AlgorithmCard;
          } else {
            warnings.push(`Algorithm card without id: ${lowerName}`);
          }
        } catch (err) {
          warnings.push(`Failed to parse algorithm card ${lowerName}: ${(err as Error).message}`);
        }
        // continue past — also add to artifacts list so /artifacts/algorithm-card listing works.
      }

      if (kind === "manifest") {
        // Manifest already handled above; avoid duplicate entries.
        continue;
      }

      // Derive an artifact id from the filename so getArtifact(pkg,kind,id) works.
      const base = path.basename(destPath);
      const artifactId = base
        .replace(/\.(bpmn|dmn|cmmn)\.xml$/i, "")
        .replace(/\.(bpmn|dmn|cmmn)$/i, "")
        .replace(/\.xml$/i, "");

      artifacts.push({
        kind,
        path: destPath,
        mediaType: mediaTypeForPath(kind, destPath),
        id: artifactId,
      });
    }

    const packageId =
      manifest?.id || path.basename(filePath, path.extname(filePath));

    return {
      manifest: manifest ?? {},
      packageId,
      version: manifest?.version,
      sourcePath: filePath,
      artifacts,
      resources,
      policies,
      guardrails,
      algorithmCards,
      warnings,
    };
  }
}
