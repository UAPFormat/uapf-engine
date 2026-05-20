// v2.4.0 algorithm-card smoke test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");

const { UapfLoader } = require("../dist/registry/UapfLoader");
const { UapfValidator } = require("../dist/registry/UapfValidator");
const { BpmnWalker } = require("../dist/engine/BpmnWalker");

function buildArchive({ withGoodRef = true } = {}) {
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        id: "test.algorithm-cards-smoke",
        version: "1.0.0",
        name: "Algorithm Cards smoke test package",
        level: 4,
        algorithm_cards: true,
        processes: [{ id: "p1", bpmnProcessId: "Process_Test" }],
      }, null, 2)
    )
  );
  zip.addFile(
    "algorithms/redactor.card.yaml",
    Buffer.from([
      "kind: uapf.algorithm.card",
      "id: algo.smoke.redactor",
      "name: Smoke test redactor",
      "version: 1.0.0",
      "algorithm_kind: redactor",
      "determinism: deterministic",
      "risk:",
      "  aiActRiskClass: minimal",
      "  humanOversight: none",
      "io:",
      "  inputs:",
      "    - { id: content, type: string }",
      "  outputs:",
      "    - { id: redacted_content, type: string }",
      "implementation:",
      "  type: inline",
      "  inline:",
      '    description: "regex redact PII"',
      ""
    ].join("\n"))
  );
  const refTarget = withGoodRef ? "algo.smoke.redactor" : "algo.smoke.does_not_exist";
  zip.addFile(
    "bpmn/p1.bpmn",
    Buffer.from([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
      '    xmlns:uapfa="https://uapf.dev/bpmn/v2.4"',
      '    id="Defs" targetNamespace="https://test.local/smoke">',
      '  <bpmn:process id="Process_Test" isExecutable="true">',
      '    <bpmn:startEvent id="Start"/>',
      `    <bpmn:serviceTask id="Task_Redact" name="Redact" uapfa:algorithmCardRef="${refTarget}"/>`,
      '    <bpmn:endEvent id="End"/>',
      '    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Task_Redact"/>',
      '    <bpmn:sequenceFlow id="F2" sourceRef="Task_Redact" targetRef="End"/>',
      "  </bpmn:process>",
      "</bpmn:definitions>",
      ""
    ].join("\n"))
  );
  const tmp = path.join(os.tmpdir(), `uapf-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.uapf`);
  zip.writeZip(tmp);
  return tmp;
}

test("algorithm card is discovered, parsed, and keyed by id", async () => {
  const archivePath = buildArchive();
  // (static API)
  const pkg = await UapfLoader.loadFromFile(archivePath);
  assert.ok(pkg.algorithmCards, "package should carry algorithmCards map");
  assert.ok(pkg.algorithmCards["algo.smoke.redactor"], "card should be keyed by its declared id");
  assert.equal(pkg.algorithmCards["algo.smoke.redactor"].determinism, "deterministic");
});

test("BPMN walker reads algorithmCardRef regardless of namespace prefix", async () => {
  const archivePath = buildArchive();
  // (static API)
  const pkg = await UapfLoader.loadFromFile(archivePath);
  const bpmnArtifact = pkg.artifacts.find((a) => a.kind === "bpmn");
  const xml = fs.readFileSync(bpmnArtifact.path, "utf-8");
  const walker = new BpmnWalker();
  const procs = walker.parseBpmnXml(xml);
  assert.equal(procs.length, 1);
  const taskNode = procs[0].nodes.get("Task_Redact");
  assert.ok(taskNode);
  assert.equal(taskNode.algorithmCardRef, "algo.smoke.redactor");
});

test("SEM-012 fires when BPMN references a card id that is not loaded", async () => {
  const archivePath = buildArchive({ withGoodRef: false });
  // (static API)
  const pkg = await UapfLoader.loadFromFile(archivePath);
  const validator = new UapfValidator();
  const issues = validator.validateAlgorithmCardRefs(pkg);
  const sem012 = issues.find((i) => i.message.includes("SEM-012"));
  assert.ok(sem012, "expected a SEM-012 issue when ref does not resolve");
  assert.equal(sem012.level, "error");
});

test("SEM-012 stays quiet when every ref resolves", async () => {
  const archivePath = buildArchive({ withGoodRef: true });
  // (static API)
  const pkg = await UapfLoader.loadFromFile(archivePath);
  const validator = new UapfValidator();
  const issues = validator.validateAlgorithmCardRefs(pkg);
  const sem012 = issues.filter((i) => i.message.includes("SEM-012"));
  assert.equal(sem012.length, 0);
});
