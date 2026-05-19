"use strict";
// Functional tests for BPMN gateway execution (uapf-engine 1.1.0).
// Run after a build:  npm run build && node test/gateways.test.js

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

function handler(log) {
  return {
    async onServiceTask(node) {
      log.push("svc:" + node.id);
      return {};
    },
    async onBusinessRuleTask(node) {
      log.push("brt:" + node.id);
      return {};
    },
    async onUserTask(node) {
      log.push("usr:" + node.id);
      return {};
    },
  };
}

const LINEAR = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="lin">
  <startEvent id="s"/>
  <serviceTask id="a" capability="x"/>
  <endEvent id="e"/>
  <sequenceFlow id="f1" sourceRef="s" targetRef="a"/>
  <sequenceFlow id="f2" sourceRef="a" targetRef="e"/>
 </process>
</definitions>`;

const EXCLUSIVE = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="ex">
  <startEvent id="s"/>
  <exclusiveGateway id="g" default="fElse"/>
  <serviceTask id="hi" capability="x"/>
  <serviceTask id="lo" capability="x"/>
  <endEvent id="e1"/>
  <endEvent id="e2"/>
  <sequenceFlow id="f0" sourceRef="s" targetRef="g"/>
  <sequenceFlow id="fHi" sourceRef="g" targetRef="hi">
    <conditionExpression>amount &gt;= 1000</conditionExpression>
  </sequenceFlow>
  <sequenceFlow id="fElse" sourceRef="g" targetRef="lo"/>
  <sequenceFlow id="f3" sourceRef="hi" targetRef="e1"/>
  <sequenceFlow id="f4" sourceRef="lo" targetRef="e2"/>
 </process>
</definitions>`;

const STRING_EQ = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="eq">
  <startEvent id="s"/>
  <exclusiveGateway id="g" default="fB"/>
  <serviceTask id="A" capability="x"/>
  <serviceTask id="B" capability="x"/>
  <endEvent id="e1"/><endEvent id="e2"/>
  <sequenceFlow id="f0" sourceRef="s" targetRef="g"/>
  <sequenceFlow id="fA" sourceRef="g" targetRef="A">
    <conditionExpression>route == "escalate"</conditionExpression>
  </sequenceFlow>
  <sequenceFlow id="fB" sourceRef="g" targetRef="B"/>
  <sequenceFlow id="x1" sourceRef="A" targetRef="e1"/>
  <sequenceFlow id="x2" sourceRef="B" targetRef="e2"/>
 </process>
</definitions>`;

const PARALLEL = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="par">
  <startEvent id="s"/>
  <parallelGateway id="fork"/>
  <serviceTask id="A" capability="x"/>
  <serviceTask id="B" capability="x"/>
  <parallelGateway id="join"/>
  <serviceTask id="C" capability="x"/>
  <endEvent id="e"/>
  <sequenceFlow id="f0" sourceRef="s" targetRef="fork"/>
  <sequenceFlow id="fa" sourceRef="fork" targetRef="A"/>
  <sequenceFlow id="fb" sourceRef="fork" targetRef="B"/>
  <sequenceFlow id="ja" sourceRef="A" targetRef="join"/>
  <sequenceFlow id="jb" sourceRef="B" targetRef="join"/>
  <sequenceFlow id="fc" sourceRef="join" targetRef="C"/>
  <sequenceFlow id="fe" sourceRef="C" targetRef="e"/>
 </process>
</definitions>`;

const BAD_MULTI_OUT = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
 <process id="bad">
  <startEvent id="s"/>
  <serviceTask id="a" capability="x"/>
  <endEvent id="e1"/><endEvent id="e2"/>
  <sequenceFlow id="f0" sourceRef="s" targetRef="a"/>
  <sequenceFlow id="f1" sourceRef="a" targetRef="e1"/>
  <sequenceFlow id="f2" sourceRef="a" targetRef="e2"/>
 </process>
</definitions>`;

(async () => {
  // 1. Linear flow still works (backward-compatibility guard).
  let p = walker.parseBpmnXml(LINEAR)[0];
  let log = [];
  let r = await walker.execute(p, {}, handler(log));
  check("linear flow executes the service task", log.join(",") === "svc:a");
  check(
    "linear flow trace ends at endEvent",
    r.trace[r.trace.length - 1].type === "endEvent"
  );

  // 2. Exclusive gateway: numeric condition true -> high branch.
  p = walker.parseBpmnXml(EXCLUSIVE)[0];
  log = [];
  await walker.execute(p, { amount: 5000 }, handler(log));
  check("exclusive gateway: condition true -> high branch", log.join(",") === "svc:hi");

  // 3. Exclusive gateway: condition false -> default branch.
  log = [];
  await walker.execute(p, { amount: 10 }, handler(log));
  check("exclusive gateway: condition false -> default branch", log.join(",") === "svc:lo");

  // 4. Exclusive gateway: string equality.
  p = walker.parseBpmnXml(STRING_EQ)[0];
  log = [];
  await walker.execute(p, { route: "escalate" }, handler(log));
  check("exclusive gateway: string equality match -> A", log.join(",") === "svc:A");
  log = [];
  await walker.execute(p, { route: "auto" }, handler(log));
  check("exclusive gateway: string equality miss -> default B", log.join(",") === "svc:B");

  // 5. Parallel gateway: fork runs both branches, join waits for both.
  p = walker.parseBpmnXml(PARALLEL)[0];
  log = [];
  await walker.execute(p, {}, handler(log));
  check(
    "parallel gateway: both fork branches execute",
    log.includes("svc:A") && log.includes("svc:B")
  );
  check(
    "parallel gateway: join waits, C runs exactly once after both",
    log.filter((x) => x === "svc:C").length === 1 &&
      log.indexOf("svc:C") > log.indexOf("svc:A") &&
      log.indexOf("svc:C") > log.indexOf("svc:B")
  );

  // 6. A non-gateway node with >1 outgoing flow is rejected.
  p = walker.parseBpmnXml(BAD_MULTI_OUT)[0];
  let threw = false;
  try {
    await walker.execute(p, {}, handler([]));
  } catch (_) {
    threw = true;
  }
  check("non-gateway node with multiple outgoing flows is rejected", threw);

  console.log("\n" + passed + " checks passed");
})();
