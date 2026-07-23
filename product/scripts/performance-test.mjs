import process from "node:process";

import {
  gatewayUrl,
  percentile,
  positiveInteger,
  render,
  timedFetch,
  waitForReadiness,
  writeJsonReport,
} from "./quality-utils.mjs";

const healthSamples = positiveInteger("PERF_HEALTH_SAMPLES", 30);
const cacheSamples = positiveInteger("PERF_CACHE_SAMPLES", 30);
const renderSamples = positiveInteger("PERF_RENDER_SAMPLES", 3);
const workspaceCount = positiveInteger("PERF_WORKSPACE_COUNT", 100);
const workspaceConcurrency = positiveInteger("PERF_WORKSPACE_CONCURRENCY", 4);
const strictShould = process.env.PERF_STRICT_SHOULD === "true";
const reportPath = process.env.QUALITY_REPORT_PATH ?? "test-results/performance.json";

const fixtures = [
  ["mermaid", (index) => `flowchart LR\n  A${index} --> B${index}`],
  ["plantuml", (index) => `@startuml\nAlice -> Bob: request ${index}\n@enduml`],
  ["graphviz", (index) => `digraph G { A${index} -> B${index} }`],
  ["d2", (index) => `A${index} -> B${index}`],
];

await waitForReadiness();

const healthDurations = [];
for (let index = 0; index < healthSamples; index += 1) {
  const { response, durationMs } = await timedFetch(`${gatewayUrl}/health/ready`, {}, 5_000);
  if (!response.ok) throw new Error(`Health sample ${index + 1} failed with ${response.status}`);
  await response.body?.cancel();
  healthDurations.push(durationMs);
}

const cacheRequest = {
  engine: "mermaid",
  format: "svg",
  source: "flowchart LR\n  PerformanceCache --> Hit",
  options: { "deterministic-ids": true, "deterministic-id-seed": "performance-cache" },
};
const warm = await render({ ...cacheRequest, cache: { mode: "refresh" } });
if (!warm.response.ok) throw new Error(`Cache warm-up failed with ${warm.response.status}`);
await warm.response.body?.cancel();

const cacheDurations = [];
for (let index = 0; index < cacheSamples; index += 1) {
  const { response, durationMs } = await render(cacheRequest);
  if (!response.ok || response.headers.get("x-cache") !== "HIT") {
    throw new Error(`Cache sample ${index + 1} was not a hit (${response.status}/${response.headers.get("x-cache")})`);
  }
  await response.body?.cancel();
  cacheDurations.push(durationMs);
}

const rendererResults = {};
for (const [engine, sourceFor] of fixtures) {
  const durations = [];
  for (let index = 0; index < renderSamples; index += 1) {
    const { response, durationMs } = await render({
      engine,
      format: "svg",
      source: sourceFor(`sample${index}`),
      cache: { mode: "no-store" },
    });
    if (!response.ok) throw new Error(`${engine} performance render failed with ${response.status}: ${await response.text()}`);
    await response.body?.cancel();
    durations.push(durationMs);
  }
  rendererResults[engine] = { samples: durations.length, p95Ms: percentile(durations, 95), maxMs: Math.max(...durations) };
}

const workspaceStartedAt = performance.now();
let nextWorkspaceIndex = 0;
async function workspaceWorker() {
  while (nextWorkspaceIndex < workspaceCount) {
    const index = nextWorkspaceIndex;
    nextWorkspaceIndex += 1;
    const [engine, sourceFor] = fixtures[index % fixtures.length];
    const { response } = await render({
      engine,
      format: "svg",
      source: sourceFor(`workspace${index}`),
      cache: { mode: "no-store" },
    });
    if (!response.ok) throw new Error(`Workspace render ${index} (${engine}) failed with ${response.status}: ${await response.text()}`);
    await response.body?.cancel();
  }
}
await Promise.all(Array.from({ length: Math.min(workspaceConcurrency, workspaceCount) }, () => workspaceWorker()));
const workspaceDurationMs = performance.now() - workspaceStartedAt;

const report = {
  generatedAt: new Date().toISOString(),
  thresholds: {
    healthP95Ms: 500,
    cacheHitP95Ms: 300,
    renderP95Ms: 10_000,
    workspace100Ms: 300_000,
  },
  health: { samples: healthDurations.length, p95Ms: percentile(healthDurations, 95), maxMs: Math.max(...healthDurations) },
  cacheHit: { samples: cacheDurations.length, p95Ms: percentile(cacheDurations, 95), maxMs: Math.max(...cacheDurations) },
  render: rendererResults,
  workspace: { diagrams: workspaceCount, concurrency: workspaceConcurrency, durationMs: workspaceDurationMs },
};
await writeJsonReport(reportPath, report);

const mustFailures = [];
if (report.health.p95Ms > report.thresholds.healthP95Ms) mustFailures.push(`health p95 ${report.health.p95Ms.toFixed(1)} ms`);
if (report.cacheHit.p95Ms > report.thresholds.cacheHitP95Ms) mustFailures.push(`cache p95 ${report.cacheHit.p95Ms.toFixed(1)} ms`);
const shouldFailures = Object.entries(rendererResults)
  .filter(([, result]) => result.p95Ms > report.thresholds.renderP95Ms)
  .map(([engine, result]) => `${engine} render p95 ${result.p95Ms.toFixed(1)} ms`);
if (workspaceCount >= 100 && workspaceDurationMs > report.thresholds.workspace100Ms) {
  shouldFailures.push(`workspace ${workspaceDurationMs.toFixed(1)} ms`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (shouldFailures.length > 0) process.stderr.write(`Should-target deviations: ${shouldFailures.join("; ")}\n`);
if (mustFailures.length > 0 || (strictShould && shouldFailures.length > 0)) {
  throw new Error([...mustFailures, ...(strictShould ? shouldFailures : [])].join("; "));
}
