"use strict";
// Functional tests for DMN hit policies (uapf-engine 1.1.0).
// Run after a build:  node test/dmn.test.js

const { DmnTableEvaluator } = require("../dist/engine/DmnTableEvaluator");

const ev = new DmnTableEvaluator();
let passed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log("  ok    " + name);
  } else {
    console.error("  FAIL  " + name);
    process.exitCode = 1;
  }
}

const NS = 'xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"';

const COLLECT = `<?xml version="1.0"?>
<definitions ${NS}>
 <decision id="d" name="d">
  <decisionTable hitPolicy="COLLECT">
   <input id="i1"><inputExpression typeRef="string"><text>flag</text></inputExpression></input>
   <output id="o1" name="code" typeRef="string"/>
   <rule id="r1"><inputEntry><text>"on"</text></inputEntry><outputEntry><text>"X"</text></outputEntry></rule>
   <rule id="r2"><inputEntry><text>-</text></inputEntry><outputEntry><text>"Y"</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;

const COLLECT_SUM = `<?xml version="1.0"?>
<definitions ${NS}>
 <decision id="d" name="d">
  <decisionTable hitPolicy="COLLECT" aggregation="SUM">
   <input id="i1"><inputExpression typeRef="string"><text>cat</text></inputExpression></input>
   <output id="o1" name="amount" typeRef="number"/>
   <rule id="r1"><inputEntry><text>"a"</text></inputEntry><outputEntry><text>10</text></outputEntry></rule>
   <rule id="r2"><inputEntry><text>-</text></inputEntry><outputEntry><text>5</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;

const PRIORITY = `<?xml version="1.0"?>
<definitions ${NS}>
 <decision id="d" name="d">
  <decisionTable hitPolicy="PRIORITY">
   <input id="i1"><inputExpression typeRef="number"><text>x</text></inputExpression></input>
   <output id="o1" name="label" typeRef="string"/>
   <rule id="rLow" priority="2"><inputEntry><text>-</text></inputEntry><outputEntry><text>"low"</text></outputEntry></rule>
   <rule id="rHigh" priority="1"><inputEntry><text>&gt; 0</text></inputEntry><outputEntry><text>"high"</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;

const ANY_OK = `<?xml version="1.0"?>
<definitions ${NS}>
 <decision id="d" name="d">
  <decisionTable hitPolicy="ANY">
   <input id="i1"><inputExpression typeRef="string"><text>k</text></inputExpression></input>
   <output id="o1" name="v" typeRef="string"/>
   <rule id="r1"><inputEntry><text>"k1"</text></inputEntry><outputEntry><text>"same"</text></outputEntry></rule>
   <rule id="r2"><inputEntry><text>-</text></inputEntry><outputEntry><text>"same"</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;

const ANY_BAD = ANY_OK.replace('<text>"same"</text></outputEntry></rule>\n   <rule id="r2">', '<text>"same"</text></outputEntry></rule>\n   <rule id="r2X">')
  .replace('<rule id="r2X"><inputEntry><text>-</text></inputEntry><outputEntry><text>"same"</text>',
           '<rule id="r2X"><inputEntry><text>-</text></inputEntry><outputEntry><text>"different"</text>');

const UNIQUE_BAD = `<?xml version="1.0"?>
<definitions ${NS}>
 <decision id="d" name="d">
  <decisionTable hitPolicy="UNIQUE">
   <input id="i1"><inputExpression typeRef="string"><text>k</text></inputExpression></input>
   <output id="o1" name="v" typeRef="string"/>
   <rule id="r1"><inputEntry><text>"k1"</text></inputEntry><outputEntry><text>"a"</text></outputEntry></rule>
   <rule id="r2"><inputEntry><text>-</text></inputEntry><outputEntry><text>"b"</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;

const FIRST = UNIQUE_BAD.replace('hitPolicy="UNIQUE"', 'hitPolicy="FIRST"');

// 1. COLLECT returns every matching rule output as a list.
let t = ev.parseDmnXml(COLLECT)[0];
let r = ev.evaluate(t, { flag: "on" });
check(
  "COLLECT returns array of all matching rule outputs",
  Array.isArray(r.result) &&
    r.result.length === 2 &&
    r.result[0].code === "X" &&
    r.result[1].code === "Y"
);
check("COLLECT fires all matching rules", r.rulesFired.join(",") === "r1,r2");

// 2. COLLECT + SUM aggregates a single numeric output.
t = ev.parseDmnXml(COLLECT_SUM)[0];
r = ev.evaluate(t, { cat: "a" });
check("COLLECT+SUM aggregates a single numeric output to a scalar", r.result === 15);

// 3. PRIORITY picks the lowest priority-number rule, not the first in document order.
t = ev.parseDmnXml(PRIORITY)[0];
r = ev.evaluate(t, { x: 5 });
check(
  "PRIORITY picks lowest priority-number rule, not document-first",
  r.result && r.result.label === "high" && r.rulesFired.join(",") === "rHigh"
);

// 4. ANY returns the common output when matching rules agree.
t = ev.parseDmnXml(ANY_OK)[0];
r = ev.evaluate(t, { k: "k1" });
check("ANY returns the common output when matching rules agree", r.result && r.result.v === "same");

// 5. ANY throws when matching rules disagree.
let threw = false;
try {
  ev.evaluate(ev.parseDmnXml(ANY_BAD)[0], { k: "k1" });
} catch (_) {
  threw = true;
}
check("ANY throws when matching rules produce different outputs", threw);

// 6. UNIQUE still throws on multiple matches (regression guard).
threw = false;
try {
  ev.evaluate(ev.parseDmnXml(UNIQUE_BAD)[0], { k: "k1" });
} catch (_) {
  threw = true;
}
check("UNIQUE still throws when multiple rules match", threw);

// 7. FIRST still returns the first matching rule (regression guard).
t = ev.parseDmnXml(FIRST)[0];
r = ev.evaluate(t, { k: "k1" });
check("FIRST still returns the first matching rule", r.result && r.result.v === "a");

console.log("\n" + passed + " checks passed");
