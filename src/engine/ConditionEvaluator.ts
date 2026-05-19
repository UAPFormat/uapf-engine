// ConditionEvaluator — evaluates BPMN sequence-flow conditionExpression
// values for exclusive gateways.
//
// Grammar (deliberately minimal — compound / complex logic belongs in DMN,
// per UAPF specification 02-process-cornerstones: "DMN is used to express
// decision logic referenced by BPMN tasks and gateways"):
//
//   <var> <op> <literal>      e.g.  route == "escalate"   amount >= 1000
//   <var>                     bare boolean truthiness     e.g.  approved
//
//   ops:      ==  !=  >=  <=  >  <
//   literals: number | "string" | 'string' | true | false | null
//
// An optional ${ ... } wrapper is stripped. An empty / blank expression
// evaluates to true (an unconditional flow). Dotted variable paths
// (a.b.c) are supported.

const OP_RE = /^([A-Za-z_][\w.]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

export function evaluateCondition(
  expr: string | undefined,
  vars: Record<string, unknown>
): boolean {
  if (expr === undefined) return true;
  let e = expr.trim();
  if (e.startsWith("${") && e.endsWith("}")) {
    e = e.slice(2, -1).trim();
  }
  if (e === "") return true;

  const m = OP_RE.exec(e);
  if (!m) {
    // Bare variable reference -> truthiness.
    return isTruthy(resolve(e, vars));
  }

  const [, varName, op, rawLiteral] = m;
  const left = resolve(varName, vars);
  const right = parseLiteral(rawLiteral.trim());

  switch (op) {
    case "==":
      return looseEquals(left, right);
    case "!=":
      return !looseEquals(left, right);
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const l = Number(left);
      const r = Number(right);
      if (Number.isNaN(l) || Number.isNaN(r)) return false;
      if (op === ">") return l > r;
      if (op === ">=") return l >= r;
      if (op === "<") return l < r;
      return l <= r;
    }
    default:
      return false;
  }
}

function resolve(name: string, vars: Record<string, unknown>): unknown {
  if (!name.includes(".")) return vars[name];
  let cur: unknown = vars;
  for (const part of name.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function parseLiteral(raw: string): unknown {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const n = Number(raw);
  if (raw !== "" && !Number.isNaN(n)) return n;
  return raw; // bare word -> treat as string literal
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  if (typeof a !== "boolean" && typeof b !== "boolean") {
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an === bn;
  }
  return String(a) === String(b);
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v.toLowerCase() !== "false";
  return true;
}
