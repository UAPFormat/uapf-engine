import fs from "fs";
import path from "path";
import { PACKAGES_DIR } from "../config";
import { logger } from "../utils/logger";
import {
  ArtifactKind,
  IUapfRegistry,
  PackageSummary,
  RegistryMode,
  ResolveResourcesRequest,
  ResourceBindingResult,
} from "./IUapfRegistry";
import { LoadedPackage, UapfLoader } from "./UapfLoader";
import { UapfValidator } from "./UapfValidator";

function normalizeBindings(bindings: any[] | undefined): ResourceBindingResult["bindings"] {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return [
      {
        type: "system",
        target: "unbound",
        status: "unbound",
      },
    ];
  }

  return bindings.map((binding) => ({
    type: binding.type ?? "system",
    target: binding.target ?? "unbound",
    invocation: binding.invocation,
    status:
      binding.status ??
      (binding.requiredClaims && binding.requiredClaims.length > 0
        ? "blocked"
        : "resolved"),
    requiredClaims: binding.requiredClaims,
  }));
}

function pickBindings(resources: any, processId?: string, taskId?: string) {
  if (!resources) return undefined;
  const scopedProcess = resources.processes?.[processId ?? ""];
  if (taskId && scopedProcess?.tasks?.[taskId]) {
    return scopedProcess.tasks[taskId].bindings;
  }
  if (taskId && resources.tasks?.[taskId]) {
    return resources.tasks[taskId].bindings;
  }
  if (scopedProcess?.bindings) return scopedProcess.bindings;
  if (resources.package?.bindings) return resources.package.bindings;
  return resources.bindings;
}

function summarize(pkg: LoadedPackage, mode: RegistryMode): PackageSummary {
  const manifest = pkg.manifest || {};
  return {
    packageId: pkg.packageId,
    version: pkg.version,
    name: manifest.name,
    description: manifest.description,
    level: manifest.level,
    runnable: manifest.exposure?.mcp?.runnable,
    processes: manifest.processes?.map((p: any) => ({
      id: p.id,
      label: p.label,
      bpmnProcessId: p.bpmnProcessId,
    })),
    decisions: manifest.decisions?.map((d: any) => ({
      id: d.id,
      label: d.label,
      dmnDecisionId: d.dmnDecisionId,
    })),
    artifacts: pkg.artifacts,
    requiredClaims: manifest.policies?.requiredClaims || pkg.policies?.requiredClaims,
    guardrails: pkg.guardrails,  // G7
    source: { mode, location: pkg.sourcePath },
  };
}

export class DirectoryRegistry implements IUapfRegistry {
  private packages: Map<string, LoadedPackage> = new Map();

  constructor(private validator: UapfValidator) {}

  mode(): RegistryMode {
    return "packages";
  }

