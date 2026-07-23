import process from "node:process";
import { deflateRawSync } from "node:zlib";

import {
  apiKey,
  assertProblem,
  authorization,
  gatewayUrl,
  waitForReadiness,
  writeJsonReport,
} from "./quality-utils.mjs";

if (!apiKey || !authorization) throw new Error("Set DIAGRAM_API_KEY to the key configured for the Gateway");
await waitForReadiness();

const canarySource = "PRIVATE_DIAGRAM_SOURCE_CANARY";
const canaryCredential = `${apiKey}-must-not-leak`;
const checks = [];

async function problemRequest(label, input, expectedStatus, expectedCode) {
  const response = await fetch(input.url, {
    method: input.method ?? "POST",
    headers: input.headers,
    body: input.body,
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let problem;
  try {
    problem = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: expected problem JSON, received ${raw.slice(0, 200)}`);
  }
  assertProblem(response, problem, expectedStatus, expectedCode, label);
  if (raw.includes(canarySource) || raw.includes(apiKey) || raw.includes(canaryCredential)) {
    throw new Error(`${label}: response leaked source or credential canary`);
  }
  checks.push({ label, status: response.status, code: problem.code });
}

await problemRequest("malformed JSON", {
  url: `${gatewayUrl}/api/v1/render`,
  headers: { authorization, "content-type": "application/json" },
  body: `{"engine":"mermaid","source":"${canarySource}"`,
}, 400, "INVALID_REQUEST");

await problemRequest("missing credential", {
  url: `${gatewayUrl}/api/v1/render`,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ engine: "mermaid", format: "svg", source: canarySource }),
}, 401, "UNAUTHENTICATED");

await problemRequest("invalid credential", {
  url: `${gatewayUrl}/api/v1/render`,
  headers: { authorization: `Bearer ${canaryCredential}`, "content-type": "application/json" },
  body: JSON.stringify({ engine: "mermaid", format: "svg", source: canarySource }),
}, 401, "UNAUTHENTICATED");

await problemRequest("oversized JSON source", {
  url: `${gatewayUrl}/api/v1/render`,
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify({ engine: "mermaid", format: "svg", source: "A".repeat(1_048_577) }),
}, 413, "PAYLOAD_TOO_LARGE");

const compressedBomb = deflateRawSync(Buffer.from("B".repeat(1_048_577))).toString("base64url");
await problemRequest("encoded decompression limit", {
  url: `${gatewayUrl}/api/v1/render/mermaid/svg/${compressedBomb}`,
  method: "GET",
  headers: { authorization },
}, 413, "PAYLOAD_TOO_LARGE");

await problemRequest("invalid encoded source", {
  url: `${gatewayUrl}/api/v1/render/mermaid/svg/not_deflate`,
  method: "GET",
  headers: { authorization },
}, 400, "INVALID_ENCODED_SOURCE");

const traversal = await fetch(`${gatewayUrl}/api/v1/render/%2e%2e/%2e%2e/passwd`, {
  headers: { authorization },
  signal: AbortSignal.timeout(5_000),
});
if (traversal.status !== 404) throw new Error(`Path traversal route returned ${traversal.status}`);
const traversalBody = await traversal.text();
if (traversalBody.includes(apiKey) || traversalBody.includes(canarySource)) throw new Error("Path traversal response leaked a canary");
checks.push({ label: "path traversal route", status: traversal.status });

const metrics = await (await fetch(`${gatewayUrl}/metrics`, { signal: AbortSignal.timeout(5_000) })).text();
if (metrics.includes(apiKey) || metrics.includes(canaryCredential) || metrics.includes(canarySource)) {
  throw new Error("Metrics leaked a source or credential canary");
}
checks.push({ label: "metric redaction", status: 200 });

const report = { generatedAt: new Date().toISOString(), checks };
await writeJsonReport(process.env.QUALITY_REPORT_PATH ?? "test-results/security.json", report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
