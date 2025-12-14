import {
  IExecutionEngine,
  ExecuteProcessRequest,
  ExecuteProcessResult,
  EvaluateDecisionRequest,
  EvaluateDecisionResult,
} from "./ExecutionEngine";
import { IUapfRegistry } from "../registry/IUapfRegistry";

export class SimpleExecutionEngine implements IExecutionEngine {
  constructor(private registry: IUapfRegistry) {}

  async executeProcessOnce(
    req: ExecuteProcessRequest
  ): Promise<ExecuteProcessResult> {
    const pkg = await this.registry.getPackage(req.packageId);
    if (!pkg) {
      throw new Error(`Unknown packageId: ${req.packageId}`);
    }

    const processExists = pkg.processes?.some(
      (p) => p.id === req.processId || p.bpmnProcessId === req.processId
    );
    if (!processExists) {
      throw new Error(`Unknown processId: ${req.processId}`);
    }

    return {
      packageId: pkg.packageId,
      processId: req.processId,
      mode: this.registry.mode(),
      applicationId: `APP-${Date.now()}`,
      status: "demo-only",
      outputs: {
        echoInput: req.input,
        packageId: pkg.packageId,
        processId: req.processId,
      },
      explanations: [
        {
          message:
            "This is a stubbed execution result. Plug in a real BPMN/DMN engine here.",
        },
      ],
      artifactRefs: pkg.artifacts,
    };
  }

  async evaluateDecision(
    req: EvaluateDecisionRequest
  ): Promise<EvaluateDecisionResult> {
    const pkg = await this.registry.getPackage(req.packageId);
    if (!pkg) {
      throw new Error(`Unknown packageId: ${req.packageId}`);
    }

    const decisionExists = pkg.decisions?.some(
      (d) => d.id === req.decisionId || d.dmnDecisionId === req.decisionId
    );
    if (!decisionExists) {
      throw new Error(`Unknown decisionId: ${req.decisionId}`);
    }

    return {
      packageId: pkg.packageId,
      decisionId: req.decisionId,
      mode: this.registry.mode(),
      outputs: {
        echoInput: req.input,
        packageId: pkg.packageId,
        decisionId: req.decisionId,
      },
      explanations: [
        {
          message:
            "This is a stubbed decision result. Plug in a real DMN engine here.",
        },
      ],
      artifactRefs: pkg.artifacts,
    };
  }
}
