"use strict";
// Durable session persistence tests (uapf-engine 1.1.0).
// Run after a build:  node test/sessions.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { SessionManager } = require("../dist/engine/SessionManager");

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

const hostManifest = { hostDid: "did:web:test", hostBaseUrl: "", capabilities: [] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uapf-sessions-"));

// First manager: create and complete a session.
const m1 = new SessionManager({ persistenceDir: dir });
check("persistence is active when given a writable directory", m1.isDurable() === true);

const s = m1.create({
  packageId: "pkg.x",
  processId: "p1",
  input: { a: 1 },
  hostManifest,
  capabilityBindings: {},
});
m1.complete(s.sessionId, { done: true });
check("session json is written to disk", fs.existsSync(path.join(dir, s.sessionId + ".json")));

// Second manager on the same directory simulates a process restart.
const m2 = new SessionManager({ persistenceDir: dir });
const reloaded = m2.get(s.sessionId);
check("session survives a restart (reloaded by a fresh manager)", !!reloaded);
check("reloaded session keeps its completed state", !!reloaded && reloaded.state === "completed");
check(
  "reloaded session keeps its output",
  !!reloaded && !!reloaded.output && reloaded.output.done === true
);
check(
  "reloaded session is listed",
  m2.list().some((x) => x.sessionId === s.sessionId)
);

// Unwritable directory -> degrade cleanly to in-memory.
const blocker = path.join(os.tmpdir(), "uapf-blocker-" + Date.now());
fs.writeFileSync(blocker, "x"); // a file, so <blocker>/sessions cannot be a dir
const m3 = new SessionManager({ persistenceDir: path.join(blocker, "sessions") });
check("degrades to in-memory when the directory is not usable", m3.isDurable() === false);
const s3 = m3.create({
  packageId: "pkg.y",
  processId: "p2",
  input: {},
  hostManifest,
  capabilityBindings: {},
});
check("in-memory mode still creates and tracks sessions", !!m3.get(s3.sessionId));

console.log("\n" + passed + " checks passed");
