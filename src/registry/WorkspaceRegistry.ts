import fs from "fs";
import path from "path";
import yaml from "js-yaml";
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
import { WORKSPACE_INDEX_FILENAMES } from "../config";
import { logger } from "../utils/logger";

const RESOURCE_FILES = ["resources.json", "resources.yaml", "resources.yml"];

function normalizeBindings(bindings: any[] | undefined): ResourceBindingResult["bindings"] {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return [
      { type: "system", target: "unbound", status: "unbound" },
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

export class WorkspaceRegistry implements IUapfRegistry {
  private packages: Map<string, LoadedPackage> = new Map();
  private workspaceResources: any;
  private indexPath?: string;
  private indexData?: any;

  constructor(private workspaceDir: string, private validator: UapfValidator) {}

  mode(): RegistryMode {
    return "workspace";
  }

  async loadAll(): Promise<void> {
    await this.loadWorkspaceResources();
    await this.loadIndex();

    const packagePaths = await this.discoverPackages();
    for (const pkgPath of packagePaths) {
      try {
        const loaded = await UapfLoader.loadFromFile(pkgPath);
        loaded.sourceMode = "workspace";
        this.packages.set(loaded.packageId, loaded);
        loaded.warnings.forEach((w) =>
          logger.warn(`Package ${loaded.packageId} warning: ${w}`)
        );
        logger.info(`Loaded workspace package ${loaded.packageId} from ${pkgPath}`);
      } catch (err) {
        logger.error(`Failed to load package ${pkgPath}: ${(err as Error).message}`);
      }
    }
  }

  private async loadWorkspaceResources() {
    for (const candidate of RESOURCE_FILES) {
      const filePath = path.join(this.workspaceDir, candidate);
      if (fs.existsSync(filePath)) {
        try {
          const raw = await fs.promises.readFile(filePath);
          this.workspaceResources = candidate.endsWith(".json")
            ? JSON.parse(raw.toString("utf-8"))
            : yaml.load(raw.toString("utf-8"));
          logger.info(`Loaded workspace resources from ${candidate}`);
        } catch (err) {
          logger.warn(`Failed to read workspace resources ${candidate}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async loadIndex() {
    for (const candidate of WORKSPACE_INDEX_FILENAMES) {
      const filePath = path.join(this.workspaceDir, candidate);
      if (fs.existsSync(filePath)) {
        this.indexPath = filePath;
        try {
          const raw = await fs.promises.readFile(filePath, "utf-8");
          this.indexData = JSON.parse(raw);
          return;
        } catch (err) {
          logger.warn(`Failed to parse workspace index ${candidate}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async discoverPackages(): Promise<string[]> {
    const discovered = new Set<string>();

    const addPath = (p: string) => {
      if (!p) return;
      const resolved = path.isAbsolute(p) ? p : path.join(this.workspaceDir, p);
      discovered.add(resolved);
    };

    if (this.indexData) {
      const entries = Array.isArray((this.indexData as any).packages)
        ? (this.indexData as any).packages
        : (this.indexData as any).entries;
      if (Array.isArray(entries)) {
        entries.forEach((entry) => {
          if (typeof entry === "string") addPath(entry);
          else if (entry?.path) addPath(entry.path);
        });
      }
    }

    if (discovered.size === 0) {
      await this.walkForUapf(this.workspaceDir, discovered);
      const defaultDirs = [path.join(this.workspaceDir, "packages"), path.join(this.workspaceDir, "uapf")];
      for (const dir of defaultDirs) {
        if (fs.existsSync(dir)) {
          await this.walkForUapf(dir, discovered);
        }
      }
    }

    return Array.from(discovered.values());
  }

  private async walkForUapf(baseDir: string, discovered: Set<string>) {
    if (!fs.existsSync(baseDir)) return;
    const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        await this.walkForUapf(entryPath, discovered);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".uapf")) {
        discovered.add(entryPath);
      }
    }
  }

  async listPackages(): Promise<PackageSummary[]> {
    return Array.from(this.packages.values()).map((pkg) => summarize(pkg, "workspace"));
  }

  async getPackage(packageId: string): Promise<PackageSummary | null> {
    const pkg = this.packages.get(packageId);
    if (!pkg) return null;
    return summarize(pkg, "workspace");
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
    const packageBindings = pickBindings(pkg?.resources, req.processId, req.taskId);
    const workspaceBindings = pickBindings(
      this.workspaceResources,
      req.processId,
      req.taskId
    );
    const bindings = normalizeBindings(packageBindings ?? workspaceBindings);
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
    if (this.indexPath) {
      issues.push(...this.validator.validateWorkspaceIndex(this.indexData, this.indexPath));
    }
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
