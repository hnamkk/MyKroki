import process from "node:process";

import { fetchWithTimeout } from "./http-timeout.mjs";

const baseUrl = (process.env.DIAGRAM_GATEWAY_URL ?? "http://localhost:9000").replace(/\/$/, "");
const apiKey = process.env.DIAGRAM_API_KEY;
if (!apiKey) throw new Error("Set DIAGRAM_API_KEY to the key configured for the Gateway");

const authorization = `Bearer ${apiKey}`;
const svgFixtures = [
  ["mermaid", "flowchart LR\n  A --> B"],
  ["plantuml", "@startuml\nAlice -> Bob: hello\n@enduml"],
  ["c4plantuml", "@startuml\n!include <C4/C4_Context>\nPerson(user, \"User\")\nSystem(system, \"System\")\nRel(user, system, \"Uses\")\n@enduml"],
  ["graphviz", "digraph G { A -> B }"],
  ["dot", "digraph G { A -> B }"],
  ["d2", "client -> gateway -> renderer"],
];
const pngFixtures = svgFixtures.filter(([engine]) => ["mermaid", "plantuml", "graphviz"].includes(engine));

async function render(engine, format, source, options = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/render`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ engine, format, source, options, cache: { mode: "no-store" } }),
    });
    if (response.status !== 429 || attempt === 3) return response;
    const retryAfterSeconds = Math.max(1, Number(response.headers.get("retry-after")) || 1);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1_000));
  }
  throw new Error("Unreachable render retry state");
}

function assertHeaders(response, engine) {
  for (const header of ["etag", "x-cache", "x-diagram-engine", "x-renderer-version", "x-request-id"]) {
    if (!response.headers.get(header)) throw new Error(`${engine} omitted required header ${header}`);
  }
  if (response.headers.get("x-renderer-version") === "unknown") {
    throw new Error(`${engine} did not publish a renderer version`);
  }
}

const discoveryResponse = await fetchWithTimeout(`${baseUrl}/api/v1/engines`);
if (!discoveryResponse.ok) throw new Error(`Engine discovery failed (${discoveryResponse.status})`);
const discovery = await discoveryResponse.json();
const expected = new Map([
  ["mermaid", { aliases: [], formats: ["svg", "png"] }],
  ["plantuml", { aliases: ["c4plantuml"], formats: ["svg", "png"] }],
  ["graphviz", { aliases: ["dot"], formats: ["svg", "png"] }],
  ["d2", { aliases: [], formats: ["svg"] }],
]);
for (const [id, contract] of expected) {
  const engine = discovery.engines.find((candidate) => candidate.id === id);
  if (!engine || !engine.available || !engine.version || engine.version === "unknown") {
    throw new Error(`Invalid or unavailable discovery metadata for ${id}: ${JSON.stringify(engine)}`);
  }
  if (JSON.stringify(engine.aliases) !== JSON.stringify(contract.aliases)
    || JSON.stringify(engine.formats) !== JSON.stringify(contract.formats)) {
    throw new Error(`Capability drift for ${id}: ${JSON.stringify(engine)}`);
  }
}

for (const [engine, source] of svgFixtures) {
  const response = await render(engine, "svg", source);
  const body = await response.text();
  if (!response.ok || !body.includes("<svg")) {
    throw new Error(`${engine} SVG failed (${response.status}): ${body.slice(0, 500)}`);
  }
  assertHeaders(response, engine);
  process.stdout.write(`ok SVG ${engine}\n`);
}

for (const [engine, source] of pngFixtures) {
  const response = await render(engine, "png", source);
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok || body.length < 24 || body.length > 10_485_760
    || !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${engine} PNG failed (${response.status}, ${body.length} bytes)`);
  }
  if (body.readUInt32BE(16) === 0 || body.readUInt32BE(20) === 0) {
    throw new Error(`${engine} PNG has invalid dimensions`);
  }
  assertHeaders(response, engine);
  process.stdout.write(`ok PNG ${engine}\n`);
}

const d2Png = await render("d2", "png", "A -> B");
if (d2Png.status !== 400 || (await d2Png.json()).code !== "UNSUPPORTED_FORMAT") {
  throw new Error("D2 PNG must be rejected before invoking the renderer");
}

const invalidFixtures = [
  ["mermaid", "flowchart LR\n  A --"],
  ["plantuml", "@startuml\n!definelong X\n@enduml"],
  ["graphviz", "digraph G { A ->"],
  ["d2", "A: {"],
];
for (const [engine, source] of invalidFixtures) {
  const response = await render(engine, "svg", source);
  const problem = await response.json();
  if (response.status !== 422 || problem.code !== "DIAGRAM_SYNTAX_ERROR" || !problem.requestId) {
    throw new Error(`${engine} invalid-source contract drift: ${response.status} ${JSON.stringify(problem)}`);
  }
  const serialized = JSON.stringify(problem);
  if (/\b(?:at\s+|stacktrace)|\/(?:srv|app|tmp)\/|[A-Za-z]:\\/i.test(serialized)) {
    throw new Error(`${engine} error leaks stack trace or internal path: ${serialized}`);
  }
  process.stdout.write(`ok invalid ${engine}\n`);
}

for (const include of ["!includeurl http://127.0.0.1:9/private", "!include /etc/passwd"]) {
  const source = `@startuml\n${include}\nAlice -> Bob: secure\n@enduml`;
  const response = await render("plantuml", "svg", source);
  const body = await response.text();
  if (!response.ok || !body.includes("<svg") || /root:x:|127\.0\.0\.1:9\/private/.test(body)) {
    throw new Error(`PlantUML unsafe include was not neutralized: ${response.status} ${body.slice(0, 300)}`);
  }
}
process.stdout.write("ok secure includes\n");
