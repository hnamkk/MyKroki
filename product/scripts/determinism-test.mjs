import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { fetchWithTimeout } from "./http-timeout.mjs";

const directUrl = process.env.KROKI_DIRECT_URL?.replace(/\/$/, "");
if (!directUrl) throw new Error("Set KROKI_DIRECT_URL to the internal Kroki URL");
const hashes = {};

const examples = [
  ["mermaid", "flowchart LR\n  A --> B", { "deterministic-ids": true, "deterministic-id-seed": "contract-test" }],
  ["plantuml", "@startuml\nAlice -> Bob: hello\n@enduml", { "no-metadata": true }],
  ["c4plantuml", "@startuml\n!include <C4/C4_Context>\nPerson(user, \"User\")\nSystem(system, \"System\")\nRel(user, system, \"Uses\")\n@enduml", { "no-metadata": true }],
  ["graphviz", "digraph G { A -> B }", {}],
  ["dot", "digraph G { A -> B }", {}],
  ["d2", "A -> B", {}],
];

for (const [type, source, options] of examples) {
  const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
  const url = `${directUrl}/${type}/svg${query.size ? `?${query}` : ""}`;
  const outputs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: source,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${type} deterministic render failed: ${body}`);
    outputs.push(body);
  }
  if (outputs[0] !== outputs[1]) throw new Error(`${type} produced different SVG for identical source`);
  hashes[type] = createHash("sha256").update(outputs[0]).digest("hex");
  process.stdout.write(`deterministic ${type}\n`);
}

const graphviz = examples.find(([type]) => type === "graphviz");
const dot = examples.find(([type]) => type === "dot");
if (!graphviz || !dot) throw new Error("Graphviz alias fixture is missing");
const aliasOutputs = [];
for (const [type, source] of [graphviz, dot]) {
  const response = await fetchWithTimeout(`${directUrl}/${type}/svg`, {
    method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: source,
  });
  if (!response.ok) throw new Error(`${type} alias render failed`);
  aliasOutputs.push(await response.text());
}
if (aliasOutputs[0] !== aliasOutputs[1]) throw new Error("dot alias output differs from graphviz");
process.stdout.write("deterministic graphviz/dot alias\n");

const report = {
  generatedAt: new Date().toISOString(),
  rendererUrl: directUrl,
  hashes,
};
if (process.env.DETERMINISM_BASELINE) {
  const baseline = JSON.parse(await readFile(process.env.DETERMINISM_BASELINE, "utf8"));
  if (JSON.stringify(baseline.hashes) !== JSON.stringify(hashes)) {
    throw new Error(`Renderer output changed across restart: ${JSON.stringify({ before: baseline.hashes, after: hashes })}`);
  }
  process.stdout.write("deterministic output matches restart baseline\n");
}
if (process.env.DETERMINISM_REPORT) {
  await writeFile(process.env.DETERMINISM_REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
