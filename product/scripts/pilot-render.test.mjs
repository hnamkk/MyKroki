import assert from "node:assert/strict";
import test from "node:test";

import { renderPilotRequest } from "./pilot-render.mjs";

function response(status, retryAfter) {
  return new Response(null, {
    status,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });
}

test("retries transient render responses and respects bounded Retry-After", async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  const result = await renderPilotRequest("http://gateway/render", {}, {
    fetchRequest: async () => response(statuses.shift(), "20"),
    sleep: async (delayMs) => delays.push(delayMs),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(delays, [5_000, 5_000]);
});

test("does not retry deterministic client failures", async () => {
  let requests = 0;
  const result = await renderPilotRequest("http://gateway/render", {}, {
    fetchRequest: async () => {
      requests += 1;
      return response(422);
    },
    sleep: async () => assert.fail("sleep must not be called"),
  });

  assert.equal(result.status, 422);
  assert.equal(requests, 1);
});

test("returns the last transient response after the retry budget", async () => {
  let requests = 0;
  const result = await renderPilotRequest("http://gateway/render", {}, {
    attempts: 2,
    fetchRequest: async () => {
      requests += 1;
      return response(504);
    },
    sleep: async () => {},
  });

  assert.equal(result.status, 504);
  assert.equal(requests, 2);
});
