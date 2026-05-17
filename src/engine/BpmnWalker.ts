// Minimal BPMN walker for UAPF-IP v0.1 reference runtime.
//
// Scope:
// - startEvent -> any sequence of {serviceTask, businessRuleTask} -> endEvent
// - Linear flows only (no parallel gateways, no exclusive gateways for v0.1)
// - Service tasks use the `uapf:capability` attribute to identify the host capability
// - Business rule tasks use the `uapf:decision` attribute to identify the DMN decision
// - User tasks defer until v0.2 (require CMMN integration)
//
// What it does not do:
// - Gateways, parallel paths, event-based gateways
// - Subprocesses or call activities
// - Boundary events
// - Compensation
//
// These are deferred to v0.2 along with swapping in bpmn-engine for production.

import { XMLParser } from "fast-xml-parser";

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
  capability?: string;   // uapf:capability attribute
  decision?: string;     // uapf:decision attribute
  schemaRef?: string;    // uapf:schemaRef attribute (task I/O contract)
}

export interface BpmnFlow {
  id: string;
  source: string;
  target: string;
}

export interface BpmnProcess {
  id: string;
  name?: string;
  nodes: Map<string, BpmnNode>;
  flows: BpmnFlow[];
  outgoing: Map<string, string[]>; // node id -> outgoing flow ids
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
        });
      }
    }

    const sfs = (p.sequenceFlow as Record<string, unknown>[]) || [];
    for (const sf of sfs) {
      flows.push({
        id: (sf["@_id"] as string) || "",
        source: (sf["@_sourceRef"] as string) || "",
        target: (sf["@_targetRef"] as string) || "",
      });
    }

    const outgoing = new Map<string, string[]>();
    for (const f of flows) {
      const list = outgoing.get(f.source) || [];
      list.push(f.id);
      outgoing.set(f.source, list);
    }

    return {
      id: (p["@_id"] as string) || "",
      name: (p["@_name"] as string) || undefined,
      nodes,
      flows,
      outgoing,
    };
  }

  async execute(
    process: BpmnProcess,
    initialVars: Record<string, unknown>,
    handler: StepHandler
  ): Promise<BpmnExecutionResult> {
    // Find start event
    let current: BpmnNode | undefined;
    for (const n of process.nodes.values()) {
      if (n.type === "startEvent") {
        current = n;
        break;
      }
    }
    if (!current) {
      throw new Error(`No startEvent found in process ${process.id}`);
    }

    const variables: Record<string, unknown> = { ...initialVars };
    const trace: BpmnExecutionResult["trace"] = [];
    const guard = new Set<string>();

    while (current) {
      if (guard.has(current.id)) {
        throw new Error(`Loop detected at node ${current.id}`);
      }
      guard.add(current.id);
      trace.push({ nodeId: current.id, nodeName: current.name, type: current.type });
      if (handler.onStep) await handler.onStep(current, variables);

      switch (current.type) {
        case "startEvent":
          break;
        case "serviceTask": {
          const out = await handler.onServiceTask(current, variables);
          Object.assign(variables, out);
          break;
        }
        case "businessRuleTask": {
          const out = await handler.onBusinessRuleTask(current, variables);
          Object.assign(variables, out);
          break;
        }
        case "userTask": {
          if (!handler.onUserTask) {
            throw new Error(
              `User task ${current.id} encountered but no userTask handler configured (v0.2 deferred)`
            );
          }
          const out = await handler.onUserTask(current, variables);
          Object.assign(variables, out);
          break;
        }
        case "endEvent":
          return { variables, trace };
        default:
          throw new Error(
            `Node type ${current.type} (id=${current.id}) not supported in v0.1 walker`
          );
      }

      // Linear flow: pick first outgoing flow's target.
      const outIds = process.outgoing.get(current.id) || [];
      if (outIds.length === 0) {
        return { variables, trace };
      }
      if (outIds.length > 1) {
        throw new Error(
          `Node ${current.id} has multiple outgoing flows; gateways are v0.2`
        );
      }
      const flow = process.flows.find((f) => f.id === outIds[0]);
      if (!flow) {
        throw new Error(`Sequence flow ${outIds[0]} not found`);
      }
      current = process.nodes.get(flow.target);
      if (!current) {
        throw new Error(`Flow target ${flow.target} not found`);
      }
    }
    return { variables, trace };
  }
}
