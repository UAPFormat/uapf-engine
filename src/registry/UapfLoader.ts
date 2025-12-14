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
import { ARTIFACT_CACHE_DIR } from "../config";

export interface LoadedPackage {
  manifest: any;
  packageId: string;
  version?: string;
  sourcePath: string;
  artifacts: ArtifactRef[];
  policies?: any;
  resources?: any;
  warnings: string[];
  sourceMode?: RegistryMode;
}

const MANIFEST_FILES = ["manifest.json", "uapf.json", "uapf.manifest.json"];
const RESOURCE_FILES = ["resources.json", "resources.yaml", "resources.yml"];
const POLICY_FILES = ["policies.json", "policies.yaml", "policies.yml"];

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

    let manifest: any = null;
    let manifestPath = "";

    for (const candidate of MANIFEST_FILES) {
      const entry = zip.getEntry(candidate) || zip.getEntry(`/${candidate}`);
      if (entry) {
        try {
          manifest = readJsonBuffer(entry.getData());
          const safePath = sanitizeEntryName(candidate);
          manifestPath = path.join(cacheBase, safePath);
          await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
          await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
          artifacts.push({
            kind: "manifest",
            path: manifestPath,
            mediaType: "application/json",
            id: manifest?.id,
          });
        } catch (err) {
          warnings.push(`Failed to parse manifest ${candidate}: ${(err as Error).message}`);
        }
        break;
      }
    }

    if (!manifest) {
      warnings.push("No manifest found in archive; attempting best-effort load");
    }

    let policies: any = undefined;
    let resources: any = undefined;

    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const safeRelPath = sanitizeEntryName(entry.entryName);
      const lowerName = safeRelPath.toLowerCase();

      const kind: ArtifactKind | null = (() => {
        if (MANIFEST_FILES.some((m) => lowerName.endsWith(m))) return "manifest";
        if (lowerName.startsWith(`bpmn${path.sep}`)) return "bpmn";
        if (lowerName.startsWith(`dmn${path.sep}`)) return "dmn";
        if (lowerName.startsWith(`cmmn${path.sep}`)) return "cmmn";
        if (lowerName.startsWith(`docs${path.sep}`)) return "docs";
        if (lowerName.startsWith(`tests${path.sep}`)) return "tests";
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

      if (kind === "manifest") {
        // Manifest already handled above; avoid duplicate entries
        continue;
      }

      artifacts.push({
        kind,
        path: destPath,
        mediaType: mediaTypeForPath(kind, destPath),
      });
    }

    if (!manifest && manifestPath) {
      try {
        const parsed = await fs.promises.readFile(manifestPath, "utf-8");
        manifest = JSON.parse(parsed);
      } catch (err) {
        warnings.push(`Failed to read extracted manifest: ${(err as Error).message}`);
      }
    }

    const packageId = manifest?.id || path.basename(filePath, path.extname(filePath));

    if (!artifacts.find((a) => a.kind === "manifest")) {
      manifestPath = path.join(cacheBase, "manifest.json");
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest ?? {}, null, 2));
      artifacts.push({
        kind: "manifest",
        path: manifestPath,
        mediaType: "application/json",
        id: manifest?.id,
      });
      warnings.push("Injected manifest placeholder due to missing manifest entry");
    }

    return {
      manifest: manifest ?? {},
      packageId,
      version: manifest?.version,
      sourcePath: filePath,
      artifacts,
      resources,
      policies,
      warnings,
    };
  }
}
