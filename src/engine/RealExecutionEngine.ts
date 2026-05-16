// RealExecutionEngine — the v0.1 reference execution engine.
//
// Implements the legacy IExecutionEngine surface (executeProcessOnce,
// evaluateDecision) for backwards compatibility, plus the session-based
// surface used by the UAPF-IP start-session endpoint.
//
// Composition:
//   - BpmnWalker      walks BPMN structure
//   - DmnTableEvaluator evaluates DMN tables
//   - HostClient      invokes host capabilities back over HTTP
//   - SessionManager  tracks session state
//   - AuditEmitter    emits CloudEvents audit records

import * as crypto from "crypto";
import {
  IExecutionEngine,
  ExecuteProcessRequest,
  ExecuteProcessResult,
  EvaluateDecisionRequest,
  EvaluateDecisionResult,
} from "./ExecutionEngine";
import { IUapfRegistry, PackageSummary } from "../registry/IUapfRegistry";
import { BpmnWalker, BpmnNode, StepHandler } from "./BpmnWalker";
import { DmnTableEvaluator } from "./DmnTableEvaluator";
import { HostClient } from "./HostClient";
import { SessionManager, AuditEmitter } from "./SessionManager";
import {
  StartSessionRequest,
  StartSessionResponse,
  HostManifest,
  CapabilityRef,
  parseCapabilityRef,
  formatCapabilityRef,
} from "../types/uapf-ip";

export class RealExecutionEngine implements IExecutionEngine {
  private readonly walker = new BpmnWalker();
  private readonly dmn = new DmnTableEvaluator();

  constructor(
    private readonly registry: IUapfRegistry,
    private readonly sessions: SessionManager,
    private readonly audit: AuditEmitter
  ) {}

  // --- Legacy synchronous surface --------------------------------------

  async executeProcessOnce(req: ExecuteProcessRequest): Promise<ExecuteProcessResult> {
    const pkg = await this.registry.getPackage(req.packageId);
    if (!pkg) throw new Error(`Unknown packageId: ${req.packageId}`);

    // Without a host manifest we can't run anything that needs capabilities.
    // For backwards compatibility we return a structured "skeleton" result
    // pointing to the new start-session endpoint.
    return {
      packageId: pkg.packageId,
      processId: req.processId,
      mode: this.registry.mode(),
      applicationId: `legacy-${Date.now()}`,
      status: "use-start-session",
      outputs: {
        message:
          "Legacy /uapf/execute-process is a no-op without a host manifest. Use POST /uapf/start-session with a hostManifest payload.",
        input: req.input,
      },
      explanations: [
        { message: "Use POST /uapf/start-session for real execution." },
      ],
      artifactRefs: pkg.artifacts,
    };
  }

  async evaluateDecision(req: EvaluateDecisionRequest): Promise<EvaluateDecisionResult> {
    const pkg = await this.registry.getPackage(req.packageId);
    if (!pkg) throw new Error(`Unknown packageId: ${req.packageId}`);

    const dmnDoc = await this.registry.getArtifact(pkg.packageId, "dmn", req.decisionId);
    if (!dmnDoc) {
      throw new Error(`DMN artifact for decision ${req.decisionId} not found`);
    }
    const xml = dmnDoc.content.toString("utf-8");
    const tables = this.dmn.parseDmnXml(xml);
    const table =
      tables.find((t) => t.decisionId === req.decisionId) ??
      tables.find((t) => t.decisionName === req.decisionId) ??
      tables[0];
    if (!table) throw new Error(`No decision table found in DMN for ${req.decisionId}`);

    const result = this.dmn.evaluate(table, (req.input ?? {}) as Record<string, unknown>);

    return {
      packageId: pkg.packageId,
      decisionId: req.decisionId,
      mode: this.registry.mode(),
      outputs: result.result as Record<string, unknown>,
      explanations: [
        { rulesFired: result.rulesFired, message: result.explanation },
      ],
      artifactRefs: pkg.artifacts,
    };
  }

  // --- New session-based surface ---------------------------------------

