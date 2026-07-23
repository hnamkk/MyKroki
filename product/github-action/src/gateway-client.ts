import type { RenderProblem, RenderRequest } from "@diagram-as-code/contracts";

export class GatewayFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly line?: number,
    readonly column?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GatewayFailure";
  }
}

const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: "Gateway rejected the render request.",
  401: "Gateway authentication failed. Verify 'auth-mode', OIDC audience/id-token permission, or the configured API key.",
  403: "Gateway denied this repository/workflow policy or the principal lacks diagram:render scope.",
  422: "The diagram source is invalid.",
  429: "Gateway rate limit or render capacity was exceeded.",
  503: "A required Gateway dependency, renderer, or OIDC key provider is unavailable.",
  504: "The render exceeded the Gateway deadline.",
};

function parseProblem(body: Buffer): Partial<RenderProblem> {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null ? value as Partial<RenderProblem> : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

export async function renderDiagram(
  baseUrl: string,
  credential: string | undefined,
  request: RenderRequest,
  fetchImplementation: typeof fetch = fetch,
): Promise<Buffer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  let response: Response;
  try {
    response = await fetchImplementation(`${baseUrl}/api/v1/render`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GatewayFailure(
      timeout ? "The Gateway request exceeded the 30 second client deadline." : "The Gateway could not be reached.",
      0,
      timeout ? "GATEWAY_CLIENT_TIMEOUT" : "GATEWAY_UNREACHABLE",
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (response.ok) return body;

  const problem = parseProblem(body);
  const requestId = typeof problem.requestId === "string"
    ? problem.requestId
    : response.headers.get("x-request-id") ?? undefined;
  const retryAfterSeconds = typeof problem.retryAfterSeconds === "number"
    ? problem.retryAfterSeconds
    : positiveInteger(response.headers.get("retry-after"));
  const baseMessage = STATUS_MESSAGES[response.status] ?? `Gateway render failed with HTTP ${response.status}.`;
  const detail = typeof problem.message === "string" && problem.message.length <= 500
    ? ` ${problem.message}`
    : "";
  const context = [
    requestId ? `requestId=${requestId}` : undefined,
    retryAfterSeconds ? `retryAfter=${retryAfterSeconds}s` : undefined,
  ].filter(Boolean).join(", ");
  throw new GatewayFailure(
    `${baseMessage}${detail}${context ? ` (${context})` : ""}`,
    response.status,
    typeof problem.code === "string" ? problem.code : `HTTP_${response.status}`,
    requestId,
    typeof problem.line === "number" ? problem.line : undefined,
    typeof problem.column === "number" ? problem.column : undefined,
    retryAfterSeconds,
  );
}
