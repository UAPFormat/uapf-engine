export interface ExecuteProcessRequest {
  packageId: string;
  processId: string;
  input: unknown;
}

export interface ExecuteProcessResult {
  applicationId?: string;
  status: string;
  outputs: unknown;
  explanations?: unknown[];
}

export interface EvaluateDecisionRequest {
  packageId: string;
  decisionId: string;
  input: unknown;
}

export interface EvaluateDecisionResult {
  outputs: unknown;
  explanations?: unknown[];
}

export interface IExecutionEngine {
  executeProcessOnce(req: ExecuteProcessRequest): Promise<ExecuteProcessResult>;
  evaluateDecision(req: EvaluateDecisionRequest): Promise<EvaluateDecisionResult>;
}
