// CmmnEngine — a minimal CMMN 1.1 case executor for the UAPF runtime.
//
// CMMN models case management: a case plan made of stages, tasks and
// milestones whose activation is gated by sentries (entry criteria). UAPF
// already stores CMMN as an artifact kind; this engine gives those
// artifacts a real, if deliberately bounded, execution.
//
// COVERED (the subset UAPF process packages realistically use):
//   - casePlanModel with nested stages
//   - humanTask / processTask / caseTask / generic task
//   - milestones
//   - entry criteria (sentries) with planItemOnPart triggers and an
//     optional ifPart condition (evaluated via ConditionEvaluator)
//   - completion propagation: a stage/case completes when all of its plan
//     items have completed; task `complete` and milestone `occur`
//     transitions feed downstream sentries
//
// NOT COVERED (documented; out of scope for v1.1):
//   - the full CMMN plan-item lifecycle (enabled/disabled/suspended/
//     failed/terminated, manual activation)
//   - exit criteria / preemptive stage termination
//   - repetition, manualActivation and required rules
//   - event listeners (timer/user), case file items, discretionary items
//     and planning tables
//
// The executor is synchronous: a task completes as soon as it activates
// (its handler runs inline), so the case runs to quiescence in one call.

import { XMLParser } from "fast-xml-parser";
import { evaluateCondition } from "./ConditionEvaluator";

export type CmmnItemKind =
  | "humanTask"
  | "processTask"
  | "caseTask"
  | "task"
  | "stage"
  | "milestone";

export type CmmnItemState = "available" | "active" | "completed";

export interface CmmnOnPart {
  sourceRef: string;
  standardEvent: string;
}

export interface CmmnSentry {
  id: string;
  onParts: CmmnOnPart[];
  ifPart?: string;
}

export interface CmmnPlanItem {
  id: string;
  name?: string;
  kind: CmmnItemKind;
  definitionRef: string;
  entrySentries: CmmnSentry[];
  children: CmmnPlanItem[]; // populated for stages
}

export interface CmmnCase {
  id: string;
  name?: string;
  items: CmmnPlanItem[]; // top-level plan items of the casePlanModel
}

type HandlerReturn =
  | Promise<Record<string, unknown> | void>
  | Record<string, unknown>
  | void;

export interface CmmnHandlers {
  onHumanTask?: (
    item: CmmnPlanItem,
    context: Record<string, unknown>
  ) => HandlerReturn;
  onTask?: (
    item: CmmnPlanItem,
    context: Record<string, unknown>
  ) => HandlerReturn;
  onMilestone?: (item: CmmnPlanItem, context: Record<string, unknown>) => void;
  onTransition?: (
    itemId: string,
    event: string,
    state: CmmnItemState
  ) => void;
}

