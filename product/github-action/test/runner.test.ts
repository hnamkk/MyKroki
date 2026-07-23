import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseDiagramConfig } from "@diagram-as-code/diagram-config";

import type { ActionInputs } from "../src/core.ts";
import { GatewayFailure } from "../src/gateway-client.ts";
import { runAction, type ActionManifest, type PreviewOutput } from "../src/runner.ts";

const config = parseDiagramConfig(`
version: 1
sources: [docs/diagrams/**/*.mmd]
output: docs/generated
defaults: { format: svg, theme: default }
`);

const inputs: ActionInputs = {
  gatewayUrl: "https://gateway.test",
  apiKey: "masked-key",
  configPath: ".diagram.yml",
  mode: "check",
  changedOnly: true,
  artifactName: "diagram-previews",
  failOnStale: true,
};

function fixture(context: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "diagram-action-runner-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "docs", "diagrams"), { recursive: true });
  mkdirSync(path.join(root, "docs", "generated"), { recursive: true });
  writeFileSync(path.join(root, "docs", "diagrams", "a.mmd"), "flowchart LR\nA-->B\n");
  return root;
}

function dependencies(render: (sourcePath: string) => Promise<Buffer>) {
  const published: Array<{ outputs: PreviewOutput[]; manifest: ActionManifest }> = [];
  const errors: Array<{ message: string; properties: object }> = [];
  const warnings: string[] = [];
  return {
    published,
    errors,
    warnings,
    value: {
      render,
      publish: async (_name: string, outputs: PreviewOutput[], manifest: ActionManifest) => {
        published.push({ outputs, manifest });
      },
      reporter: {
        error: (message: string, properties: object) => errors.push({ message, properties }),
        warning: (message: string) => warnings.push(message),
      },
    },
  };
}

test("check mode is read-only and publishes safe preview metadata", async (context) => {
  const root = fixture(context);
  const oldOutput = Buffer.from("<svg>old</svg>");
  writeFileSync(path.join(root, "docs", "generated", "a.svg"), oldOutput);
  const sourceMarker = readFileSync(path.join(root, "docs", "diagrams", "a.mmd"), "utf8");
  const deps = dependencies(async () => Buffer.from("<svg>new</svg>"));
  const result = await runAction({
    root,
    config,
    inputs,
    allSources: ["docs/diagrams/a.mmd"],
    generatedFiles: ["docs/generated/a.svg"],
    changes: [{ status: "M", path: "docs/diagrams/a.mmd" }],
    forceAll: false,
  }, deps.value);
  assert.equal(result.failed, true);
  assert.equal(result.staleCount, 1);
  assert.deepEqual(readFileSync(path.join(root, "docs", "generated", "a.svg")), oldOutput);
  assert.equal(deps.published.length, 1);
  assert.equal(deps.published[0]?.outputs[0]?.outputPath, "docs/generated/a.svg");
  assert.doesNotMatch(JSON.stringify(deps.published[0]?.manifest), new RegExp(sourceMarker.trim().replaceAll("-", "\\-")));
  assert.doesNotMatch(JSON.stringify(deps.published[0]?.manifest), /masked-key/);
});

test("check mode ignores checkout line-ending conversion for SVG", async (context) => {
  const root = fixture(context);
  writeFileSync(path.join(root, "docs", "generated", "a.svg"), "<svg>\r\n  <path />\r\n</svg>\r\n");
  const deps = dependencies(async () => Buffer.from("<svg>\n  <path />\n</svg>\n"));
  const result = await runAction({
    root,
    config,
    inputs,
    allSources: ["docs/diagrams/a.mmd"],
    generatedFiles: ["docs/generated/a.svg"],
    changes: [],
    forceAll: true,
  }, deps.value);
  assert.equal(result.failed, false);
  assert.equal(result.staleCount, 0);
  assert.equal(result.outcomes[0]?.status, "current");
});

test("check mode keeps binary output comparison byte-exact", async (context) => {
  const root = fixture(context);
  const pngConfig = parseDiagramConfig(`
version: 1
sources: [docs/diagrams/**/*.mmd]
output: docs/generated
defaults: { format: png, theme: default }
`);
  writeFileSync(path.join(root, "docs", "generated", "a.png"), Buffer.from([0x0d, 0x0a]));
  const deps = dependencies(async () => Buffer.from([0x0a]));
  const result = await runAction({
    root,
    config: pngConfig,
    inputs,
    allSources: ["docs/diagrams/a.mmd"],
    generatedFiles: ["docs/generated/a.png"],
    changes: [],
    forceAll: true,
  }, deps.value);
  assert.equal(result.failed, true);
  assert.equal(result.staleCount, 1);
  assert.equal(result.outcomes[0]?.status, "stale");
});

