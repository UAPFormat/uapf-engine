export type RegistryMode = "packages" | "workspace";

export type ArtifactKind = "manifest" | "bpmn" | "dmn" | "cmmn" | "docs" | "tests";

export interface ArtifactRef {
  kind: ArtifactKind;
  path: string;
  id?: string;
  mediaType?: string;
}

export interface PackageSummary {
  packageId: string;
  version?: string;
  name?: string;
  description?: string;
  level?: number;
  runnable?: boolean;
  processes?: Array<{ id: string; label?: string; bpmnProcessId?: string }>;
  decisions?: Array<{ id: string; label?: string; dmnDecisionId?: string }>;
  artifacts?: ArtifactRef[];
  requiredClaims?: string[];
  source: { mode: RegistryMode; location: string };
}

export interface ResolveResourcesRequest {
  packageId: string;
  processId?: string;
  taskId?: string;
}

export interface ResourceBindingResult {
  scope: { packageId: string; processId?: string; taskId?: string };
  bindings: Array<{
    type: "system" | "human" | "agent" | "external";
    target: string;
    invocation?: "mcp_tool" | "http_api" | "a2a" | "manual";
    status: "resolved" | "unbound" | "blocked";
    requiredClaims?: string[];
  }>;
}

export interface IUapfRegistry {
  mode(): RegistryMode;
  listPackages(): Promise<PackageSummary[]>;
  getPackage(packageId: string): Promise<PackageSummary | null>;
  getArtifact(
    packageId: string,
    kind: ArtifactKind,
    id?: string
  ): Promise<{ mediaType: string; content: Buffer } | null>;
  resolveResources(req: ResolveResourcesRequest): Promise<ResourceBindingResult>;
  validateWorkspaceOrPackage(opts: {
    packageId?: string;
  }): Promise<{
    ok: boolean;
    issues: Array<{ level: "error" | "warn"; message: string; path?: string }>;
  }>;
}
