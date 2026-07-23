import process from "node:process";

import {
  apiKey,
  gatewayUrl,
  render,
  waitForReadiness,
  writeJsonReport,
} from "./quality-utils.mjs";

if (!apiKey) throw new Error("Set DIAGRAM_API_KEY to the key configured for the Gateway");
const expected = process.env.RECOVERY_EXPECT ?? "ready";
if (!["degraded", "ready"].includes(expected)) throw new Error("RECOVERY_EXPECT must be degraded or ready");

await waitForReadiness(expected === "ready" ? 200 : 503);

const live = await fetch(`${gatewayUrl}/health/live`, { signal: AbortSignal.timeout(5_000) });
if (!live.ok) throw new Error(`Liveness failed in ${expected} state (${live.status})`);
await live.body?.cancel();

const ready = await fetch(`${gatewayUrl}/health/ready`, { signal: AbortSignal.timeout(5_000) });
const readiness = await ready.json();
const discoveryResponse = await fetch(`${gatewayUrl}/api/v1/engines`, { signal: AbortSignal.timeout(10_000) });
if (!discoveryResponse.ok) throw new Error(`Engine discovery failed (${discoveryResponse.status})`);
const discovery = await discoveryResponse.json();
const mermaid = discovery.engines.find((engine) => engine.id === "mermaid");
const independent = discovery.engines.filter((engine) => engine.id !== "mermaid");

if (expected === "degraded") {
  if (ready.status !== 503 || readiness.status !== "down") throw new Error("Readiness did not report dependency failure");
  if (mermaid?.available !== false || !independent.every((engine) => engine.available)) {
    throw new Error(`Engine availability was not isolated: ${JSON.stringify(discovery.engines)}`);
  }
  for (const [engine, source] of [
    ["plantuml", "@startuml\nAlice -> Bob: isolated\n@enduml"],
    ["graphviz", "digraph G { A -> B }"],
    ["d2", "A -> B"],
  ]) {
    const { response } = await render({ engine, format: "svg", source, cache: { mode: "no-store" } });
    if (!response.ok) throw new Error(`${engine} failed while Mermaid was down (${response.status})`);
    await response.body?.cancel();
  }
} else {
  if (!ready.ok || readiness.status !== "up" || !discovery.engines.every((engine) => engine.available)) {
    throw new Error(`Stack did not recover: ${ready.status}/${JSON.stringify(discovery.engines)}`);
  }
  const { response } = await render({
    engine: "mermaid",
    format: "svg",
    source: "flowchart LR\n  Restart --> Recovered",
    cache: { mode: "no-store" },
  });
  if (!response.ok || !(await response.text()).includes("<svg")) {
    throw new Error(`Mermaid render did not recover (${response.status})`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  expected,
  readinessStatus: ready.status,
  engines: discovery.engines.map(({ id, available, version }) => ({ id, available, version })),
};
await writeJsonReport(process.env.QUALITY_REPORT_PATH ?? `test-results/recovery-${expected}.json`, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
