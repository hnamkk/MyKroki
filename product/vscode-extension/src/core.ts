import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type {
  OutputFormat,
  RenderProblem,
  RenderRequest,
} from "@diagram-as-code/contracts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RenderOutput {
  bytes: Uint8Array;
  contentType: "image/svg+xml" | "image/png";
}

export interface EngineInfo {
  id: string;
  aliases: string[];
  version: string;
  formats: OutputFormat[];
  available: boolean;
  unavailableReason?: string;
}

export interface EngineList {
  apiVersion: "v1";
  generatedAt: string;
  engines: EngineInfo[];
}

export interface HealthStatus {
  status: "up" | "degraded" | "down";
  service: string;
  version: string;
  timestamp: string;
  checks: Array<{
    name: string;
    status: "up" | "degraded" | "down";
    detail?: string;
    latencyMs?: number;
  }>;
}

const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: "Gateway rejected the request.",
  401: "Gateway authentication failed. Store a valid API key with Diagram: Set Gateway API Key.",
  403: "The API key is not allowed to render diagrams.",
  413: "The diagram source exceeds the Gateway request limit.",
  422: "The diagram source is invalid.",
  429: "Gateway rate limit or render capacity was exceeded.",
  503: "The Gateway or requested renderer is unavailable.",
  504: "The render exceeded the Gateway deadline.",
};

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    error: Partial<RenderProblem> & Pick<RenderProblem, "message">,
    status = error.status ?? 0,
  ) {
    super(error.message);
    this.name = "GatewayError";
    this.status = status;
    this.code = error.code ?? (status > 0 ? `HTTP_${status}` : "GATEWAY_ERROR");
    this.line = error.line;
    this.column = error.column;
    this.requestId = error.requestId;
    this.retryAfterSeconds = error.retryAfterSeconds;
  }
}

function parseProblem(body: Uint8Array, status: number, headers: Headers): GatewayError {
  const text = Buffer.from(body).toString("utf8");
  let problem: Partial<RenderProblem> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) problem = parsed as Partial<RenderProblem>;
  } catch {
    // Proxy and network edge responses are not guaranteed to use problem+json.
  }
  const requestId = typeof problem.requestId === "string"
    ? problem.requestId
    : headers.get("x-request-id") ?? undefined;
  const retryHeader = headers.get("retry-after");
  const retryAfterSeconds = typeof problem.retryAfterSeconds === "number"
    ? problem.retryAfterSeconds
    : retryHeader && /^\d+$/.test(retryHeader)
      ? Number(retryHeader)
      : undefined;
  const base = STATUS_MESSAGES[status] ?? `Gateway returned HTTP ${status}.`;
  const detail = typeof problem.message === "string" && problem.message.length <= 500
    ? ` ${problem.message}`
    : "";
  const context = [
    requestId ? `requestId=${requestId}` : undefined,
    retryAfterSeconds ? `retryAfter=${retryAfterSeconds}s` : undefined,
  ].filter(Boolean).join(", ");
  return new GatewayError({
    ...problem,
    message: `${base}${detail}${context ? ` (${context})` : ""}`,
    ...(requestId ? { requestId } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  }, status);
}

