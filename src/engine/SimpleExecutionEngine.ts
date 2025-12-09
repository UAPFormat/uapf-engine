import {
  IExecutionEngine,
  ExecuteProcessRequest,
  ExecuteProcessResult,
  EvaluateDecisionRequest,
  EvaluateDecisionResult,
} from "./ExecutionEngine";
import { PackageRegistry } from "../registry/packageRegistry";

export class SimpleExecutionEngine implements IExecutionEngine {
  constructor(private registry: PackageRegistry) {}

  async executeProcessOnce(
    req: ExecuteProcessRequest
  ): Promise<ExecuteProcessResult> {
    const pkg = this.registry.getById(req.packageId);
    if (!pkg) {
      throw new Error(`Unknown packageId: ${req.packageId}`);
    }

    const processExists = pkg.manifest.processes?.some(
      (p) => p.id === req.processId || p.bpmnProcessId === req.processId
    );
    if (!processExists) {
      throw new Error(`Unknown processId: ${req.processId}`);
    }

    return {
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
    };
  }

  async evaluateDecision(
    req: EvaluateDecisionRequest
  ): Promise<EvaluateDecisionResult> {
    const pkg = this.registry.getById(req.packageId);
    if (!pkg) {
      throw new Error(`Unknown packageId: ${req.packageId}`);
    }

    const decisionExists = pkg.manifest.decisions?.some(
      (d) => d.id === req.decisionId || d.dmnDecisionId === req.decisionId
    );
    if (!decisionExists) {
      throw new Error(`Unknown decisionId: ${req.decisionId}`);
    }

    return {
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
    };
  }
}