  async startSession(req: StartSessionRequest): Promise<StartSessionResponse> {
    const pkg = await this.registry.getPackage(req.packageId);
    if (!pkg) throw new Error(`Unknown packageId: ${req.packageId}`);

    // Resolve capability needs from package manifest
    const needs = this.extractCapabilityNeeds(pkg as unknown as Record<string, unknown>);
    const bindings = this.matchCapabilities(needs, req.hostManifest);

    // G7: resolve guardrails. The package ships them under resources/guardrails.*
    // (parsed by the loader into pkg.guardrails). guardrailsRef MAY point at them
    // via a package:// URI; if it does, it must reference THIS package's file.
    const guardrails = this.resolveGuardrails(pkg, req.guardrailsRef);
    const guardrailsHash = guardrails
      ? crypto
          .createHash("sha256")
          .update(JSON.stringify(guardrails))
          .digest("hex")
      : undefined;

    const session = this.sessions.create({
      packageId: pkg.packageId,
      packageVersion: req.packageVersion,
      processId: req.processId,
      input: req.input,
      hostManifest: req.hostManifest,
      capabilityBindings: bindings,
      guardrails,
    });

    this.audit.emit({
      sessionId: session.sessionId,
      packageId: pkg.packageId,
      packageVersion: req.packageVersion,
      type: "dev.uapf.session.created",
      data: {
        processId: req.processId,
        hostDid: req.hostManifest.hostDid,
        guardrailsApplied: !!guardrails,
        capabilityBindings: Object.fromEntries(
          Object.entries(bindings).map(([k, v]) => [k, formatCapabilityRef(v)])
        ),
      },
      guardrailsHash,
      profile: req.hostManifest.profiles?.[0],
    });

    this.sessions.setState(session.sessionId, "active");

    // Load BPMN, find process, walk it
    const bpmnDoc = await this.registry.getArtifact(pkg.packageId, "bpmn", req.processId);
    if (!bpmnDoc) {
      this.sessions.fail(session.sessionId, `BPMN artifact for process ${req.processId} not found`);
      throw new Error(`BPMN artifact for process ${req.processId} not found`);
    }
    const bpmnXml = bpmnDoc.content.toString("utf-8");
    const processes = this.walker.parseBpmnXml(bpmnXml);
    const proc =
      processes.find((p) => p.id === req.processId) ?? processes[0];
    if (!proc) {
      this.sessions.fail(session.sessionId, `No process found in BPMN for ${req.processId}`);
      throw new Error(`No process found in BPMN for ${req.processId}`);
    }

    const hostClient = new HostClient({
      hostBaseUrl: req.hostManifest.hostBaseUrl,
    });

    const handler: StepHandler = {
      onStep: async (node) => {
        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          packageVersion: req.packageVersion,
          stepId: node.id,
          type: "dev.uapf.step.entered",
          data: { nodeName: node.name, nodeType: node.type },
        });
      },

