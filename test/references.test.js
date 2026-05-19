"use strict";
// Tests for L0-L4 cross-package reference resolution (uapf-engine 1.1.0).
// Run after a build:  node test/references.test.js

const {
  ReferenceResolver,
  extractReferences,
  parsePackageRef,
} = require("../dist/registry/ReferenceResolver");

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

// A small workspace: an L0 index -> L2 group -> L4 executable.
const base = {
  "vk.index": { packageId: "vk.index", level: 0, references: ["package://vk.fg3@1.0.0"] },
  "vk.fg3": { packageId: "vk.fg3", level: 2, references: ["vk.fg3.post@1.0.0"] },
  "vk.fg3.post": { packageId: "vk.fg3.post", level: 4, references: [] },
};
const resolver = (pkgs) => new ReferenceResolver((id) => pkgs[id]);

// 1. A clean L0 -> L2 -> L4 chain resolves end to end.
let r = resolver(base).resolve("vk.index");
check("clean L0->L2->L4 chain resolves with no errors", r.ok === true);
check(
  "resolved tree descends index -> fg3 -> fg3.post",
  r.tree.packageId === "vk.index" &&
    r.tree.children[0].packageId === "vk.fg3" &&
    r.tree.children[0].children[0].packageId === "vk.fg3.post"
);
check(
  "all three packages reported as resolved",
  ["vk.index", "vk.fg3", "vk.fg3.post"].every((id) =>
    r.resolvedPackageIds.includes(id)
  )
);

// 2. A missing referenced package is reported as an error.
const missing = JSON.parse(JSON.stringify(base));
missing["vk.index"].references.push("vk.ghost@1.0.0");
r = resolver(missing).resolve("vk.index");
check("missing referenced package fails resolution", r.ok === false);
check(
  "missing reference is named in diagnostics",
  r.diagnostics.some((d) => d.level === "error" && d.message.includes("vk.ghost"))
);

// 3. Referencing UP the hierarchy (lower level number) is an error.
const upward = {
  bad: { packageId: "bad", level: 3, references: ["vk.index"] },
  "vk.index": { packageId: "vk.index", level: 0, references: [] },
};
r = resolver(upward).resolve("bad");
check("referencing up the L0-L4 hierarchy is rejected", r.ok === false);
check(
  "upward-reference error explains the direction rule",
  r.diagnostics.some((d) => d.level === "error" && /not up/.test(d.message))
);

// 4. A same-level reference is allowed but warned.
const sameLevel = {
  s1: { packageId: "s1", level: 2, references: ["s2"] },
  s2: { packageId: "s2", level: 2, references: [] },
};
r = resolver(sameLevel).resolve("s1");
check("same-level reference still resolves (ok)", r.ok === true);
check(
  "same-level reference produces a warning",
  r.diagnostics.some((d) => d.level === "warn")
);

// 5. A reference cycle is detected.
const cycle = {
  "cyc.a": { packageId: "cyc.a", level: 1, references: ["cyc.b"] },
  "cyc.b": { packageId: "cyc.b", level: 2, references: ["cyc.a"] },
};
r = resolver(cycle).resolve("cyc.a");
check("reference cycle is detected and fails resolution", r.ok === false);
check(
  "cycle diagnostic names the cycle",
  r.diagnostics.some((d) => d.level === "error" && d.message.includes("cycle"))
);

// 6. parsePackageRef / extractReferences parse the supported forms.
const p = parsePackageRef("package://x.y@1.2.3");
check(
  "parsePackageRef handles package:// URIs",
  !!p && p.packageId === "x.y" && p.version === "1.2.3"
);
const refs = extractReferences({ references: ["a@1", "b", { packageId: "c", version: "2" }] });
check(
  "extractReferences reads strings and objects from a manifest",
  refs.length === 3 && refs[2].packageId === "c" && refs[2].version === "2"
);

console.log("\n" + passed + " checks passed");
