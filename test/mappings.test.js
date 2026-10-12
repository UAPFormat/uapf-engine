"use strict";
// Bindings from resources/mappings.yaml + <uapf:decisionRef> (no BPMN attributes).
// Run after a build:  node test/mappings.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const AdmZip = require("adm-zip");
const { UapfLoader } = require("../dist/registry/UapfLoader");
const { RealExecutionEngine } = require("../dist/engine/RealExecutionEngine");
const { SessionManager, AuditEmitter } = require("../dist/engine/SessionManager");
const { resolveBinding, toEngineCapability } = require("../dist/engine/MappingResolver");
const { evaluateCondition } = require("../dist/engine/ConditionEvaluator");

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

const UAPF_YAML = `kind: uapf.package
id: test.mapped
version: 0.1.0
requires_capabilities: [document.fetch@1+, data.write@1+]
`;

const BPMN = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <process id="mapped_process" isExecutable="true">
  <startEvent id="Start"/>
  <serviceTask id="Fetch"/>
  <businessRuleTask id="Route">
   <extensionElements><uapf:decisionRef xmlns:uapf="https://uapf.dev/ns/1.0" ref="RouteIt"/></extensionElements>
  </businessRuleTask>
  <serviceTask id="Record"/>
  <userTask id="Review"/>
  <exclusiveGateway id="G"/>
  <endEvent id="EndOk"/>
  <endEvent id="EndNo"/>
  <sequenceFlow id="f1" sourceRef="Start" targetRef="Fetch"/>
  <sequenceFlow id="f2" sourceRef="Fetch" targetRef="Route"/>
  <sequenceFlow id="f3" sourceRef="Route" targetRef="Record"/>
  <sequenceFlow id="f4" sourceRef="Record" targetRef="Review"/>
  <sequenceFlow id="f5" sourceRef="Review" targetRef="G"/>
  <sequenceFlow id="f6" sourceRef="G" targetRef="EndOk">
   <conditionExpression xsi:type="tFormalExpression">\${decision == 'apstiprinats' || decision == 'labots'}</conditionExpression>
  </sequenceFlow>
  <sequenceFlow id="f7" sourceRef="G" targetRef="EndNo">
   <conditionExpression xsi:type="tFormalExpression">\${decision == 'noraidits'}</conditionExpression>
  </sequenceFlow>
 </process>
</definitions>`;

const DMN = (privateRule) => `<?xml version="1.0"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="d" name="d" namespace="x">
 <decision id="RouteIt" name="Route">
  <decisionTable hitPolicy="FIRST">
   <input id="i1"><inputExpression typeRef="string"><text>respondentType</text></inputExpression></input>
   <input id="i2"><inputExpression typeRef="string"><text>topic</text></inputExpression></input>
   <output id="o1" name="jurisdiction" typeRef="string"/>
   <rule id="r1"><inputEntry><text>"privatpersona"</text></inputEntry><inputEntry><text>${privateRule}</text></inputEntry><outputEntry><text>"nav-piekritigs"</text></outputEntry></rule>
   <rule id="r2"><inputEntry><text>-</text></inputEntry><inputEntry><text>-</text></inputEntry><outputEntry><text>"piekritigs"</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;

const MAPPINGS = `kind: uapf.resources.mapping
targets:
  - id: system.dms
    type: system_api
    capabilities: [capability.document.fetch, capability.data.write]
  - id: engine.dmn
    type: decision_engine
  - id: role.lawyer
    type: human_role
bindings:
  - source: { type: bpmn.serviceTask, ref: Fetch }
    targetId: system.dms
    capability: capability.document.fetch
    mode: autonomous
  - source: { type: bpmn.businessRuleTask, ref: Route }
    targetId: engine.dmn
    mode: autonomous
  - source: { type: bpmn.serviceTask, ref: Record }
    targetId: system.dms
    capability: capability.data.write
    mode: autonomous
  - source: { type: bpmn.userTask, ref: Review }
    targetId: role.lawyer
    mode: human-required
`;

function buildZip(dir, dmnRule) {
  const zip = new AdmZip();
  zip.addFile("uapf.yaml", Buffer.from(UAPF_YAML));
  zip.addFile("bpmn/mapped-process.bpmn", Buffer.from(BPMN));
  zip.addFile("dmn/route-it.dmn", Buffer.from(DMN(dmnRule)));
  zip.addFile("resources/mappings.yaml", Buffer.from(MAPPINGS));
  const p = path.join(dir, `pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.uapf`);
  zip.writeZip(p);
  return p;
}

function registryFor(loaded) {
  return {
    mode: () => "packages",
    async getPackage(id) {
      if (id !== loaded.packageId) return null;
      return { packageId: loaded.packageId, artifacts: loaded.artifacts, mappings: loaded.mappings, guardrails: loaded.guardrails };
    },
    async getArtifact(id, kind, artifactId) {
      const a = loaded.artifacts.find((x) => x.kind === kind && (!artifactId || x.id === artifactId));
      if (!a) return null;
      return { mediaType: "application/xml", content: fs.readFileSync(a.path) };
    },
  };
}

