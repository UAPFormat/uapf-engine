// Minimal DMN decision-table evaluator.
//
// Scope (v0.1):
// - Decision tables only (no boxed expressions, no literal expressions, no DRDs)
// - Hit policies: UNIQUE, FIRST, PRIORITY
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
  hitPolicy: "UNIQUE" | "FIRST" | "PRIORITY" | "ANY";
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
        inputEntries: ((r.inputEntry as Record<string, unknown>[]) || []).map((e) => ({
          text: (e.text as string) ?? "",
        })),
        outputEntries: ((r.outputEntry as Record<string, unknown>[]) || []).map((e) => ({
          text: (e.text as string) ?? "",
        })),
      })
    );

    return {
      decisionId: (d["@_id"] as string) || "",
      decisionName: (d["@_name"] as string) || "",
      hitPolicy:
        ((table["@_hitPolicy"] as string)?.toUpperCase() as DmnDecisionTable["hitPolicy"]) ||
        "UNIQUE",
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
      case "PRIORITY":
      case "ANY":
        // PRIORITY would need rule ordering; v0.1 treats as FIRST
        firedRules = [matchingRules[0]];
        break;
      default:
        firedRules = matchingRules;
    }

    const result: Record<string, unknown> = {};
    for (let i = 0; i < table.outputs.length; i++) {
      const out = table.outputs[i];
      const key = out.name || out.label || out.id;
      result[key] = this.parseOutput(firedRules[0].outputEntries[i].text, out.typeRef);
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
}
