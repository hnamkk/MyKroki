import process from "node:process";

import { fetchWithTimeout } from "./http-timeout.mjs";

const baseUrl = (process.env.DIAGRAM_GATEWAY_URL ?? "http://localhost:9000").replace(/\/$/, "");
const apiKey = process.env.DIAGRAM_API_KEY;
if (!apiKey) throw new Error("Set DIAGRAM_API_KEY to the key configured for the Gateway");

let engines;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const response = await fetchWithTimeout(`${baseUrl}/api/v1/engines`, {}, 5_000);
  if (response.ok) {
    engines = (await response.json()).engines;
    const mermaid = engines.find((engine) => engine.id === "mermaid");
    const others = engines.filter((engine) => engine.id !== "mermaid");
    if (mermaid?.available === false && others.length === 3 && others.every((engine) => engine.available)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
const mermaid = engines?.find((engine) => engine.id === "mermaid");
const others = engines?.filter((engine) => engine.id !== "mermaid") ?? [];
if (mermaid?.available !== false || others.length !== 3 || !others.every((engine) => engine.available)) {
  throw new Error(`Engine isolation metadata failed: ${JSON.stringify(engines)}`);
}

for (const [engine, source] of [
  ["plantuml", "@startuml\nAlice -> Bob\n@enduml"],
  ["graphviz", "digraph G { A -> B }"],
  ["d2", "A -> B"],
]) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetchWithTimeout(`${baseUrl}/api/v1/render`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ engine, format: "svg", source, cache: { mode: "no-store" } }),
    });
    if (response.status !== 429 || attempt === 3) break;
    const retryAfterSeconds = Math.max(1, Number(response.headers.get("retry-after")) || 1);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1_000));
  }
  if (!response) throw new Error(`No response while testing ${engine}`);
  if (!response.ok || !(await response.text()).includes("<svg")) {
    throw new Error(`${engine} failed while Mermaid was unavailable (${response.status})`);
  }
}
process.stdout.write("ok Mermaid failure isolated from PlantUML, Graphviz, and D2\n");
