import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryResultCache } from "../dist/result-cache.js";

test("expires entries by TTL without returning stale output", async () => {
  let now = 1_000;
  const cache = new InMemoryResultCache({
    maxEntries: 10,
    maxWeightBytes: 100,
    maxItemWeightBytes: 100,
    ttlMs: 50,
    now: () => now,
  });
  assert.equal(await cache.set("diagram", Buffer.from("svg")), true);
  assert.equal((await cache.get("diagram"))?.toString(), "svg");
  now += 50;
  assert.equal(await cache.get("diagram"), undefined);
});

test("evicts least-recently-used entries by count and total weight", async () => {
  const cache = new InMemoryResultCache({
    maxEntries: 2,
    maxWeightBytes: 6,
    maxItemWeightBytes: 4,
    ttlMs: 1_000,
  });
  await cache.set("a", Buffer.from("aaa"));
  await cache.set("b", Buffer.from("bb"));
  assert.equal((await cache.get("a"))?.toString(), "aaa");
  await cache.set("c", Buffer.from("ccc"));
  assert.equal(await cache.get("b"), undefined);
  assert.equal((await cache.get("a"))?.toString(), "aaa");
  assert.equal((await cache.get("c"))?.toString(), "ccc");
});

test("does not cache an item above the cacheable output limit", async () => {
  const cache = new InMemoryResultCache({
    maxEntries: 10,
    maxWeightBytes: 100,
    maxItemWeightBytes: 4,
    ttlMs: 1_000,
  });
  assert.equal(await cache.set("large", Buffer.from("12345")), false);
  assert.equal(await cache.get("large"), undefined);
});