function validateOutput(format: OutputFormat, body: Uint8Array, contentType: string | null): RenderOutput {
  if (format === "svg") {
    const text = Buffer.from(body).toString("utf8");
    if (!/(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
      throw new GatewayError({
        code: "INVALID_RESPONSE",
        message: "Gateway returned an invalid SVG response.",
      });
    }
    if (contentType && !contentType.toLowerCase().startsWith("image/svg+xml")) {
      throw new GatewayError({
        code: "INVALID_RESPONSE",
        message: `Gateway returned '${contentType}' for an SVG render.`,
      });
    }
    return { bytes: body, contentType: "image/svg+xml" };
  }

  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (body.length < signature.length || !signature.every((value, index) => body[index] === value)) {
    throw new GatewayError({
      code: "INVALID_RESPONSE",
      message: "Gateway returned an invalid PNG response.",
    });
  }
  if (contentType && !contentType.toLowerCase().startsWith("image/png")) {
    throw new GatewayError({
      code: "INVALID_RESPONSE",
      message: `Gateway returned '${contentType}' for a PNG render.`,
    });
  }
  return { bytes: body, contentType: "image/png" };
}

export class GatewayClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Gateway URL must be HTTP(S) without embedded credentials.");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  async render(request: RenderRequest, signal?: AbortSignal): Promise<RenderOutput> {
    const response = await this.request("/api/v1/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, signal);
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw parseProblem(body, response.status, response.headers);
    return validateOutput(request.format, body, response.headers.get("content-type"));
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    return this.getJson<HealthStatus>("/health/ready", signal);
  }

  async engines(signal?: AbortSignal): Promise<EngineList> {
    return this.getJson<EngineList>("/api/v1/engines", signal);
  }

  private async getJson<T>(route: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(route, { method: "GET" }, signal);
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw parseProblem(body, response.status, response.headers);
    try {
      return JSON.parse(Buffer.from(body).toString("utf8")) as T;
    } catch {
      throw new GatewayError({
        code: "INVALID_RESPONSE",
        message: `Gateway returned invalid JSON from ${route}.`,
      });
    }
  }

  private async request(route: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetcher(`${this.baseUrl}${route}`, {
        ...init,
        headers,
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const timedOut = timeout.aborted
        || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      throw new GatewayError({
        code: timedOut ? "GATEWAY_CLIENT_TIMEOUT" : "GATEWAY_UNREACHABLE",
        message: timedOut
          ? `Gateway request exceeded the ${Math.ceil(this.timeoutMs / 1000)} second client deadline.`
          : "Gateway could not be reached. Check the URL, network, TLS, and service health.",
      });
    }
  }
}

interface ActiveRender {
  controller: AbortController;
  generation: number;
  hash: string;
  promise: Promise<RenderOutput>;
}

export class RenderCoordinator {
  private readonly cache = new Map<string, { hash: string; output: RenderOutput }>();
  private readonly active = new Map<string, ActiveRender>();
  private generation = 0;

  constructor(
    private readonly renderFn: (request: RenderRequest, signal: AbortSignal) => Promise<RenderOutput>,
  ) {}

  render(resource: string, request: RenderRequest): Promise<RenderOutput> {
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const cached = this.cache.get(resource);
    if (cached?.hash === hash) return Promise.resolve(cached.output);

    const pending = this.active.get(resource);
    if (pending?.hash === hash) return pending.promise;
    pending?.controller.abort();
    const current: ActiveRender = {
      controller: new AbortController(),
      generation: ++this.generation,
      hash,
      promise: Promise.resolve({ bytes: new Uint8Array(), contentType: "image/svg+xml" }),
    };
    this.active.set(resource, current);
    current.promise = this.execute(resource, request, hash, current);
    return current.promise;
  }

  private async execute(
    resource: string,
    request: RenderRequest,
    hash: string,
    current: ActiveRender,
  ): Promise<RenderOutput> {
    try {
      const output = await this.renderFn(request, current.controller.signal);
      if (current.controller.signal.aborted || this.active.get(resource)?.generation !== current.generation) {
        throw new Error("Render was superseded by newer source");
      }
      this.cache.set(resource, { hash, output });
      return output;
    } finally {
      if (this.active.get(resource)?.generation === current.generation) {
        this.active.delete(resource);
      }
    }
  }
}

export function resolveWorkspaceOutput(
  workspaceRoot: string,
  relativeOutput: string,
): string {
  const root = realpathSync(path.resolve(workspaceRoot));
  const output = path.resolve(root, relativeOutput);
  const relative = path.relative(root, output);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Generated output path must remain inside the workspace.");
  }
  let existingAncestor = output;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const resolvedAncestor = realpathSync(existingAncestor);
  const resolvedRelative = path.relative(root, resolvedAncestor);
  if (
    resolvedRelative === ".."
    || resolvedRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(resolvedRelative)
  ) {
    throw new Error("Generated output path resolves outside the workspace.");
  }
  return output;
}
