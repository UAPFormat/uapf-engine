// BPMN walker for the UAPF-IP reference runtime.
//
// Scope (uapf-engine 1.1.0):
// - startEvent -> tasks / gateways -> endEvent
// - Exclusive gateways: condition-routed branching, with a default flow
// - Parallel gateways: fork (emit all outgoing) + join (wait for all incoming)
// - Service tasks use the `uapf:capability` attribute (host capability id)
// - Business rule tasks use the `uapf:decision` attribute (DMN decision id)
// - User tasks are dispatched to an optional `onUserTask` handler
// - Abstract `task` nodes are pass-through (no execution semantics)
//
// Execution model: token-based worklist. Tokens are processed one at a time
// (no real concurrency) so variable updates stay deterministic; parallel
// fork/join SEMANTICS are honoured via join-arrival counting. Loops are
// permitted and bounded by a step budget.
//
// Not yet supported (deferred): subprocesses / call activities, boundary
// events, event-based gateways, compensation.

import { XMLParser } from "fast-xml-parser";
import { evaluateCondition } from "./ConditionEvaluator";

export type BpmnNodeType =
  | "startEvent"
  | "endEvent"
  | "serviceTask"
  | "businessRuleTask"
  | "userTask"
  | "task"
  | "exclusiveGateway"
  | "parallelGateway";

export interface BpmnNode {
  id: string;
  name?: string;
  type: BpmnNodeType;
  capability?: string; // uapf:capability attribute
  decision?: string; // uapf:decision attribute
  schemaRef?: string; // uapf:schemaRef attribute (task I/O contract)
  default?: string; // gateway default sequence-flow id
}

export interface BpmnFlow {
  id: string;
  source: string;
  target: string;
  condition?: string; // <conditionExpression> body, if present
}

export interface BpmnProcess {
  id: string;
  name?: string;
  nodes: Map<string, BpmnNode>;
  flows: BpmnFlow[];
  outgoing: Map<string, string[]>; // node id -> outgoing flow ids
  incoming: Map<string, string[]>; // node id -> incoming flow ids
}

export interface StepHandler {
  onServiceTask(node: BpmnNode, vars: Record<string, unknown>): Promise<Record<string, unknown>>;
  onBusinessRuleTask(node: BpmnNode, vars: Record<string, unknown>): Promise<Record<string, unknown>>;
  onUserTask?(node: BpmnNode, vars: Record<string, unknown>): Promise<Record<string, unknown>>;
  onStep?(node: BpmnNode, vars: Record<string, unknown>): Promise<void>;
}

export interface BpmnExecutionResult {
  variables: Record<string, unknown>;
  trace: Array<{ nodeId: string; nodeName?: string; type: BpmnNodeType }>;
}

const MAX_STEPS = 10_000;

function extractText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    if (t !== undefined) return String(t);
  }
  return undefined;
}

