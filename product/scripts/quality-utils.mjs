import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

import { fetchWithTimeout } from "./http-timeout.mjs";

export const gatewayUrl = (process.env.DIAGRAM_GATEWAY_URL ?? "http://localhost:9000").replace(/\/$/, "");
export const apiKey = process.env.DIAGRAM_API_KEY;
export const authorization = apiKey ? `Bearer ${apiKey}` : undefined;

export function positiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

export async function timedFetch(input, init = {}, timeoutMs = 30_000) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(input, init, timeoutMs);
  return { response, durationMs: performance.now() - startedAt };
}

export async function render(request, timeoutMs = 30_000) {
  if (!authorization) throw new Error("Set DIAGRAM_API_KEY to the key configured for the Gateway");
  return timedFetch(`${gatewayUrl}/api/v1/render`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(request),
  }, timeoutMs);
}

export async function waitForReadiness(expectedStatus = 200, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${gatewayUrl}/health/ready`, {}, 5_000);
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status === expectedStatus) return;
    } catch {
      lastStatus = "unreachable";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Gateway readiness did not reach ${expectedStatus}; last status: ${lastStatus}`);
}

export async function writeJsonReport(path, report) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function assertProblem(response, problem, status, code, label) {
  if (response.status !== status || problem?.code !== code || !problem?.requestId) {
    throw new Error(`${label}: expected ${status}/${code}, received ${response.status}/${JSON.stringify(problem)}`);
  }
}