  async loadAll(): Promise<void> {
    if (!fs.existsSync(PACKAGES_DIR)) {
      logger.warn(`PACKAGES_DIR not found: ${PACKAGES_DIR}`);
      return;
    }
    const files = await fs.promises.readdir(PACKAGES_DIR, { withFileTypes: true });
    const uapfFiles = files
      .filter((file) => file.isFile() && file.name.toLowerCase().endsWith(".uapf"))
      .map((file) => path.join(PACKAGES_DIR, file.name));

    for (const filePath of uapfFiles) {
      try {
        const loaded = await UapfLoader.loadFromFile(filePath);
        this.packages.set(loaded.packageId, loaded);
        loaded.warnings.forEach((w) =>
          logger.warn(`Package ${loaded.packageId} warning: ${w}`)
        );
        logger.info(
          `Loaded UAPF package ${loaded.packageId}@${loaded.version ?? ""} from ${filePath}`
        );
      } catch (err) {
        logger.error(`Failed to load package ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Clears the in-memory registry and re-scans PACKAGES_DIR. Used after a new
   * .uapf has been dropped into the directory (e.g. via installFromUrl) or
   * after an external update.
   */
  async reloadAll(): Promise<PackageSummary[]> {
    this.packages.clear();
    await this.loadAll();
    return this.listPackages();
  }

  /**
   * Fetches a .uapf file from a remote URL, writes it into PACKAGES_DIR, and
   * reloads the registry. This is the bridge that lets OpenDMS sync a UAPF
   * package from ProcessGit at runtime — change a DMN rule in the repo, click
   * Sync in OpenDMS, the engine picks up the new version on the next session.
   *
   * The URL must return either:
   *   - a .uapf (zip) file directly, OR
   *   - a Gitea/GitHub repo archive (also a zip). For repo archives we strip
   *     the leading top-level folder so the manifest.json lands at the
   *     archive root inside the .uapf, matching the structure UapfLoader
   *     expects.
   */
  async installFromUrl(opts: {
    sourceUrl: string;
    packageId?: string;
    filename?: string;
  }): Promise<{ filename: string; packageId: string; version?: string }> {
    if (!opts.sourceUrl) {
      throw new Error("installFromUrl: sourceUrl is required");
    }

    // Ensure target dir exists
    await fs.promises.mkdir(PACKAGES_DIR, { recursive: true });

    // Download the bytes
    logger.info(`installFromUrl: fetching ${opts.sourceUrl}`);
    const res = await fetch(opts.sourceUrl);
    if (!res.ok) {
      throw new Error(`installFromUrl: HTTP ${res.status} fetching ${opts.sourceUrl}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error(`installFromUrl: empty response from ${opts.sourceUrl}`);
    }

    // Repository archives from Gitea/GitHub contain a single top-level dir
    // (e.g. "iesnieguma-izskatisana/manifest.json"). UapfLoader expects
    // manifest.json at the root. Detect and normalize.
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    const rootEntries = new Set(
      entries
        .map((e) => e.entryName.split("/")[0])
        .filter((s) => s.length > 0)
    );
    let outBuf: Buffer;
    if (rootEntries.size === 1 && !zip.getEntry("manifest.json")) {
      // Repo archive shape — strip the leading dir
      const prefix = [...rootEntries][0] + "/";
      const stripped = new AdmZip();
      for (const e of entries) {
        if (e.isDirectory) continue;
        if (!e.entryName.startsWith(prefix)) continue;
        const newName = e.entryName.substring(prefix.length);
        if (!newName) continue;
        stripped.addFile(newName, e.getData());
      }
      outBuf = stripped.toBuffer();
      logger.info(`installFromUrl: detected repo archive, stripped prefix '${prefix}'`);
    } else {
      outBuf = buf;
    }

    // Persist to PACKAGES_DIR with a deterministic filename so re-syncs overwrite
    const filename =
      opts.filename ??
      (opts.packageId
        ? `${opts.packageId}.uapf`
        : `package-${Date.now()}.uapf`);
    const target = path.join(PACKAGES_DIR, filename);
    await fs.promises.writeFile(target, outBuf);
    logger.info(`installFromUrl: wrote ${target} (${outBuf.length} bytes)`);

    // Load just this one package and merge into the registry so we don't lose
    // any other packages that may have been side-loaded.
    const loaded = await UapfLoader.loadFromFile(target);

    // If the filename was auto-generated (no packageId/filename supplied), the
    // real package id is only known after load. Rename the persisted .uapf to
    // <packageId>.uapf so subsequent re-syncs overwrite deterministically
    // instead of accumulating package-<timestamp>.uapf files.
    let finalFilename = filename;
    if (
      !opts.filename &&
      !opts.packageId &&
      loaded.packageId &&
      !filename.startsWith(`${loaded.packageId}.`)
    ) {
      finalFilename = `${loaded.packageId}.uapf`;
      const finalTarget = path.join(PACKAGES_DIR, finalFilename);
      if (finalTarget !== target) {
        await fs.promises.rename(target, finalTarget);
        loaded.sourcePath = finalTarget;
      }
    }

    this.packages.set(loaded.packageId, loaded);
    logger.info(
      `installFromUrl: registered ${loaded.packageId}@${loaded.version ?? ""}`
    );
    return {
      filename: finalFilename,
      packageId: loaded.packageId,
      version: loaded.version,
    };
  }

  async listPackages(): Promise<PackageSummary[]> {
    return Array.from(this.packages.values()).map((pkg) => summarize(pkg, "packages"));
  }

  async getPackage(packageId: string): Promise<PackageSummary | null> {
    const pkg = this.packages.get(packageId);
    if (!pkg) return null;
    return summarize(pkg, "packages");
  }

  async getArtifact(
    packageId: string,
    kind: ArtifactKind,
    id?: string
  ): Promise<{ mediaType: string; content: Buffer } | null> {
    const pkg = this.packages.get(packageId);
    if (!pkg) return null;
    const artifact = pkg.artifacts.find(
      (a) => a.kind === kind && (!id || a.id === id)
    );
    if (!artifact) return null;
    const mediaType =
      artifact.mediaType || (kind === "manifest" ? "application/json" : "application/xml");
    const content = await fs.promises.readFile(artifact.path);
    return { mediaType, content };
  }

  async resolveResources(req: ResolveResourcesRequest): Promise<ResourceBindingResult> {
    const pkg = this.packages.get(req.packageId);
    const bindings = normalizeBindings(
      pickBindings(pkg?.resources, req.processId, req.taskId)
    );
    return {
      scope: {
        packageId: req.packageId,
        processId: req.processId,
        taskId: req.taskId,
      },
      bindings,
    };
  }

  async validateWorkspaceOrPackage(opts: {
    packageId?: string;
  }): Promise<{ ok: boolean; issues: { level: "error" | "warn"; message: string; path?: string }[] }> {
    const issues: { level: "error" | "warn"; message: string; path?: string }[] = [
      ...this.validator.collectStartupWarnings(),
    ];
    const packagesToValidate = opts.packageId
      ? [this.packages.get(opts.packageId)].filter(Boolean)
      : Array.from(this.packages.values());

    if (opts.packageId && packagesToValidate.length === 0) {
      issues.push({ level: "error", message: `Package not found: ${opts.packageId}` });
    }

    for (const pkg of packagesToValidate) {
      issues.push(...this.validator.validatePackage(pkg as LoadedPackage));
    }

    const ok = issues.every((i) => i.level !== "error");
    return { ok, issues };
  }
}