export class BpmnWalker {
  parseBpmnXml(xml: string): BpmnProcess[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      preserveOrder: false,
      isArray: (name) =>
        [
          "process",
          "startEvent",
          "endEvent",
          "serviceTask",
          "businessRuleTask",
          "userTask",
          "task",
          "exclusiveGateway",
          "parallelGateway",
          "sequenceFlow",
        ].includes(name),
    });
    const doc = parser.parse(xml);
    const definitions = doc.definitions || doc.Definitions;
    if (!definitions) {
      throw new Error("Invalid BPMN: no <definitions> element");
    }
    const processes = definitions.process || [];
    return processes.map((p: Record<string, unknown>) => this.parseProcess(p));
  }

  private parseProcess(p: Record<string, unknown>): BpmnProcess {
    const nodes = new Map<string, BpmnNode>();
    const flows: BpmnFlow[] = [];

    const nodeTypes: Array<[string, BpmnNodeType]> = [
      ["startEvent", "startEvent"],
      ["endEvent", "endEvent"],
      ["serviceTask", "serviceTask"],
      ["businessRuleTask", "businessRuleTask"],
      ["userTask", "userTask"],
      ["task", "task"],
      ["exclusiveGateway", "exclusiveGateway"],
      ["parallelGateway", "parallelGateway"],
    ];

    for (const [key, type] of nodeTypes) {
      const items = (p[key] as Record<string, unknown>[]) || [];
      for (const it of items) {
        const id = (it["@_id"] as string) || "";
        if (!id) continue;
        nodes.set(id, {
          id,
          name: (it["@_name"] as string) || undefined,
          type,
          capability: (it["@_capability"] as string) || undefined,
          decision: (it["@_decision"] as string) || undefined,
          schemaRef: (it["@_schemaRef"] as string) || undefined,
          default: (it["@_default"] as string) || undefined,
        });
      }
    }

    const sfs = (p.sequenceFlow as Record<string, unknown>[]) || [];
    for (const sf of sfs) {
      flows.push({
        id: (sf["@_id"] as string) || "",
        source: (sf["@_sourceRef"] as string) || "",
        target: (sf["@_targetRef"] as string) || "",
        condition: extractText(sf["conditionExpression"]),
      });
    }

    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const f of flows) {
      const o = outgoing.get(f.source) || [];
      o.push(f.id);
      outgoing.set(f.source, o);
      const i = incoming.get(f.target) || [];
      i.push(f.id);
      incoming.set(f.target, i);
    }

    return {
      id: (p["@_id"] as string) || "",
      name: (p["@_name"] as string) || undefined,
      nodes,
      flows,
      outgoing,
      incoming,
    };
  }

  async execute(
    process: BpmnProcess,
    initialVars: Record<string, unknown>,
    handler: StepHandler
  ): Promise<BpmnExecutionResult> {
    let start: BpmnNode | undefined;
    for (const n of process.nodes.values()) {
      if (n.type === "startEvent") {
        start = n;
        break;
      }
    }
    if (!start) {
      throw new Error(`No startEvent found in process ${process.id}`);
    }

    const variables: Record<string, unknown> = { ...initialVars };
    const trace: BpmnExecutionResult["trace"] = [];

    // Token worklist. Each token is a node awaiting processing. Processed
    // one at a time; parallel fork/join semantics via join-arrival counts.
    const worklist: BpmnNode[] = [start];
    const joinArrivals = new Map<string, number>();
    let steps = 0;

    while (worklist.length > 0) {
      if (++steps > MAX_STEPS) {
        throw new Error(
          `Execution step budget (${MAX_STEPS}) exceeded in process ${process.id} — runaway loop?`
        );
      }
      const current = worklist.shift() as BpmnNode;
      trace.push({ nodeId: current.id, nodeName: current.name, type: current.type });
      if (handler.onStep) await handler.onStep(current, variables);

      let next: BpmnNode[];
      switch (current.type) {
        case "startEvent":
          next = this.followSingle(process, current);
          break;
        case "serviceTask": {
          Object.assign(variables, await handler.onServiceTask(current, variables));
          next = this.followSingle(process, current);
          break;
        }
        case "businessRuleTask": {
          Object.assign(variables, await handler.onBusinessRuleTask(current, variables));
          next = this.followSingle(process, current);
          break;
        }
        case "userTask": {
          if (!handler.onUserTask) {
            throw new Error(
              `User task ${current.id} encountered but no userTask handler configured`
            );
          }
          Object.assign(variables, await handler.onUserTask(current, variables));
          next = this.followSingle(process, current);
          break;
        }
        case "task":
          // Abstract task: no execution semantics, pass the token through.
          next = this.followSingle(process, current);
          break;
        case "exclusiveGateway":
          next = this.followExclusive(process, current, variables);
          break;
        case "parallelGateway":
          next = this.followParallel(process, current, joinArrivals);
          break;
        case "endEvent":
          // Token consumed; the process ends once all tokens are gone.
          next = [];
          break;
        default:
          throw new Error(
            `Node type ${current.type} (id=${current.id}) not supported`
          );
      }
      worklist.push(...next);
    }
    return { variables, trace };
  }

  // A non-gateway node: exactly one outgoing flow (zero = branch ends).
  private followSingle(process: BpmnProcess, node: BpmnNode): BpmnNode[] {
    const outIds = process.outgoing.get(node.id) || [];
    if (outIds.length === 0) return [];
    if (outIds.length > 1) {
      throw new Error(
        `Node ${node.id} has ${outIds.length} outgoing flows; only gateways may branch — insert an exclusive or parallel gateway`
      );
    }
    return [this.targetOf(process, outIds[0])];
  }

  // Exclusive gateway: take the first non-default flow whose condition is
  // true, else the default flow. A converging gateway (<=1 outgoing) passes
  // the token straight through.
  private followExclusive(
    process: BpmnProcess,
    node: BpmnNode,
    vars: Record<string, unknown>
  ): BpmnNode[] {
    const outIds = process.outgoing.get(node.id) || [];
    if (outIds.length === 0) return [];
    if (outIds.length === 1) return [this.targetOf(process, outIds[0])];

    const flows = outIds
      .map((id) => process.flows.find((f) => f.id === id))
      .filter((f): f is BpmnFlow => !!f);

    for (const f of flows) {
      if (f.id === node.default) continue;
      if (evaluateCondition(f.condition, vars)) {
        return [this.nodeOf(process, f.target)];
      }
    }
    if (node.default) {
      const def = flows.find((f) => f.id === node.default);
      if (def) return [this.nodeOf(process, def.target)];
    }
    throw new Error(
      `Exclusive gateway ${node.id}: no outgoing condition matched and no default flow is set`
    );
  }

  // Parallel gateway: join (wait until every incoming flow has delivered a
  // token) then fork (emit a token on every outgoing flow). Handles pure
  // fork (1 in), pure join (1 out) and combined gateways uniformly.
  private followParallel(
    process: BpmnProcess,
    node: BpmnNode,
    joinArrivals: Map<string, number>
  ): BpmnNode[] {
    const inCount = (process.incoming.get(node.id) || []).length;
    if (inCount > 1) {
      const seen = (joinArrivals.get(node.id) || 0) + 1;
      if (seen < inCount) {
        joinArrivals.set(node.id, seen);
        return []; // token waits at the join
      }
      joinArrivals.set(node.id, 0); // all branches in; reset for re-entry
    }
    const outIds = process.outgoing.get(node.id) || [];
    return outIds.map((id) => this.targetOf(process, id));
  }

  private targetOf(process: BpmnProcess, flowId: string): BpmnNode {
    const flow = process.flows.find((f) => f.id === flowId);
    if (!flow) throw new Error(`Sequence flow ${flowId} not found`);
    return this.nodeOf(process, flow.target);
  }

  private nodeOf(process: BpmnProcess, nodeId: string): BpmnNode {
    const n = process.nodes.get(nodeId);
    if (!n) throw new Error(`Flow target ${nodeId} not found`);
    return n;
  }
}
