import { createHash } from "node:crypto";

import { canonicalDiagramEngine, type RenderRequest } from "@diagram-as-code/contracts";

import { RenderBulkhead } from "./bulkhead.js";
import { validateRenderOutput } from "./output-validator.js";
import { RendererUnavailable, type RendererClient } from "./renderer.js";
import { InMemoryResultCache, type ResultCache } from "./result-cache.js";

export interface RenderResult {
  body: Buffer;
  cache: "HIT" | "MISS" | "BYPASS";
  rendererVersion: string;
}

export interface RenderServiceOptions {
  maxEntries: number;
  maxCacheBytes: number;
  maxCacheItemBytes: number;
  cacheTtlMs: number;
  sanitizerVersion: string;
  maxOutputBytes: number;
  maxConcurrent: number;
  maxQueue: number;
  onCacheError?: (operation: "read" | "write", error: unknown) => void;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function renderKey(
  request: RenderRequest,
  rendererVersion: string,
  sanitizerVersion: string,
  cachePartition: string,
): string {
  const { cache: _cachePolicy, ...renderInput } = request;
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ rendererVersion, sanitizerVersion, cachePartition, request: renderInput })))
    .digest("hex");
}

export class RenderService {
  private readonly cache: ResultCache;
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  readonly bulkhead: RenderBulkhead;

  constructor(
    private readonly renderer: RendererClient,
    private readonly options: RenderServiceOptions,
    cache?: ResultCache,
  ) {
    this.bulkhead = new RenderBulkhead(options.maxConcurrent, options.maxQueue);
    this.cache = cache ?? new InMemoryResultCache({
      maxEntries: options.maxEntries,
      maxWeightBytes: options.maxCacheBytes,
      maxItemWeightBytes: options.maxCacheItemBytes,
      ttlMs: options.cacheTtlMs,
    });
  }

  async render(request: RenderRequest, cachePartition: string): Promise<RenderResult> {
    const capability = (await this.renderer.capabilities())
      .find((engine) => engine.id === canonicalDiagramEngine(request.engine));
    if (!capability?.available) {
      throw new RendererUnavailable(
        capability?.unavailableReason ?? `Renderer metadata is missing for ${request.engine}`,
      );
    }
    const rendererVersion = capability.version;
    const mode = request.cache?.mode ?? "default";
    if (mode === "no-store") {
      return { body: await this.renderAndValidate(request), cache: "BYPASS", rendererVersion };
    }

    const key = renderKey(
      request,
      rendererVersion,
      this.options.sanitizerVersion,
      cachePartition,
    );
    if (mode !== "refresh") {
      const cached = await this.readCache(key);
      if (cached !== undefined) {
        return { body: cached, cache: "HIT", rendererVersion };
      }

      const pending = this.inFlight.get(key);
      if (pending) return { body: await pending, cache: "HIT", rendererVersion };
    }

    const renderPromise = this.renderAndValidate(request);
    this.inFlight.set(key, renderPromise);
    try {
      const body = await renderPromise;
      await this.writeCache(key, body);
      return { body, cache: "MISS", rendererVersion };
    } finally {
      if (this.inFlight.get(key) === renderPromise) this.inFlight.delete(key);
    }
  }

  private async renderAndValidate(request: RenderRequest): Promise<Buffer> {
    return this.bulkhead.run(async () => {
      const body = await this.renderer.render(request);
      return validateRenderOutput(body, request.format, this.options.maxOutputBytes);
    });
  }

  private async readCache(key: string): Promise<Buffer | undefined> {
    try {
      return await this.cache.get(key);
    } catch (error) {
      this.options.onCacheError?.("read", error);
      return undefined;
    }
  }

  private async writeCache(key: string, body: Buffer): Promise<void> {
    try {
      await this.cache.set(key, body);
    } catch (error) {
      this.options.onCacheError?.("write", error);
      // Cache availability must not prevent a healthy renderer response.
    }
  }
}