test("generate mode writes all outputs only after every render succeeds", async (context) => {
  const root = fixture(context);
  writeFileSync(path.join(root, "docs", "diagrams", "b.mmd"), "flowchart LR\nB-->C\n");
  writeFileSync(path.join(root, "docs", "generated", "a.svg"), "original");
  const deps = dependencies(async (sourcePath) => {
    if (sourcePath.endsWith("b.mmd")) {
      throw new GatewayFailure("The diagram source is invalid. (requestId=req-b)", 422, "DIAGRAM_SYNTAX_ERROR", "req-b", 2, 4);
    }
    return Buffer.from("replacement");
  });
  const result = await runAction({
    root,
    config,
    inputs: { ...inputs, mode: "generate" },
    allSources: ["docs/diagrams/a.mmd", "docs/diagrams/b.mmd"],
    generatedFiles: ["docs/generated/a.svg"],
    changes: [],
    forceAll: true,
  }, deps.value);
  assert.equal(result.failed, true);
  assert.equal(readFileSync(path.join(root, "docs", "generated", "a.svg"), "utf8"), "original");
  assert.equal(deps.errors[0]?.properties && (deps.errors[0].properties as { startLine?: number }).startLine, 2);
  assert.match(deps.warnings[0] ?? "", /No generated files were written/);
});

test("generate mode atomically writes changed output and removes orphans", async (context) => {
  const root = fixture(context);
  writeFileSync(path.join(root, "docs", "generated", "orphan.svg"), "orphan");
  const deps = dependencies(async () => Buffer.from("generated"));
  const result = await runAction({
    root,
    config,
    inputs: { ...inputs, mode: "generate" },
    allSources: ["docs/diagrams/a.mmd"],
    generatedFiles: ["docs/generated/orphan.svg"],
    changes: [],
    forceAll: true,
  }, deps.value);
  assert.equal(result.failed, false);
  assert.equal(result.changedCount, 2);
  assert.equal(readFileSync(path.join(root, "docs", "generated", "a.svg"), "utf8"), "generated");
  assert.throws(() => readFileSync(path.join(root, "docs", "generated", "orphan.svg")), /ENOENT/);
});

test("fail-on-stale false reports drift without failing check", async (context) => {
  const root = fixture(context);
  const deps = dependencies(async () => Buffer.from("generated"));
  const result = await runAction({
    root,
    config,
    inputs: { ...inputs, failOnStale: false },
    allSources: ["docs/diagrams/a.mmd"],
    generatedFiles: [],
    changes: [],
    forceAll: true,
  }, deps.value);
  assert.equal(result.staleCount, 1);
  assert.equal(result.failed, false);
});

test("multi-engine failure publishes only successful configured previews and safe errors", async (context) => {
  const root = fixture(context);
  writeFileSync(path.join(root, "docs", "diagrams", "b.puml"), "@startuml\nA -> B\n@enduml\n");
  const multiEngineConfig = parseDiagramConfig(`
version: 1
sources:
  - docs/diagrams/**/*.mmd
  - docs/diagrams/**/*.puml
output: docs/generated
`);
  const deps = dependencies(async (sourcePath) => {
    if (sourcePath.endsWith(".puml")) {
      throw new GatewayFailure("The diagram source is invalid. (requestId=req-plantuml)", 422, "DIAGRAM_SYNTAX_ERROR", "req-plantuml", 2, 1);
    }
    return Buffer.from("<svg>mermaid-preview</svg>");
  });
  const result = await runAction({
    root,
    config: multiEngineConfig,
    inputs,
    allSources: ["docs/diagrams/a.mmd", "docs/diagrams/b.puml"],
    generatedFiles: [],
    changes: [],
    forceAll: true,
  }, deps.value);
  assert.equal(result.errorCount, 1);
  assert.equal(result.staleCount, 1);
  assert.deepEqual(deps.published[0]?.outputs.map((item) => item.outputPath), ["docs/generated/a.svg"]);
  assert.deepEqual(deps.published[0]?.manifest.outcomes.find((item) => item.status === "error"), {
    sourcePath: "docs/diagrams/b.puml",
    outputPath: "docs/generated/b.svg",
    status: "error",
    code: "DIAGRAM_SYNTAX_ERROR",
    requestId: "req-plantuml",
  });
});
