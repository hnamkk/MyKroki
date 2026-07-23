import process from "node:process";

import {
  gatewayUrl,
  positiveInteger,
  render,
  waitForReadiness,
  writeJsonReport,
} from "./quality-utils.mjs";

const durationSeconds = positiveInteger("SOAK_DURATION_SECONDS", 60);
const concurrency = positiveInteger("SOAK_CONCURRENCY", 12);
const maximumAllowedActive = positiveInteger("SOAK_MAX_ACTIVE", 4);
const maximumAllowedQueued = positiveInteger("SOAK_MAX_QUEUE", 20);
const reportPath = process.env.QUALITY_REPORT_PATH ?? "test-results/soak.json";
const deadline = Date.now() + durationSeconds * 1_000;
let sequence = 0;
const statusCounts = new Map();
const durations = [];
let maximumActive = 0;
let maximumQueued = 0;
let monitoring = true;

await waitForReadiness();

function metricValue(body, name) {
  const match = body.match(new RegExp(`^${name}\\s+(\\d+(?:\\.\\d+)?)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

const monitor = (async () => {
  while (monitoring) {
    const response = await fetch(`${gatewayUrl}/metrics`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Metrics unavailable during soak (${response.status})`);
    const body = await response.text();
    const active = metricValue(body, "diagram_gateway_render_active");
    const queued = metricValue(body, "diagram_gateway_render_queued");
    if (active === undefined || queued === undefined) throw new Error("Bulkhead gauges are missing");
    maximumActive = Math.max(maximumActive, active);
    maximumQueued = Math.max(maximumQueued, queued);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
})();

async function worker(workerId) {
  while (Date.now() < deadline) {
    const index = sequence;
    sequence += 1;
    const startedAt = performance.now();
    const { response } = await render({
      engine: "mermaid",
      format: "svg",
      source: `flowchart LR\n  W${workerId}_${index} --> Complete`,
      options: { "deterministic-ids": true, "deterministic-id-seed": `soak-${workerId}-${index}` },
      cache: { mode: "no-store" },
    }, 30_000);
    durations.push(performance.now() - startedAt);
    statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
    await response.body?.cancel();
    if (response.status >= 500) throw new Error(`Soak request failed with ${response.status}`);
    if (response.status !== 200 && response.status !== 429) {
      throw new Error(`Unexpected soak response ${response.status}`);
    }
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
} finally {
  monitoring = false;
  await monitor;
}

const drainDeadline = Date.now() + 15_000;
let finalActive;
let finalQueued;
while (Date.now() < drainDeadline) {
  const body = await (await fetch(`${gatewayUrl}/metrics`, { signal: AbortSignal.timeout(5_000) })).text();
  finalActive = metricValue(body, "diagram_gateway_render_active");
  finalQueued = metricValue(body, "diagram_gateway_render_queued");
  if (finalActive === 0 && finalQueued === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const report = {
  generatedAt: new Date().toISOString(),
  durationSeconds,
  concurrency,
  limits: { maximumActive: maximumAllowedActive, maximumQueued: maximumAllowedQueued },
  completed: durations.length,
  statusCounts: Object.fromEntries([...statusCounts].sort(([left], [right]) => left - right)),
  bulkhead: { maximumActive, maximumQueued, finalActive, finalQueued },
  latency: {
    maximumMs: durations.length === 0 ? 0 : Math.max(...durations),
    averageMs: durations.length === 0 ? 0 : durations.reduce((total, value) => total + value, 0) / durations.length,
  },
};
await writeJsonReport(reportPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (maximumActive > maximumAllowedActive || maximumQueued > maximumAllowedQueued) {
  throw new Error("Bulkhead exceeded configured limits");
}
if (finalActive !== 0 || finalQueued !== 0) throw new Error("Bulkhead permits did not drain after soak");
if ((statusCounts.get(200) ?? 0) === 0) throw new Error("Soak completed without a successful render");
