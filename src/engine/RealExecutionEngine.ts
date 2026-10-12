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
import { BpmnWalker, BpmnNode, BpmnProcess, StepHandler, ResumeFrom, SUSPEND_MARKER } from "./BpmnWalker";
import { DmnTableEvaluator } from "./DmnTableEvaluator";
import { HostClient } from "./HostClient";
import { SessionManager, AuditEmitter } from "./SessionManager";
import {
  StartSessionRequest,
  StartSessionResponse,
  HostManifest,
  CapabilityRef,
  SessionRecord,
  parseCapabilityRef,
  formatCapabilityRef,
} from "../types/uapf-ip";
import { resolveBinding, ResolvedBinding } from "./MappingResolver";

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

    const { proc, handler } = await this.prepareRun(session, pkg, req.processId);
    return this.drive(session, pkg, proc, handler, (req.input ?? {}) as Record<string, unknown>);
  }

  /** Continue a session that is waiting on a user task (state "suspended"). */
  async resumeSession(
    sessionId: string,
    output: Record<string, unknown>
  ): Promise<StartSessionResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.state !== "suspended" || !session.suspension) {
      throw new Error(`Session ${sessionId} is not waiting (state '${session.state}')`);
    }
    const pkg = await this.registry.getPackage(session.packageId);
    if (!pkg) throw new Error(`Unknown packageId: ${session.packageId}`);
    const susp = session.suspension;
    this.audit.emit({
      sessionId,
      packageId: pkg.packageId,
      stepId: susp.nodeId,
      type: "dev.uapf.usertask.completed",
      data: { output, resumed: true },
    });
    this.sessions.setState(sessionId, "active");
    const { proc, handler } = await this.prepareRun(session, pkg, session.processId);
    return this.drive(session, pkg, proc, handler, susp.variables, {
      nodeId: susp.nodeId,
      output: output ?? {},
      pending: susp.pending,
    });
  }

  private async prepareRun(
    session: SessionRecord,
    pkg: PackageSummary,
    processId: string
  ): Promise<{ proc: BpmnProcess; handler: StepHandler }> {
    // Load BPMN, find process, walk it
    // The process id may be the BPMN file name or the <process id> inside it.
    let processes: ReturnType<BpmnWalker["parseBpmnXml"]> = [];
    const bpmnDoc = await this.registry.getArtifact(pkg.packageId, "bpmn", processId);
    if (bpmnDoc) {
      processes = this.walker.parseBpmnXml(bpmnDoc.content.toString("utf-8"));
    } else {
      for (const a of (pkg.artifacts ?? []).filter((x) => x.kind === "bpmn")) {
        const doc = await this.registry.getArtifact(pkg.packageId, "bpmn", a.id);
        if (!doc) continue;
        const parsed = this.walker.parseBpmnXml(doc.content.toString("utf-8"));
        if (parsed.some((p) => p.id === processId)) {
          processes = parsed;
          break;
        }
      }
    }
    if (processes.length === 0) {
      this.sessions.fail(session.sessionId, `BPMN artifact for process ${processId} not found`);
      throw new Error(`BPMN artifact for process ${processId} not found`);
    }
    const proc =
      processes.find((p) => p.id === processId) ?? processes[0];
    if (!proc) {
      this.sessions.fail(session.sessionId, `No process found in BPMN for ${processId}`);
      throw new Error(`No process found in BPMN for ${processId}`);
    }

    const mappings = (pkg as { mappings?: unknown }).mappings;
    // A BPMN attribute already names the capability: the mapping then only
    // adds context (target, mode), so an ambiguous target is not an error.
    const bindingFor = (taskId: string, needCapability = true): ResolvedBinding | undefined =>
      resolveBinding(mappings, taskId, { needCapability });
    const bindingAudit = (b: ResolvedBinding | undefined, fromAttribute: boolean) =>
      fromAttribute
        ? { boundBy: "bpmn-attribute" }
        : b
          ? { boundBy: "resources/mappings", targetId: b.targetId, targetType: b.targetType, mode: b.mode }
          : {};

    const hostClient = new HostClient({
      hostBaseUrl: session.hostManifest.hostBaseUrl,
    });

    const handler: StepHandler = {
      onStep: async (node) => {
        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          packageVersion: session.packageVersion,
          stepId: node.id,
          type: "dev.uapf.step.entered",
          data: { nodeName: node.name, nodeType: node.type },
        });
      },

      onServiceTask: async (node: BpmnNode, vars) => {
        const binding = bindingFor(node.id, !node.capability);
        const capRef = node.capability ?? binding?.capability;
        if (!capRef) {
          throw new Error(
            `Service task ${node.id} has no binding (no uapf:capability attribute and no entry in resources/mappings.yaml)`
          );
        }
        const cap = parseCapabilityRef(capRef);

        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: node.id,
          type: "dev.uapf.capability.invoking",
          data: {
            capability: formatCapabilityRef(cap),
            nodeName: node.name,
            ...bindingAudit(binding, !!node.capability),
          },
        });

        const result = await hostClient.invoke({
          sessionId: session.sessionId,
          stepId: node.id,
          capability: cap,
          input: vars,
          guardrails: session.guardrails,
          schemaRef: node.schemaRef ?? binding?.schemaRef,
          target: binding ? { id: binding.targetId, type: binding.targetType, name: binding.targetName } : undefined,
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
        // The decision id may be the DMN file name or the <decision id> inside it.
        let tables: ReturnType<typeof this.dmn.parseDmnXml> = [];
        const dmnDoc = await this.registry.getArtifact(pkg.packageId, "dmn", node.decision);
        if (dmnDoc) {
          tables = this.dmn.parseDmnXml(dmnDoc.content.toString("utf-8"));
        } else {
          for (const a of (pkg.artifacts ?? []).filter((x) => x.kind === "dmn")) {
            const doc = await this.registry.getArtifact(pkg.packageId, "dmn", a.id);
            if (!doc) continue;
            const parsed = this.dmn.parseDmnXml(doc.content.toString("utf-8"));
            if (parsed.some((t) => t.decisionId === node.decision)) {
              tables = parsed;
              break;
            }
          }
        }
        if (tables.length === 0) {
          throw new Error(`DMN artifact for decision ${node.decision} not found`);
        }
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

        // COLLECT returns a list of rows; expose it as lists per output column
        // ({ element: ["a", "b"] }) so the next steps can read it by name.
        if (Array.isArray(result.result)) {
          const rows = result.result as Array<Record<string, unknown>>;
          const cols: Record<string, unknown[]> = {};
          for (const row of rows) {
            for (const [k, v] of Object.entries(row ?? {})) (cols[k] ??= []).push(v);
          }
          return Object.keys(cols).length ? cols : { [node.decision as string]: [] };
        }
        return (result.result ?? {}) as Record<string, unknown>;
      },

      onUserTask: async (node: BpmnNode, vars) => {
        // A user task is dispatched to the host's task.* capability. The
        // host owns the human-interaction lifecycle (queue, claim, complete)
        // and returns the human's decision; UAPF-IP reserves the `task`
        // namespace for exactly this (Orchestrated Process profile). The
        // node MAY name an explicit capability via uapf:capability; if it
        // does not, task.request@1 is the default.
        const binding = bindingFor(node.id, false);
        const capRef =
          node.capability ??
          (binding?.capability?.startsWith("task.") ? binding.capability : undefined);
        const cap: CapabilityRef = capRef
          ? parseCapabilityRef(capRef)
          : { namespace: "task", operation: "request", version: 1 };

        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: node.id,
          type: "dev.uapf.usertask.dispatched",
          data: {
            capability: formatCapabilityRef(cap),
            nodeName: node.name,
            ...bindingAudit(binding, !!node.capability),
          },
        });

        const result = await hostClient.invoke({
          sessionId: session.sessionId,
          stepId: node.id,
          capability: cap,
          input: vars,
          guardrails: session.guardrails,
          schemaRef: node.schemaRef ?? binding?.schemaRef,
          target: binding ? { id: binding.targetId, type: binding.targetType, name: binding.targetName } : undefined,
        });

        // The host may accept the task and answer later: { status: "pending" }.
        // The session is then suspended and continued via resumeSession().
        const out = result.output as Record<string, unknown> | undefined;
        if (out && typeof out === "object" && out.status === "pending") {
          this.audit.emit({
            sessionId: session.sessionId,
            packageId: pkg.packageId,
            stepId: node.id,
            type: "dev.uapf.usertask.waiting",
            data: { capability: formatCapabilityRef(cap), output: out },
          });
          const { status: _status, ...rest } = out;
          return { ...rest, [SUSPEND_MARKER]: true };
        }

        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: node.id,
          type: "dev.uapf.usertask.completed",
          data: { capability: formatCapabilityRef(cap), output: result.output },
        });

        if (result.output && typeof result.output === "object") {
          return result.output as Record<string, unknown>;
        }
        return { [`${cap.namespace}_${cap.operation}_result`]: result.output };
      },
    };

    return { proc, handler };
  }

  private async drive(
    session: SessionRecord,
    pkg: PackageSummary,
    proc: BpmnProcess,
    handler: StepHandler,
    vars: Record<string, unknown>,
    resume?: ResumeFrom
  ): Promise<StartSessionResponse> {
    try {
      const execResult = await this.walker.execute(proc, vars, handler, resume);
      if (execResult.suspended) {
        this.sessions.suspend(session.sessionId, {
          nodeId: execResult.suspended.nodeId,
          pending: execResult.suspended.pending,
          variables: execResult.variables,
        });
        this.audit.emit({
          sessionId: session.sessionId,
          packageId: pkg.packageId,
          stepId: execResult.suspended.nodeId,
          type: "dev.uapf.session.suspended",
          data: { waitingFor: execResult.suspended.nodeId, trace: execResult.trace },
        });
        return {
          sessionId: session.sessionId,
          state: "suspended",
          output: execResult.variables,
          waitingFor: execResult.suspended.nodeId,
        };
      }
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
