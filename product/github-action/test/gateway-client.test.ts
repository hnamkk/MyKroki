import assert from "node:assert/strict";
import test from "node:test";

import { GatewayFailure, renderDiagram } from "../src/gateway-client.ts";

const request = { engine: "mermaid" as const, format: "svg" as const, source: "flowchart LR\nA-->B" };

test("sends API key only when configured and returns binary output", async () => {
  let capturedAuthorization: string | null = "not-called";
  const fakeFetch: typeof fetch = async (_input, init) => {
    capturedAuthorization = new Headers(init?.headers).get("authorization");
    return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  };
  assert.equal((await renderDiagram("https://gateway.test", undefined, request, fakeFetch)).toString(), "<svg/>");
  assert.equal(capturedAuthorization, null);
  await renderDiagram("https://gateway.test", "private-key", request, fakeFetch);
  assert.equal(capturedAuthorization, "Bearer private-key");
});

test("maps syntax errors to actionable location and request ID", async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
    status: 422,
    code: "DIAGRAM_SYNTAX_ERROR",
    message: "Unexpected token",
    requestId: "req-syntax",
    line: 7,
    column: 3,
  }), { status: 422, headers: { "content-type": "application/problem+json" } });
  await assert.rejects(
    renderDiagram("https://gateway.test", "key", request, fakeFetch),
    (error: unknown) => {
      assert.ok(error instanceof GatewayFailure);
      assert.equal(error.code, "DIAGRAM_SYNTAX_ERROR");
      assert.equal(error.line, 7);
      assert.equal(error.column, 3);
      assert.match(error.message, /req-syntax/);
      return true;
    },
  );
});

for (const [status, expected] of [[401, /authentication failed/], [403, /denied/], [429, /rate limit/], [503, /unavailable/], [504, /deadline/]] as const) {
  test(`classifies Gateway HTTP ${status}`, async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
      status,
      code: `TEST_${status}`,
      requestId: `req-${status}`,
    }), { status, headers: { "retry-after": status === 429 ? "9" : "" } });
    await assert.rejects(renderDiagram("https://gateway.test", undefined, request, fakeFetch), expected);
  });
}

test("classifies network failures without exposing low-level error details", async () => {
  const fakeFetch: typeof fetch = async () => { throw new Error("connect ECONNREFUSED 10.0.0.1 secret-host"); };
  await assert.rejects(
    renderDiagram("https://gateway.test", undefined, request, fakeFetch),
    (error: unknown) => error instanceof GatewayFailure
      && error.code === "GATEWAY_UNREACHABLE"
      && !error.message.includes("10.0.0.1"),
  );
});
