import assert from "node:assert/strict";
import test from "node:test";

import { RenderService, renderKey } from "../dist/render-service.js";
import type { RendererClient } from "../dist/renderer.js";
import type { ResultCache } from "../dist/result-cache.js";

const request = { engine: "mermaid" as const, format: "svg" as const, source: "flowchart LR; A-->B" };

function service(renderer: RendererClient): RenderService {
  return new RenderService(renderer, {
    maxEntries: 10,
    maxCacheBytes: 100_000,
    maxCacheItemBytes: 10_000,
    cacheTtlMs: 60_000,
    sanitizerVersion: "sanitizer-1",
    maxOutputBytes: 10_000,
    maxConcurrent: 2,
    maxQueue: 2,
  });
}

test("isolates cache and single-flight by principal partition", async () => {
  let calls = 0;
  const renderer: RendererClient = {
    render: async () => { calls += 1; return Buffer.from("<svg>ok</svg>"); },
    capabilities: async () => [{
      id: "mermaid", aliases: [], version: "renderer-1", formats: ["svg", "png"], available: true,
    }],
    ready: async () => true,
  };
  const renderService = service(renderer);
  assert.equal((await renderService.render(request, "repo-a")).cache, "MISS");
  assert.equal((await renderService.render(request, "repo-a")).cache, "HIT");
  assert.equal((await renderService.render(request, "repo-b")).cache, "MISS");
  assert.equal(calls, 2);
});

test("cache key includes renderer, sanitizer, partition, and options without exposing source", () => {
  const base = renderKey(request, "renderer-1", "sanitizer-1", "repo-a");
  assert.notEqual(base, renderKey(request, "renderer-2", "sanitizer-1", "repo-a"));
  assert.notEqual(base, renderKey(request, "renderer-1", "sanitizer-2", "repo-a"));
  assert.notEqual(base, renderKey(request, "renderer-1", "sanitizer-1", "repo-b"));
  assert.equal(base, renderKey({ ...request, cache: { mode: "refresh" } }, "renderer-1", "sanitizer-1", "repo-a"));
  assert.equal(base.includes(request.source), false);
  assert.match(base, /^[a-f0-9]{64}$/);
});

test("degrades to renderer output when the cache adapter is unavailable", async () => {
  let calls = 0;
  const cacheErrors: string[] = [];
  const renderer: RendererClient = {
    render: async () => { calls += 1; return Buffer.from("<svg>ok</svg>"); },
    capabilities: async () => [{
      id: "mermaid", aliases: [], version: "renderer-1", formats: ["svg", "png"], available: true,
    }],
    ready: async () => true,
  };
  const unavailableCache: ResultCache = {
    get: async () => { throw new Error("cache offline"); },
    set: async () => { throw new Error("cache offline"); },
  };
  const renderService = new RenderService(renderer, {
    maxEntries: 10,
    maxCacheBytes: 100_000,
    maxCacheItemBytes: 10_000,
    cacheTtlMs: 60_000,
    sanitizerVersion: "sanitizer-1",
    maxOutputBytes: 10_000,
    maxConcurrent: 2,
    maxQueue: 2,
    onCacheError: (operation) => cacheErrors.push(operation),
  }, unavailableCache);
  assert.equal((await renderService.render(request, "repo-a")).cache, "MISS");
  assert.equal((await renderService.render(request, "repo-a")).cache, "MISS");
  assert.equal(calls, 2);
  assert.deepEqual(cacheErrors, ["read", "write", "read", "write"]);
});
