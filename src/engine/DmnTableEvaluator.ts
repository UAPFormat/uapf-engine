// Minimal DMN decision-table evaluator.
//
// Scope (uapf-engine 1.1.0):
// - Decision tables only (no boxed expressions, no literal expressions, no DRDs)
// - Hit policies: UNIQUE, FIRST, PRIORITY, ANY, COLLECT
//     PRIORITY uses an explicit `priority` attribute on <rule> (lowest number
//       wins); rules without one keep document order.
//     ANY requires every matching rule to yield identical output.
//     COLLECT returns the list of all matching rule outputs, or — when the
//       table declares `aggregation` (SUM | MIN | MAX | COUNT) on a single
//       output — the aggregated scalar.
// - Input expressions: strings ("foo"), numbers (15), booleans (true), dash (-) for any
// - Comparison operators in input entries: ==, !=, >, >=, <, <=
// - FEEL intervals [a..b] (a..b) [a..b) etc.; comma-separated value lists
// - Output expressions: literals only
//
// What it does NOT do:
// - Full FEEL expression evaluation (no list operators, no function calls, no temporal types)
// - Decision dependencies (one decision invoking another)
// - DMN imports
//
// For production, swap this for a full FEEL evaluator (feelin) wrapped in the same interface.

import { XMLParser } from "fast-xml-parser";

export interface DmnInputEntry {
  text: string;
}

export interface DmnOutputEntry {
  text: string;
}

export interface DmnRule {
  id: string;
  inputEntries: DmnInputEntry[];
  outputEntries: DmnOutputEntry[];
  priority?: number; // for PRIORITY hit policy
}

export interface DmnInput {
  id: string;
  label: string;
  expression: string; // variable name to look up in context
  typeRef: string;
}

export interface DmnOutput {
  id: string;
  label: string;
  name?: string;
  typeRef: string;
}

export interface DmnDecisionTable {
  decisionId: string;
  decisionName: string;
  hitPolicy: "UNIQUE" | "FIRST" | "PRIORITY" | "ANY" | "COLLECT";
  aggregation?: "SUM" | "MIN" | "MAX" | "COUNT"; // COLLECT aggregation
  inputs: DmnInput[];
  outputs: DmnOutput[];
  rules: DmnRule[];
}

export interface DmnEvaluationResult {
  decisionId: string;
  result: unknown;
  rulesFired: string[];
  explanation: string;
}

