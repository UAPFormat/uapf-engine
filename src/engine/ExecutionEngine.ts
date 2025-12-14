export interface ExecuteProcessRequest {
  packageId: string;
  processId: string;
  input: unknown;
}

export interface ExecuteProcessResult {
  packageId: string;
  processId: string;
  mode: "packages" | "workspace";
  applicationId?: string;
  status: string;
  outputs: unknown;
  explanations?: unknown[];
  artifactRefs?: Array<{ kind: string; path: string }>;
}

export interface EvaluateDecisionRequest {
  packageId: string;
  decisionId: string;
  input: unknown;
}

export interface EvaluateDecisionResult {
  packageId: string;
  decisionId: string;
  mode: "packages" | "workspace";
  outputs: unknown;
  explanations?: unknown[];
  artifactRefs?: Array<{ kind: string; path: string }>;
}

export interface IExecutionEngine {
  executeProcessOnce(req: ExecuteProcessRequest): Promise<ExecuteProcessResult>;
  evaluateDecision(req: EvaluateDecisionRequest): Promise<EvaluateDecisionResult>;
}
