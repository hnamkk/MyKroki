import assert from "node:assert/strict";
import test from "node:test";

import { comparePilotOutputs } from "./pilot-output-verifier.mjs";

test("reports exact pilot outputs as reproducible", () => {
  const report = comparePilotOutputs([
    { path: "generated/example.svg", expected: Buffer.from("<svg/>\n"), actual: Buffer.from("<svg/>\n") },
  ]);

  assert.equal(report.status, "passed");
  assert.equal(report.files[0].status, "match");
  assert.equal(report.files[0].expectedSha256, report.files[0].actualSha256);
});

test("reports drift, missing, and unexpected pilot outputs", () => {
  const report = comparePilotOutputs([
    { path: "generated/drift.svg", expected: Buffer.from("old"), actual: Buffer.from("new") },
    { path: "generated/missing.svg", expected: Buffer.from("old"), actual: null },
    { path: "generated/unexpected.svg", expected: null, actual: Buffer.from("new") },
  ]);

  assert.equal(report.status, "failed");
  assert.deepEqual(report.files.map((file) => file.status), ["drift", "missing", "unexpected"]);
  assert.equal(report.expectedOutputCount, 2);
  assert.equal(report.actualOutputCount, 2);
});
