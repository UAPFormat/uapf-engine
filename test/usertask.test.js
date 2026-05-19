"use strict";
// Functional tests for BPMN user-task dispatch (uapf-engine 1.1.0).
// Run after a build:  node test/usertask.test.js

const { BpmnWalker } = require("../dist/engine/BpmnWalker");

const walker = new BpmnWalker();
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

const WITH_USERTASK = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="ut">
  <startEvent id="s"/>
  <userTask id="approve" name="Approve payment"/>
  <serviceTask id="post" capability="ledger.post@1"/>
  <endEvent id="e"/>
  <sequenceFlow id="f1" sourceRef="s" targetRef="approve"/>
  <sequenceFlow id="f2" sourceRef="approve" targetRef="post"/>
  <sequenceFlow id="f3" sourceRef="post" targetRef="e"/>
 </process>
</definitions>`;

(async () => {
  const p = walker.parseBpmnXml(WITH_USERTASK)[0];

  // 1. user task is dispatched, its output merges, flow continues.
  const log = [];
  const r = await walker.execute(
    p,
    {},
    {
      async onServiceTask(node) {
        log.push("svc:" + node.id);
        return {};
      },
      async onBusinessRuleTask() {
        return {};
      },
      async onUserTask(node) {
        log.push("usr:" + node.id);
        return { decision: "approved" };
      },
    }
  );
  check("user task is dispatched to onUserTask", log.includes("usr:approve"));
  check("user task output merges into process variables", r.variables.decision === "approved");
  check(
    "flow continues to the service task after the user task",
    log.indexOf("svc:post") > log.indexOf("usr:approve")
  );

  // 2. a user task with no onUserTask handler raises a clear error.
  let threw = false;
  try {
    await walker.execute(
      p,
      {},
      {
        async onServiceTask() {
          return {};
        },
        async onBusinessRuleTask() {
          return {};
        },
      }
    );
  } catch (_) {
    threw = true;
  }
  check("user task with no onUserTask handler raises a clear error", threw);

  console.log("\n" + passed + " checks passed");
})();