(async () => {
  // Unit: resolver
  check("capability.document.fetch -> document.fetch@1", toEngineCapability("capability.document.fetch") === "document.fetch@1");
  check("document.fetch@1+ -> document.fetch@1", toEngineCapability("document.fetch@1+") === "document.fetch@1");
  let ambiguous = "";
  try {
    resolveBinding(
      { targets: [{ id: "t", capabilities: ["capability.a.b", "capability.c.d"] }], bindings: [{ source: { ref: "X" }, targetId: "t" }] },
      "X"
    );
  } catch (e) {
    ambiguous = e.message;
  }
  check("a target with several capabilities needs an explicit capability", /add "capability:"/.test(ambiguous));
  check(
    "an ambiguous target is fine when the BPMN attribute names the capability",
    resolveBinding(
      { targets: [{ id: "t", capabilities: ["capability.a.b", "capability.c.d"] }], bindings: [{ source: { ref: "X" }, targetId: "t" }] },
      "X", { needCapability: false }
    ).targetId === "t"
  );
  check(
    "a target with one capability resolves without naming it",
    resolveBinding({ targets: [{ id: "t", capabilities: ["capability.event.emit"] }], bindings: [{ source: { ref: "E" }, targetId: "t" }] }, "E").capability === "event.emit@1"
  );
  check("|| in a gateway condition", evaluateCondition("${decision == 'apstiprinats' || decision == 'labots'}", { decision: "labots" }) === true);
  check("&& in a gateway condition", evaluateCondition("a == 1 && b == 2", { a: 1, b: 3 }) === false);

  // End to end against a fake host
  const calls = [];
  const hostState = { pending: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.startsWith("/uapf/host/capability/")) calls.push(req.url);
      const op = req.url.split("/").slice(-2).join(".");
      const out =
        op === "document.fetch" ? { respondentType: "privatpersona", topic: "sadzive" }
        : op === "task.request" ? (hostState.pending ? { status: "pending", reviewTaskId: 7 } : { decision: "labots" })
        : { recorded: true };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: out }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hostBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const hostManifest = { hostDid: "did:web:test", hostBaseUrl, capabilities: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uapf-mappings-"));

  async function run(rule) {
    const loaded = await UapfLoader.loadFromFile(buildZip(dir, rule));
    const sessions = new SessionManager();
    const engine = new RealExecutionEngine(registryFor(loaded), sessions, new AuditEmitter(sessions));
    const out = await engine.startSession({ packageId: "test.mapped", processId: "mapped_process", input: {}, hostManifest });
    return { loaded, out, sessions };
  }

  calls.length = 0;
  const a = await run(`not("bernu-tiesibas","diskriminacija")`);
  check("loader reads resources/mappings.yaml", a.loaded.mappings && a.loaded.mappings.kind === "uapf.resources.mapping");
  check("session completes with mapped bindings only", a.out.state === "completed");
  check(
    "service tasks call the capabilities named in mappings.yaml",
    calls[0] === "/uapf/host/capability/document/fetch" && calls[1] === "/uapf/host/capability/data/write"
  );
  check("human-required task goes to task.request", calls[2] === "/uapf/host/capability/task/request");
  check("decisionRef resolves to the DMN decision (not() matched)", a.out.output.jurisdiction === "nav-piekritigs");

  // Change the rule in the "repository" -> different outcome.
  const b = await run(`"sadzive"`);
  check("changing the DMN changes the outcome", b.out.output.jurisdiction === "nav-piekritigs");
  const c = await run(`"cits"`);
  check("a non-matching rule falls through to the next one", c.out.output.jurisdiction === "piekritigs");

  // Human step answered later: suspend, then resume.
  hostState.pending = true;
  const loadedS = await UapfLoader.loadFromFile(buildZip(dir, `"x"`));
  const sessS = new SessionManager({ persistenceDir: dir + "/sess" });
  const engS = new RealExecutionEngine(registryFor(loadedS), sessS, new AuditEmitter(sessS));
  const s1 = await engS.startSession({ packageId: "test.mapped", processId: "mapped_process", input: {}, hostManifest });
  check("pending user task suspends the session", s1.state === "suspended" && s1.waitingFor === "Review");
  check("suspended session keeps the variables so far", s1.output.jurisdiction === "piekritigs" && s1.output.reviewTaskId === 7);
  const s2 = await engS.resumeSession(s1.sessionId, { decision: "noraidits" });
  check("resume continues from the user task", s2.state === "completed");
  const rec = sessS.get(s1.sessionId);
  check("resume follows the gateway with the human's decision", rec.auditChain.some((e) => e.uapfstepid === "EndNo"));
  let notWaiting = false;
  try { await engS.resumeSession(s1.sessionId, {}); } catch (_) { notWaiting = true; }
  check("a finished session cannot be resumed", notWaiting);
  hostState.pending = false;

  await new Promise((r) => setTimeout(r, 200)); // let audit deliveries finish
  server.close();
  console.log(`\nmappings: ${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