export class DmnTableEvaluator {
  parseDmnXml(xml: string): DmnDecisionTable[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      preserveOrder: false,
      isArray: (name) =>
        ["decision", "input", "output", "rule", "inputEntry", "outputEntry"].includes(name),
    });
    const doc = parser.parse(xml);
    const definitions = doc.definitions || doc.Definitions;
    if (!definitions) {
      throw new Error("Invalid DMN: no <definitions> element");
    }
    const decisions = definitions.decision || [];
    return decisions
      .map((d: Record<string, unknown>) => this.parseDecision(d))
      .filter(Boolean) as DmnDecisionTable[];
  }

  private parseDecision(d: Record<string, unknown>): DmnDecisionTable | null {
    const table = (d.decisionTable as Record<string, unknown>) || null;
    if (!table) return null;

    const inputs: DmnInput[] = ((table.input as Record<string, unknown>[]) || []).map(
      (i) => ({
        id: (i["@_id"] as string) || "",
        label: (i["@_label"] as string) || "",
        expression: ((i.inputExpression as Record<string, unknown>)?.text as string) || "",
        typeRef:
          ((i.inputExpression as Record<string, unknown>)?.["@_typeRef"] as string) ||
          "string",
      })
    );

    const outputs: DmnOutput[] = ((table.output as Record<string, unknown>[]) || []).map(
      (o) => ({
        id: (o["@_id"] as string) || "",
        label: (o["@_label"] as string) || "",
        name: (o["@_name"] as string) || undefined,
        typeRef: (o["@_typeRef"] as string) || "string",
      })
    );

    const rules: DmnRule[] = ((table.rule as Record<string, unknown>[]) || []).map(
      (r) => ({
        id: (r["@_id"] as string) || "",
        priority:
          r["@_priority"] !== undefined ? Number(r["@_priority"]) : undefined,
        inputEntries: ((r.inputEntry as Record<string, unknown>[]) || []).map((e) => ({
          text: (e.text as string) ?? "",
        })),
        outputEntries: ((r.outputEntry as Record<string, unknown>[]) || []).map((e) => ({
          text: (e.text as string) ?? "",
        })),
      })
    );

    const aggRaw = (table["@_aggregation"] as string)?.toUpperCase();
    const aggregation = (["SUM", "MIN", "MAX", "COUNT"].includes(aggRaw || "")
      ? aggRaw
      : undefined) as DmnDecisionTable["aggregation"];

    return {
      decisionId: (d["@_id"] as string) || "",
      decisionName: (d["@_name"] as string) || "",
      hitPolicy:
        ((table["@_hitPolicy"] as string)?.toUpperCase() as DmnDecisionTable["hitPolicy"]) ||
        "UNIQUE",
      aggregation,
      inputs,
      outputs,
      rules,
    };
  }

  evaluate(
    table: DmnDecisionTable,
    context: Record<string, unknown>
  ): DmnEvaluationResult {
    const matchingRules: DmnRule[] = [];

    for (const rule of table.rules) {
      let matches = true;
      for (let i = 0; i < table.inputs.length; i++) {
        const input = table.inputs[i];
        const entry = rule.inputEntries[i];
        const inputValue = this.lookup(context, input.expression);
        if (!this.matchEntry(entry.text, inputValue, input.typeRef)) {
          matches = false;
          break;
        }
      }
      if (matches) matchingRules.push(rule);
    }

    if (matchingRules.length === 0) {
      return {
        decisionId: table.decisionId,
        result: null,
        rulesFired: [],
        explanation: "No rules matched",
      };
    }

    let firedRules: DmnRule[];
    switch (table.hitPolicy) {
      case "UNIQUE":
        if (matchingRules.length > 1) {
          throw new Error(
            `UNIQUE hit policy violated: ${matchingRules.length} rules matched in ${table.decisionId}`
          );
        }
        firedRules = matchingRules;
        break;
      case "FIRST":
        firedRules = [matchingRules[0]];
        break;
      case "PRIORITY": {
        // Lowest `priority` attribute wins; rules without an explicit
        // priority keep document order (PRIORITY degrades to FIRST when no
        // priorities are declared). Array.sort is stable in modern V8.
        const sorted = [...matchingRules].sort(
          (a, b) =>
            (a.priority ?? Number.MAX_SAFE_INTEGER) -
            (b.priority ?? Number.MAX_SAFE_INTEGER)
        );
        firedRules = [sorted[0]];
        break;
      }
      case "ANY": {
        // Every matching rule MUST produce identical output.
        const outs = matchingRules.map((r) =>
          JSON.stringify(this.ruleOutput(table, r))
        );
        if (new Set(outs).size > 1) {
          throw new Error(
            `ANY hit policy violated: rules matched with differing outputs in ${table.decisionId}`
          );
        }
        firedRules = [matchingRules[0]];
        break;
      }
      case "COLLECT":
        firedRules = matchingRules;
        break;
      default:
        firedRules = [matchingRules[0]];
    }

    let result: unknown;
    if (table.hitPolicy === "COLLECT") {
      const rows = firedRules.map((r) => this.ruleOutput(table, r));
      if (table.aggregation && table.outputs.length === 1) {
        const key = this.outputKey(table.outputs[0]);
        const nums = rows.map((row) => Number(row[key]));
        result = this.aggregate(table.aggregation, nums);
      } else {
        result = rows;
      }
    } else {
      result = this.ruleOutput(table, firedRules[0]);
    }

    return {
      decisionId: table.decisionId,
      result,
      rulesFired: firedRules.map((r) => r.id),
      explanation: `Hit policy ${table.hitPolicy}; rules fired: ${firedRules.map((r) => r.id).join(",")}`,
    };
  }

  private lookup(context: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let cur: unknown = context;
    for (const part of parts) {
      if (cur && typeof cur === "object") {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  private matchEntry(entry: unknown, value: unknown, typeRef: string): boolean {
    const trimmed = String(entry).trim();
    if (trimmed === "-" || trimmed === "") return true; // wildcard

    // FEEL interval / range: [a..b], (a..b), [a..b), ]a..b[ etc.
    // '[' is an inclusive endpoint; '(' and ']' (outward-facing) are exclusive.
    const rangeMatch = trimmed.match(
      /^([[\](])\s*(.+?)\s*\.\.\s*(.+?)\s*([[\])])$/
    );
    if (rangeMatch) {
      const lo = Number(this.parseLiteral(rangeMatch[2]));
      const hi = Number(this.parseLiteral(rangeMatch[3]));
      const v = Number(value);
      if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(v)) return false;
      const loOk = rangeMatch[1] === "[" ? v >= lo : v > lo;
      const hiOk = rangeMatch[4] === "]" ? v <= hi : v < hi;
      return loOk && hiOk;
    }

    // Comma-separated list of literals/intervals: match if value matches any.
    if (trimmed.includes(",")) {
      const parts: string[] = [];
      let depth = 0;
      let buf = "";
      for (const ch of trimmed) {
        if (ch === "[" || ch === "(") depth++;
        else if (ch === "]" || ch === ")") depth--;
        if (ch === "," && depth <= 0) {
          parts.push(buf);
          buf = "";
        } else {
          buf += ch;
        }
      }
      parts.push(buf);
      if (parts.length > 1) {
        return parts.some((p) => this.matchEntry(p, value, typeRef));
      }
    }

    // Numeric comparisons: >, >=, <, <=
    const cmpMatch = trimmed.match(/^(<=|>=|<|>|!=|==)\s*(.+)$/);
    if (cmpMatch) {
      const op = cmpMatch[1];
      const rhs = this.parseLiteral(cmpMatch[2].trim());
      return this.compare(value, op, rhs);
    }

    // Literal equality
    const literal = this.parseLiteral(trimmed);
    if (typeof literal === "number" && typeof value === "string") {
      return Number(value) === literal;
    }
    return value === literal;
  }

  private compare(left: unknown, op: string, right: unknown): boolean {
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    const l = Number(left);
    const r = Number(right);
    if (Number.isNaN(l) || Number.isNaN(r)) return false;
    switch (op) {
      case ">":
        return l > r;
      case ">=":
        return l >= r;
      case "<":
        return l < r;
      case "<=":
        return l <= r;
    }
    return false;
  }

  private parseLiteral(text: unknown): unknown {
    const t = String(text).trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    if (/^"[^"]*"$/.test(t)) return t.slice(1, -1);
    if (/^'[^']*'$/.test(t)) return t.slice(1, -1);
    return t; // bare identifier; treat as string
  }

  private parseOutput(text: unknown, typeRef: string): unknown {
    const literal = this.parseLiteral(text);
    if (typeRef === "number" && typeof literal === "string") {
      return parseFloat(literal);
    }
    return literal;
  }

  private outputKey(o: DmnOutput): string {
    return o.name || o.label || o.id;
  }

  private ruleOutput(
    table: DmnDecisionTable,
    rule: DmnRule
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < table.outputs.length; i++) {
      const o = table.outputs[i];
      const entry = rule.outputEntries[i];
      out[this.outputKey(o)] = this.parseOutput(entry ? entry.text : "", o.typeRef);
    }
    return out;
  }

  private aggregate(
    agg: NonNullable<DmnDecisionTable["aggregation"]>,
    nums: number[]
  ): number {
    const valid = nums.filter((n) => !Number.isNaN(n));
    if (agg === "COUNT") return nums.length;
    if (agg === "SUM") return valid.reduce((s, n) => s + n, 0);
    if (agg === "MIN") return valid.length ? Math.min(...valid) : 0;
    if (agg === "MAX") return valid.length ? Math.max(...valid) : 0;
    return 0;
  }
}
