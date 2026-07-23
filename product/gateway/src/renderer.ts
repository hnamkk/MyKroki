import {
  canonicalDiagramEngine,
  outputContentType,
  rendererDiagramEngine,
  type CanonicalDiagramEngine,
  type OutputFormat,
  type RenderRequest,
} from "@diagram-as-code/contracts";

import { InvalidRenderOutput, RenderOutputTooLarge } from "./output-validator.js";

export interface RendererClient {
  render(request: RenderRequest): Promise<Buffer>;
  capabilities(): Promise<EngineCapability[]>;
  ready(): Promise<boolean>;
}

export interface EngineCapability {
  id: CanonicalDiagramEngine;
  aliases: string[];
  version: string;
  formats: OutputFormat[];
  available: boolean;
  unavailableReason?: string;
}

export class RendererFailure extends Error {
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(message: string, location: { line?: number; column?: number } = {}) {
    super(message);
    this.name = "RendererFailure";
    this.line = location.line;
    this.column = location.column;
  }
}

export class RendererUnavailable extends Error {
  constructor(message = "Kroki renderer is unavailable", options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RendererUnavailable";
  }
}

export class RendererTimeout extends Error {
  constructor(message = "Renderer did not complete before the deadline", options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RendererTimeout";
  }
}

const ENGINE_PROBES: ReadonlyArray<{
  capability: Omit<EngineCapability, "version" | "available" | "unavailableReason">;
  requests: RenderRequest[];
}> = [
  {
    capability: { id: "mermaid", aliases: [], formats: ["svg", "png"] },
    requests: [{ engine: "mermaid", format: "svg", source: "flowchart LR\n  A --> B" }],
  },
  {
    capability: { id: "plantuml", aliases: ["c4plantuml"], formats: ["svg", "png"] },
    requests: [
      { engine: "plantuml", format: "svg", source: "@startuml\nAlice -> Bob: health\n@enduml" },
      {
        engine: "c4plantuml",
        format: "svg",
        source: "@startuml\n!include <C4/C4_Context>\nPerson(user, \"User\")\nSystem(system, \"System\")\nRel(user, system, \"Uses\")\n@enduml",
      },
    ],
  },
  {
    capability: { id: "graphviz", aliases: ["dot"], formats: ["svg", "png"] },
    requests: [{ engine: "graphviz", format: "svg", source: "digraph G { A -> B }" }],
  },
  {
    capability: { id: "d2", aliases: [], formats: ["svg"] },
    requests: [{ engine: "d2", format: "svg", source: "A -> B" }],
  },
];

const LOCATION_PATTERNS = [
  /\bline\s*[:=]?\s*(\d+)(?:\s*[,;:]\s*(?:column|col)\s*[:=]?\s*(\d+))?/i,
  /(?:^|\s|\()(?:[^\s():]+:)?(\d+):(\d+)(?:\)|\s|$)/m,
];

function cleanRendererMessage(message: string): string {
  const firstUsefulLine = message
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^at\s+/i.test(line) && !/^stack(?:trace)?\s*:/i.test(line));
  return (firstUsefulLine ?? "Diagram source was rejected by the renderer")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:]+[\\/])+[^\s:]+/g, "[internal path]")
    .slice(0, 1_000);
}

export function parseRendererFailure(body: Buffer, contentType: string | null): RendererFailure {
  let message = body.toString("utf8").trim();
  if (contentType?.toLowerCase().startsWith("application/json")) {
    try {
      const parsed = JSON.parse(message) as { error?: string | { message?: string } };
      if (typeof parsed.error === "string") message = parsed.error;
      else if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Fall back to the bounded plain-text representation below.
    }
  }
  const cleanMessage = cleanRendererMessage(message);
  for (const pattern of LOCATION_PATTERNS) {
    const match = pattern.exec(message);
    if (match) {
      return new RendererFailure(cleanMessage, {
        line: Number(match[1]),
        ...(match[2] === undefined ? {} : { column: Number(match[2]) }),
      });
    }
  }
  return new RendererFailure(cleanMessage);
}

export async function readResponseBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel();
    throw new RenderOutputTooLarge(contentLength, maximumBytes);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RenderOutputTooLarge(total, maximumBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class KrokiRenderer implements RendererClient {
  private capabilitySnapshot: { expiresAt: number; value: EngineCapability[] } | undefined;
  private capabilityRefresh: Promise<EngineCapability[]> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxOutputBytes = 10_485_760,
    private readonly fallbackVersion = "unknown",
    private readonly capabilityTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async render(request: RenderRequest): Promise<Buffer> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.options ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (value !== undefined) query.set(key, String(value));
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const engine = rendererDiagramEngine(request.engine);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${engine}/${request.format}${suffix}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "text/plain; charset=utf-8",
        },
        body: request.source,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new RendererTimeout(undefined, { cause: error });
      }
      throw new RendererUnavailable(undefined, { cause: error });
    }

    let responseBody: Buffer;
    try {
      responseBody = await readResponseBody(response, this.maxOutputBytes);
    } catch (error) {
      if (error instanceof RenderOutputTooLarge) throw error;
      throw new RendererUnavailable("Kroki response stream failed", { cause: error });
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new RendererUnavailable(`Kroki returned HTTP ${response.status}`);
      }
      throw parseRendererFailure(responseBody, response.headers.get("content-type"));
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const expectedContentType = outputContentType(request.format);
    if (contentType !== expectedContentType) {
      throw new InvalidRenderOutput(
        `Kroki returned content type '${contentType ?? "missing"}'; expected '${expectedContentType}'`,
      );
    }
    return responseBody;
  }

  async ready(): Promise<boolean> {
    const capabilities = await this.capabilities();
    return capabilities.every((engine) => engine.available);
  }

  async capabilities(): Promise<EngineCapability[]> {
    const now = this.now();
    if (this.capabilitySnapshot && this.capabilitySnapshot.expiresAt > now) {
      return this.copyCapabilities(this.capabilitySnapshot.value);
    }
    if (this.capabilityRefresh) return this.copyCapabilities(await this.capabilityRefresh);

    const refresh = this.discoverCapabilities();
    this.capabilityRefresh = refresh;
    try {
      return this.copyCapabilities(await refresh);
    } finally {
      if (this.capabilityRefresh === refresh) this.capabilityRefresh = undefined;
    }
  }

  private async discoverCapabilities(): Promise<EngineCapability[]> {
    const versions = await this.readVersions();
    const value = await Promise.all(ENGINE_PROBES.map(async ({ capability, requests }) => {
      const version = versions?.[capability.id]
        ?? capability.aliases.map((alias) => versions?.[alias]).find(Boolean)
        ?? this.fallbackVersion;
      if (!versions) {
        return { ...capability, version, available: false, unavailableReason: "Kroki backend is not ready" };
      }
      try {
        await Promise.all(requests.map((request) => this.render(request)));
        return { ...capability, version, available: true };
      } catch {
        return {
          ...capability,
          version,
          available: false,
          unavailableReason: `${capability.id} renderer is not ready`,
        };
      }
    }));
    this.capabilitySnapshot = { expiresAt: this.now() + this.capabilityTtlMs, value };
    return value;
  }

  private copyCapabilities(value: EngineCapability[]): EngineCapability[] {
    return value.map((item) => ({ ...item, aliases: [...item.aliases], formats: [...item.formats] }));
  }

  private async readVersions(): Promise<Record<string, string> | undefined> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { version?: Record<string, unknown> };
      const entries = Object.entries(body.version ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
      return Object.fromEntries(entries);
    } catch {
      return undefined;
    }
  }
}
