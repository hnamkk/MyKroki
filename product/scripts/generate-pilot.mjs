import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  deterministicRenderRequest,
  outputPathForSource,
  parseDiagramConfig,
} from "@diagram-as-code/diagram-config";

import { renderPilotRequest } from "./pilot-render.mjs";
import { waitForReadiness } from "./quality-utils.mjs";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pilotRoot = path.join(productRoot, "examples", "pilot-repository");
const gatewayUrl = (process.env.DIAGRAM_GATEWAY_URL ?? "http://localhost:9000").replace(/\/$/, "");
const apiKey = process.env.DIAGRAM_API_KEY;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  }));
  return files.flat();
}

const config = parseDiagramConfig(await readFile(path.join(pilotRoot, ".diagram.yml"), "utf8"));
const sourceFiles = (await walk(path.join(pilotRoot, "diagrams"))).sort();
let generated = 0;

await waitForReadiness();

for (const absoluteSourcePath of sourceFiles) {
  const sourcePath = path.relative(pilotRoot, absoluteSourcePath).replaceAll("\\", "/");
  const outputPath = outputPathForSource(sourcePath, config);
  if (!outputPath) continue;

  const source = await readFile(absoluteSourcePath, "utf8");
  const request = deterministicRenderRequest(sourcePath, source, config);
  const response = await renderPilotRequest(`${gatewayUrl}/api/v1/render`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const problem = await response.text();
    throw new Error(`Pilot render failed for ${sourcePath}: HTTP ${response.status} ${problem.slice(0, 500)}`);
  }

  const target = path.join(pilotRoot, outputPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  generated += 1;
}

if (generated !== 4) throw new Error(`Expected four pilot outputs, generated ${generated}`);
console.log(`Generated ${generated} pilot diagrams through ${gatewayUrl}`);
