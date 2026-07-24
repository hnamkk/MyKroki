import { fetchWithTimeout } from "./http-timeout.mjs";

const TRANSIENT_STATUS_CODES = new Set([429, 503, 504]);

function retryDelayMs(response) {
  const retryAfter = response.headers.get("retry-after");
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(5_000, Math.max(1_000, seconds * 1_000));
  }
  return 1_000;
}

export async function renderPilotRequest(url, init, {
  attempts = 4,
  fetchRequest = fetchWithTimeout,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  timeoutMs = 30_000,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchRequest(url, init, timeoutMs);
    if (!TRANSIENT_STATUS_CODES.has(response.status) || attempt === attempts) {
      return response;
    }

    const delayMs = retryDelayMs(response);
    await response.body?.cancel();
    await sleep(delayMs);
  }
  throw new Error("Unreachable pilot render retry state");
}
