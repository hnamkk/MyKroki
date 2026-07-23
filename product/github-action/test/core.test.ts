import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDiagramConfig } from "@diagram-as-code/diagram-config";

import {
  buildVerificationPlan,
  assertUniqueOutputPaths,
  deterministicRequest,
  findOrphanedOutputs,
  parseActionInputs,
  parseNameStatus,
  resolveWithinRoot,
  type FileChange,
} from "../src/core.ts";

const config = parseDiagramConfig(`
version: 1
sources:
  - docs/diagrams/**/*.mmd
  - docs/diagrams/**/*.puml
  - docs/diagrams/**/*.dot
  - docs/diagrams/**/*.d2
output: docs/generated
defaults:
  format: svg
  theme: default
`);

test("plans only changed supported diagrams in normal PRs", () => {
  const changes: FileChange[] = [
    { status: "M", path: "docs/diagrams/checkout.mmd" },
    { status: "M", path: "src/app.ts" },
  ];
  assert.deepEqual(buildVerificationPlan(changes, [], config, false), [
    { sourcePath: "docs/diagrams/checkout.mmd", outputPath: "docs/generated/checkout.svg", operation: "verify" },
  ]);
});

test("checks all sources when .diagram.yml changes", () => {
  const changes: FileChange[] = [{ status: "M", path: ".diagram.yml" }];
  const allSources = ["docs/diagrams/z.d2", "docs/diagrams/a.puml"];
  assert.deepEqual(buildVerificationPlan(changes, allSources, config, true), [
    { sourcePath: "docs/diagrams/a.puml", outputPath: "docs/generated/a.svg", operation: "verify" },
    { sourcePath: "docs/diagrams/z.d2", outputPath: "docs/generated/z.svg", operation: "verify" },
  ]);
});

test("removes generated output when a source is deleted", () => {
  assert.deepEqual(
    buildVerificationPlan([{ status: "D", path: "docs/diagrams/old.dot" }], [], config, false),
    [{ sourcePath: "docs/diagrams/old.dot", outputPath: "docs/generated/old.svg", operation: "remove" }],
  );
});

test("verifies the source when generated output changes directly", () => {
  assert.deepEqual(
    buildVerificationPlan(
      [{ status: "M", path: "docs/generated/checkout.svg" }],
      ["docs/diagrams/checkout.mmd"],
      config,
      false,
    ),
    [{ sourcePath: "docs/diagrams/checkout.mmd", outputPath: "docs/generated/checkout.svg", operation: "verify" }],
  );
});

test("builds deterministic OpenAPI render requests", () => {
  assert.deepEqual(deterministicRequest("docs/diagrams/a.mmd", "flowchart LR\nA-->B", config), {
    engine: "mermaid",
    format: "svg",
    source: "flowchart LR\nA-->B",
    options: { theme: "default", "deterministic-ids": true, "deterministic-id-seed": "docs/diagrams/a.mmd" },
  });
  assert.deepEqual(deterministicRequest("docs/diagrams/a.puml", "@startuml\n@enduml", config), {
    engine: "plantuml",
    format: "svg",
    source: "@startuml\n@enduml",
    options: { theme: "default", "no-metadata": true },
  });
});

test("validates all public Action inputs strictly", () => {
  assert.deepEqual(parseActionInputs({ "gateway-url": "https://diagrams.example.test/" }), {
    gatewayUrl: "https://diagrams.example.test",
    apiKey: undefined,
    authMode: "auto",
    oidcAudience: undefined,
    configPath: ".diagram.yml",
    mode: "check",
    changedOnly: true,
    artifactName: "diagram-previews",
    failOnStale: true,
  });
  assert.throws(() => parseActionInputs({ "gateway-url": "file:///tmp/gateway" }), /HTTP\(S\)/);
  assert.throws(() => parseActionInputs({ "gateway-url": "https://user:secret@example.test" }), /embedded credentials/);
  assert.throws(() => parseActionInputs({ "gateway-url": "https://example.test", mode: "commit" }), /check.*generate/);
  assert.throws(() => parseActionInputs({ "gateway-url": "https://example.test", "auth-mode": "pat" }), /auth-mode/);
  assert.throws(() => parseActionInputs({ "gateway-url": "https://example.test", "config-path": "../secret" }), /repository-relative/);
  assert.throws(() => parseActionInputs({ "gateway-url": "https://example.test", "changed-only": "yes" }), /true.*false/);
});

test("parses rename and deletion records from git name-status", () => {
  assert.deepEqual(parseNameStatus("R100\told/a.mmd\tnew/a.mmd\nD\told/b.puml\n"), [
    { status: "R", oldPath: "old/a.mmd", path: "new/a.mmd" },
    { status: "D", path: "old/b.puml" },
  ]);
});

test("finds orphaned SVG and PNG files during a full scan", () => {
  assert.deepEqual(
    findOrphanedOutputs(
      ["docs/diagrams/a.mmd"],
      ["docs/generated/a.svg", "docs/generated/removed.svg", "docs/generated/old.png"],
      config,
    ),
    [
      { sourcePath: "", outputPath: "docs/generated/old.png", operation: "remove" },
      { sourcePath: "", outputPath: "docs/generated/removed.svg", operation: "remove" },
    ],
  );
});

test("rejects two diagram sources that map to the same generated output", () => {
  const collisionConfig = parseDiagramConfig(`
version: 1
sources: [docs/diagrams/**/*]
output: docs/generated
`);
  assert.throws(
    () => assertUniqueOutputPaths(["docs/diagrams/a.mmd", "docs/diagrams/a.puml"], collisionConfig),
    /map to the same output/,
  );
});

test("a rename that keeps the output path does not plan its removal", () => {
  assert.deepEqual(buildVerificationPlan([
    { status: "R", oldPath: "docs/diagrams/a.puml", path: "docs/diagrams/a.mmd" },
  ], ["docs/diagrams/a.mmd"], config, false), [
    { sourcePath: "docs/diagrams/a.mmd", outputPath: "docs/generated/a.svg", operation: "verify" },
  ]);
});

test("refuses lexical and symlink workspace escapes", (context) => {
  const root = mkdtempSync(join(tmpdir(), "diagram-action-root-"));
  const outside = mkdtempSync(join(tmpdir(), "diagram-action-outside-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  assert.throws(() => resolveWithinRoot(root, "../secret"), /repository-relative/);
  mkdirSync(join(root, "docs"));
  symlinkSync(outside, join(root, "docs", "linked"), "junction");
  assert.throws(() => resolveWithinRoot(root, "docs/linked/output.svg"), /outside/);
});