export interface CmmnExecutionResult {
  caseId: string;
  caseCompleted: boolean;
  states: Record<string, CmmnItemState>;
  transitions: string[]; // "<itemId>:<event>" in order of occurrence
  context: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class CmmnEngine {
  parseCmmnXml(xml: string): CmmnCase[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      preserveOrder: false,
      isArray: (name) =>
        [
          "case",
          "planItem",
          "sentry",
          "entryCriterion",
          "exitCriterion",
          "planItemOnPart",
          "humanTask",
          "processTask",
          "caseTask",
          "task",
          "stage",
          "milestone",
        ].includes(name),
    });
    const doc = parser.parse(xml);
    const definitions = doc.definitions || doc.Definitions;
    if (!definitions) {
      throw new Error("Invalid CMMN: no <definitions> element");
    }
    const cases = definitions.case || [];
    return cases.map((c: any) => this.parseCase(c));
  }

  private parseCase(c: any): CmmnCase {
    const cpm = c.casePlanModel || {};
    return {
      id: c["@_id"] || "",
      name: c["@_name"],
      items: this.parseStageItems(cpm),
    };
  }

  // Parse the plan items contained directly in a stage / casePlanModel,
  // recursing into nested stages.
  private parseStageItems(stageNode: any): CmmnPlanItem[] {
    const sentries = this.parseSentries(stageNode.sentry);
    const defs = this.indexDefinitions(stageNode);
    const planItems: any[] = stageNode.planItem || [];
    const out: CmmnPlanItem[] = [];
    for (const pi of planItems) {
      const defRef = pi["@_definitionRef"] || "";
      const def = defs[defRef];
      const kind = this.kindOf(def?.__kind);
      const item: CmmnPlanItem = {
        id: pi["@_id"] || "",
        name: pi["@_name"] || def?.["@_name"],
        kind,
        definitionRef: defRef,
        entrySentries: this.collectEntrySentries(pi, sentries),
        children: [],
      };
      if (kind === "stage" && def) {
        item.children = this.parseStageItems(def);
      }
      out.push(item);
    }
    return out;
  }

  private indexDefinitions(node: any): Record<string, any> {
    const idx: Record<string, any> = {};
    const add = (arr: any[] | undefined, kind: string) => {
      (arr || []).forEach((d) => {
        if (d && d["@_id"]) idx[d["@_id"]] = { ...d, __kind: kind };
      });
    };
    add(node.humanTask, "humanTask");
    add(node.processTask, "processTask");
    add(node.caseTask, "caseTask");
    add(node.task, "task");
    add(node.stage, "stage");
    add(node.milestone, "milestone");
    return idx;
  }

  private kindOf(k?: string): CmmnItemKind {
    switch (k) {
      case "humanTask":
        return "humanTask";
      case "processTask":
        return "processTask";
      case "caseTask":
        return "caseTask";
      case "stage":
        return "stage";
      case "milestone":
        return "milestone";
      default:
        return "task";
    }
  }

  private parseSentries(arr: any[] | undefined): Record<string, CmmnSentry> {
    const map: Record<string, CmmnSentry> = {};
    for (const s of arr || []) {
      const id = s["@_id"] || "";
      const onParts: CmmnOnPart[] = ((s.planItemOnPart as any[]) || []).map(
        (op) => ({
          sourceRef: op["@_sourceRef"] || "",
          standardEvent: this.textOf(op.standardEvent) || "complete",
        })
      );
      map[id] = { id, onParts, ifPart: this.parseIfPart(s.ifPart) };
    }
    return map;
  }

  private collectEntrySentries(
    pi: any,
    sentries: Record<string, CmmnSentry>
  ): CmmnSentry[] {
    const out: CmmnSentry[] = [];
    for (const c of (pi.entryCriterion as any[]) || []) {
      const ref = c["@_sentryRef"];
      if (ref && sentries[ref]) out.push(sentries[ref]);
    }
    return out;
  }

  private parseIfPart(ifPart: any): string | undefined {
    if (!ifPart) return undefined;
    const cond = ifPart.condition ?? ifPart;
    if (cond == null) return undefined;
    if (typeof cond === "string") return cond.trim() || undefined;
    const body = this.textOf(cond.body) ?? this.textOf(cond);
    return body ? body.trim() : undefined;
  }

  private textOf(v: any): string | undefined {
    if (v == null) return undefined;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "object" && "#text" in v) {
      return String((v as any)["#text"]);
    }
    return undefined;
  }

  async execute(
    caseDef: CmmnCase,
    input: Record<string, unknown> = {},
    handlers: CmmnHandlers = {}
  ): Promise<CmmnExecutionResult> {
    const context: Record<string, unknown> = { ...input };
    const states = new Map<string, CmmnItemState>();
    const transitions: string[] = [];
    const transitionSet = new Set<string>();

    // Flatten plan items, recording each one's parent stage id ("" = root).
    const flat: Array<{ item: CmmnPlanItem; parentId: string }> = [];
    const indexItems = (items: CmmnPlanItem[], parentId: string) => {
      for (const it of items) {
        flat.push({ item: it, parentId });
        states.set(it.id, "available");
        if (it.children.length) indexItems(it.children, it.id);
      }
    };
    indexItems(caseDef.items, "");

    const emit = (itemId: string, event: string) => {
      const key = `${itemId}:${event}`;
      if (!transitionSet.has(key)) {
        transitionSet.add(key);
        transitions.push(key);
      }
    };

    const sentrySatisfied = (s: CmmnSentry): boolean => {
      for (const op of s.onParts) {
        if (!transitionSet.has(`${op.sourceRef}:${op.standardEvent}`)) {
          return false;
        }
      }
      if (s.ifPart && !evaluateCondition(s.ifPart, context)) return false;
      return true;
    };

    const canActivate = (it: CmmnPlanItem): boolean =>
      it.entrySentries.length === 0 ||
      it.entrySentries.some((s) => sentrySatisfied(s));

    // States only move forward (available -> active -> completed), so the
    // quiescence loop converges; the cap is a defensive guard.
    const maxPasses = flat.length * 2 + 5;
    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;

      // 1. Activate eligible plan items.
      for (const { item, parentId } of flat) {
        if (states.get(item.id) !== "available") continue;
        if (parentId && states.get(parentId) !== "active") continue;
        if (!canActivate(item)) continue;

        states.set(item.id, "active");
        changed = true;
        handlers.onTransition?.(item.id, "start", "active");

        if (item.kind === "milestone") {
          states.set(item.id, "completed");
          emit(item.id, "occur");
          handlers.onMilestone?.(item, context);
          handlers.onTransition?.(item.id, "occur", "completed");
        } else if (item.kind === "stage") {
          // Stays active; completion is handled in step 2.
        } else {
          const handler =
            item.kind === "humanTask" ? handlers.onHumanTask : handlers.onTask;
          if (handler) {
            const ret = await handler(item, context);
            if (ret && typeof ret === "object") Object.assign(context, ret);
          }
          states.set(item.id, "completed");
          emit(item.id, "complete");
          handlers.onTransition?.(item.id, "complete", "completed");
        }
      }

      // 2. Complete stages whose plan items have all completed.
      for (const { item } of flat) {
        if (item.kind !== "stage") continue;
        if (states.get(item.id) !== "active") continue;
        const allDone =
          item.children.length === 0 ||
          item.children.every((c) => states.get(c.id) === "completed");
        if (allDone) {
          states.set(item.id, "completed");
          emit(item.id, "complete");
          changed = true;
          handlers.onTransition?.(item.id, "complete", "completed");
        }
      }

      if (!changed) break;
    }

    const caseCompleted = caseDef.items.every(
      (it) => states.get(it.id) === "completed"
    );

    return {
      caseId: caseDef.id,
      caseCompleted,
      states: Object.fromEntries(states),
      transitions,
      context,
    };
  }
}
