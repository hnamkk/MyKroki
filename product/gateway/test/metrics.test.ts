import assert from "node:assert/strict";
import test from "node:test";

import { GatewayMetrics } from "../dist/metrics.js";

test("reports cache adapter degradation without sensitive labels", () => {
  const metrics = new GatewayMetrics();
  metrics.recordCacheError("read");
  metrics.recordCacheError("write");
  metrics.recordCacheError("write");
  const output = metrics.render(0, 0);
  assert.match(output, /diagram_gateway_cache_errors_total\{operation="read"\} 1/);
  assert.match(output, /diagram_gateway_cache_errors_total\{operation="write"\} 2/);
});
