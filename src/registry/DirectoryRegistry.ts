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