      onServiceTask: async (node: BpmnNode, vars) => {
        if (!node.capability) {
          throw new Error(`Service task ${node.id} has no uapf:capability binding`);
        }
        const cap = parseCapabilityRef(node.capability);

        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: node.id,
          type: "dev.uapf.capability.invoking",
          data: { capability: formatCapabilityRef(cap), nodeName: node.name },
        });

        const result = await hostClient.invoke({
          sessionId: session.sessionId,
          stepId: node.id,
          capability: cap,
          input: vars,
          guardrails: session.guardrails,
        });

        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: node.id,
          type: "dev.uapf.capability.invoked",
          data: { capability: formatCapabilityRef(cap), output: result.output },
        });

        // Merge capability output into variables
        if (result.output && typeof result.output === "object") {
          return result.output as Record<string, unknown>;
        }
        return { [`${cap.namespace}_${cap.operation}_result`]: result.output };
      },

      onBusinessRuleTask: async (node: BpmnNode, vars) => {
        if (!node.decision) {
          throw new Error(`Business rule task ${node.id} has no uapf:decision binding`);
        }
        const dmnDoc = await this.registry.getArtifact(pkg.packageId, "dmn", node.decision);
        if (!dmnDoc) {
          throw new Error(`DMN artifact for decision ${node.decision} not found`);
        }
        const tables = this.dmn.parseDmnXml(dmnDoc.content.toString("utf-8"));
        const table =
          tables.find((t) => t.decisionId === node.decision) ??
          tables.find((t) => t.decisionName === node.decision) ??
          tables[0];
        if (!table) throw new Error(`No decision table for ${node.decision}`);
        const result = this.dmn.evaluate(table, vars);

        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: node.id,
          type: "dev.uapf.decision.evaluated",
          data: {
            decisionId: node.decision,
            result: result.result,
            rulesFired: result.rulesFired,
          },
        });

        return (result.result ?? {}) as Record<string, unknown>;
      },
    };

    try {
      const execResult = await this.walker.execute(
        proc,
        (req.input ?? {}) as Record<string, unknown>,
        handler
      );
      this.sessions.complete(session.sessionId, execResult.variables);
      this.audit.emit({
        sessionId: session.sessionId,
        packageId: pkg.packageId,
        type: "dev.uapf.session.completed",
        data: { variables: execResult.variables, trace: execResult.trace },
      });
      return {
        sessionId: session.sessionId,
        state: "completed",
        output: execResult.variables,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sessions.fail(session.sessionId, msg);
      this.audit.emit({
        sessionId: session.sessionId,
        packageId: pkg.packageId,
        type: "dev.uapf.session.failed",
        data: { error: msg },
      });
      throw err;
    }
  }

  // --- Helpers ---------------------------------------------------------

  // G7: resolve the guardrails snapshot for a session.
  //
  // The loader parses resources/guardrails.{yaml,yml,json} into pkg.guardrails.
  // A start-session request MAY also pass guardrailsRef as a package:// URI;
  // per the UAPF-IP REST binding that URI references a file *inside the same
  // package*, so it is validated for consistency but the parsed file is the
  // source of truth. A guardrailsRef pointing at a different package is
  // rejected — a session must not run under another package's policy.
  private resolveGuardrails(
    pkg: PackageSummary,
    guardrailsRef?: string
  ): Record<string, unknown> | undefined {
    if (guardrailsRef && guardrailsRef.startsWith("package://")) {
      // package://<id>@<version>/resources/guardrails.yaml
      const body = guardrailsRef.slice("package://".length);
      const refId = body.split("/")[0].split("@")[0];
      if (refId && refId !== pkg.packageId) {
        throw new Error(
          `guardrailsRef points at package '${refId}' but the session package ` +
            `is '${pkg.packageId}'. Cross-package guardrails are not permitted.`
        );
      }
    }
    // pkg.guardrails is the parsed resources/guardrails.* file (or undefined).
    return pkg.guardrails;
  }

  private extractCapabilityNeeds(pkg: Record<string, unknown>): CapabilityRef[] {
    // Capability needs may live on the package record under different keys
    // depending on registry implementation. We accept either:
    //   pkg.requiresCapabilities = ["task.assign@1+", "ai.classify@1+"]
    //   pkg.manifest.requires_capabilities = [...]
    const candidates =
      (pkg.requiresCapabilities as string[]) ||
      ((pkg.manifest as Record<string, unknown> | undefined)?.requires_capabilities as string[]) ||
      [];
    return candidates.map((c) => parseCapabilityRef(c));
  }

  private matchCapabilities(
    needs: CapabilityRef[],
    host: HostManifest
  ): Record<string, CapabilityRef> {
    const bindings: Record<string, CapabilityRef> = {};
    for (const need of needs) {
      const key = formatCapabilityRef(need);
      const offer = host.capabilities.find(
        (c) =>
          c.namespace === need.namespace &&
          c.operation === need.operation &&
          c.version >= need.version
      );
      if (!offer) {
        throw new Error(
          `Host does not provide required capability: ${key} (host capabilities: ${host.capabilities.map((c) => formatCapabilityRef(c)).join(", ") || "none"})`
        );
      }
      bindings[key] = offer;
    }
    return bindings;
  }
}
