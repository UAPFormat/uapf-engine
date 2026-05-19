"use strict";
// Functional tests for the CMMN case executor (uapf-engine 1.1.0).
// Run after a build:  node test/cmmn.test.js

const { CmmnEngine } = require("../dist/engine/CmmnEngine");

const eng = new CmmnEngine();
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

const NS = 'xmlns="http://www.omg.org/spec/CMMN/20151109/MODEL"';

// Case 1: humanTask A -> milestone M (entry criterion: A completes).
const CASE1 = `<?xml version="1.0"?>
<definitions ${NS}>
 <case id="c1" name="Case 1">
  <casePlanModel id="cpm1">
   <planItem id="pi_A" definitionRef="taskA"/>
   <planItem id="pi_M" definitionRef="ms1">
    <entryCriterion id="ec1" sentryRef="s1"/>
   </planItem>
   <sentry id="s1">
    <planItemOnPart sourceRef="pi_A"><standardEvent>complete</standardEvent></planItemOnPart>
   </sentry>
   <humanTask id="taskA" name="Task A"/>
   <milestone id="ms1" name="Done"/>
  </casePlanModel>
 </case>
</definitions>`;

// Case 2: task B gated by A.complete AND ifPart (approved == true).
const CASE2 = `<?xml version="1.0"?>
<definitions ${NS}>
 <case id="c2">
  <casePlanModel id="cpm2">
   <planItem id="pi_A" definitionRef="taskA"/>
   <planItem id="pi_B" definitionRef="taskB">
    <entryCriterion sentryRef="s2"/>
   </planItem>
   <sentry id="s2">
    <planItemOnPart sourceRef="pi_A"><standardEvent>complete</standardEvent></planItemOnPart>
    <ifPart><condition><body>approved == true</body></condition></ifPart>
   </sentry>
   <humanTask id="taskA" name="A"/>
   <humanTask id="taskB" name="B"/>
  </casePlanModel>
 </case>
</definitions>`;

// Case 3: a stage containing one task; the stage completes with its child.
const CASE3 = `<?xml version="1.0"?>
<definitions ${NS}>
 <case id="c3">
  <casePlanModel id="cpm3">
   <planItem id="pi_S" definitionRef="stage1"/>
   <stage id="stage1" name="Stage 1">
    <planItem id="pi_inner" definitionRef="innerTask"/>
    <humanTask id="innerTask" name="Inner"/>
   </stage>
  </casePlanModel>
 </case>
</definitions>`;

// Case 4: task C is declared BEFORE task A but depends on A completing.
const CASE4 = `<?xml version="1.0"?>
<definitions ${NS}>
 <case id="c4">
  <casePlanModel id="cpm4">
   <planItem id="pi_C" definitionRef="taskC">
    <entryCriterion sentryRef="s4"/>
   </planItem>
   <planItem id="pi_A" definitionRef="taskA"/>
   <sentry id="s4">
    <planItemOnPart sourceRef="pi_A"><standardEvent>complete</standardEvent></planItemOnPart>
   </sentry>
   <humanTask id="taskA" name="A"/>
   <task id="taskC" name="C"/>
  </casePlanModel>
 </case>
</definitions>`;

(async () => {
  // --- Case 1 -------------------------------------------------------------
  let cd = eng.parseCmmnXml(CASE1)[0];
  check("CMMN parses casePlanModel plan items", cd.items.length === 2);
  let calledA = false;
  let r = await eng.execute(cd, {}, {
    onHumanTask: () => {
      calledA = true;
      return { aDone: true };
    },
  });
  check("human task handler is invoked", calledA === true);
  check("human task handler output merges into context", r.context.aDone === true);
  check("task A reaches completed state", r.states.pi_A === "completed");
  check("milestone fires after its entry criterion is met", r.states.pi_M === "completed");
  check("milestone emits an 'occur' transition", r.transitions.includes("pi_M:occur"));
  check("case 1 completes", r.caseCompleted === true);

  // --- Case 2: ifPart satisfied ------------------------------------------
  cd = eng.parseCmmnXml(CASE2)[0];
  r = await eng.execute(cd, { approved: true }, { onHumanTask: () => ({}) });
  check("task gated by a satisfied ifPart activates", r.states.pi_B === "completed");
  check("case 2 completes when the ifPart holds", r.caseCompleted === true);

  // --- Case 2: ifPart not satisfied --------------------------------------
  cd = eng.parseCmmnXml(CASE2)[0];
  r = await eng.execute(cd, { approved: false }, { onHumanTask: () => ({}) });
  check("task gated by a failing ifPart stays available", r.states.pi_B === "available");
  check("case 2 does not complete when the ifPart fails", r.caseCompleted === false);

  // --- Case 3: nested stage ----------------------------------------------
  cd = eng.parseCmmnXml(CASE3)[0];
  r = await eng.execute(cd, {}, { onHumanTask: () => ({}) });
  check("nested stage child task completes", r.states.pi_inner === "completed");
  check("stage completes once its child completes", r.states.pi_S === "completed");
  check("case 3 (with a nested stage) completes", r.caseCompleted === true);

  // --- Case 4: out-of-document-order dependency --------------------------
  cd = eng.parseCmmnXml(CASE4)[0];
  r = await eng.execute(cd, {}, { onHumanTask: () => ({}), onTask: () => ({}) });
  check(
    "dependency declared before its source still resolves",
    r.states.pi_C === "completed" && r.states.pi_A === "completed"
  );
  check("case 4 completes", r.caseCompleted === true);

  console.log("\n" + passed + " checks passed");
})();
