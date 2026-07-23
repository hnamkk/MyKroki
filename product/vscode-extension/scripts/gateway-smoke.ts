import assert from "node:assert/strict";

import { GatewayClient } from "../src/core.ts";

const baseUrl = process.env.DIAGRAM_GATEWAY_URL ?? "http://localhost:9000";
const apiKey = process.env.DIAGRAM_API_KEY;
const client = new GatewayClient(baseUrl, apiKey);

const health = await client.health();
assert.notEqual(health.status, "down");
const catalog = await client.engines();
const mermaid = catalog.engines.find((engine) => engine.id === "mermaid");
assert.equal(mermaid?.available, true);
assert.ok(mermaid.formats.includes("svg"));
assert.ok(mermaid.formats.includes("png"));

const svg = await client.render({
  engine: "mermaid",
  format: "svg",
  source: "flowchart LR\n  VSCode --> Gateway",
  options: {
    theme: "default",
    "deterministic-ids": true,
    "deterministic-id-seed": "vscode-smoke.mmd",
  },
});
assert.equal(svg.contentType, "image/svg+xml");

const png = await client.render({
  engine: "mermaid",
  format: "png",
  source: "flowchart LR\n  VSCode --> Gateway",
  options: {
    theme: "default",
    "deterministic-ids": true,
    "deterministic-id-seed": "vscode-smoke.mmd",
  },
});
assert.equal(png.contentType, "image/png");

console.log(`VS Code Gateway smoke passed against ${baseUrl} (${health.version}).`);
