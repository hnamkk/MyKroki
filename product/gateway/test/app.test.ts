import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import { createGateway } from "../dist/app.js";
import { RENDER_SCOPE, apiKeyVerifier } from "../dist/auth.js";
import type { GatewayConfig } from "../dist/config.js";
import { GitHubOidcAuthenticator } from "../dist/github-oidc.js";
import { RendererFailure, RendererTimeout, RendererUnavailable, type RendererClient } from "../dist/renderer.js";

const config: GatewayConfig = {
  authMode: "required",
  apiKeyRecords: [{
    id: "test-key",
    verifier: apiKeyVerifier("secret"),
    scopes: [RENDER_SCOPE],
    cachePartition: "test",
    status: "active",
  }],
  githubOidc: undefined,
  deploymentProfile: "local",
  port: 9000,
  host: "0.0.0.0",
  krokiBaseUrl: "http://kroki:8000",
  maxSourceBytes: 1024,
  maxOutputBytes: 10_000,
  renderTimeoutMs: 1000,
  renderMaxConcurrent: 4,
  renderMaxQueue: 10,
  cacheMaxEntries: 10,
  cacheMaxBytes: 100_000,
  cacheMaxItemBytes: 10_000,
  cacheTtlMs: 60_000,
  rendererVersion: "kroki-0.31.1",
  gatewayVersion: "0.1.0",
  sanitizerVersion: "svg-sanitizer-1",
  rateLimitPerMinute: 60,
  rateLimitBurst: 10,
  metricsEnabled: true,
  logLevel: "silent",
};

function renderer(overrides: Partial<RendererClient> = {}): RendererClient {
  return {
    render: async () => Buffer.from("<svg>ok</svg>"),
    capabilities: async () => [
      { id: "mermaid", aliases: [], version: "mermaid-1", formats: ["svg", "png"], available: true },
      { id: "plantuml", aliases: ["c4plantuml"], version: "plantuml-1", formats: ["svg", "png"], available: true },
      { id: "graphviz", aliases: ["dot"], version: "graphviz-1", formats: ["svg", "png"], available: true },
      { id: "d2", aliases: [], version: "d2-1", formats: ["svg"], available: true },
    ],
    ready: async () => true,
    ...overrides,
  };
}

const auth = { authorization: "Bearer secret" };

test("health endpoints are public while rendering requires Bearer auth", async () => {
  const app = createGateway({ config, renderer: renderer() });
  const live = await app.inject({ method: "GET", url: "/health/live" });
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  const unauthorized = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" },
  });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().status, "up");
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().version, "0.1.0");
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().code, "UNAUTHENTICATED");
  assert.match(unauthorized.headers["content-type"] ?? "", /^application\/problem\+json/);
  await app.close();
});

test("renders SVG through JSON, text, and encoded URL contracts", async () => {
  const calls: Array<{ engine: string; source: string }> = [];
  const app = createGateway({
    config,
    renderer: renderer({ render: async (request) => {
      calls.push({ engine: request.engine, source: request.source });
      return Buffer.from(`<svg>${request.engine}</svg>`);
    } }),
  });
  const source = "flowchart LR; A-->B";
  const encoded = deflateRawSync(Buffer.from(source)).toString("base64url");
  const json = await app.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "svg", source, cache: { mode: "no-store" } },
  });
  const text = await app.inject({
    method: "POST", url: "/api/v1/render/plantuml/svg", headers: { ...auth, "content-type": "text/plain" },
    payload: "@startuml\n@enduml",
  });
  const get = await app.inject({ method: "GET", url: `/api/v1/render/dot/svg/${encoded}`, headers: auth });
  assert.equal(json.statusCode, 200);
  assert.equal(json.body, "<svg>mermaid</svg>");
  assert.equal(json.headers["x-cache"], "BYPASS");
  assert.equal(json.headers["cache-control"], "no-store");
  assert.match(json.headers["content-type"] ?? "", /^image\/svg\+xml/);
  assert.ok(json.headers.etag);
  assert.ok(json.headers["x-request-id"]);
  assert.equal(text.statusCode, 200);
  assert.equal(get.statusCode, 200);
  assert.deepEqual(calls.map((call) => call.engine), ["mermaid", "plantuml", "dot"]);
  assert.equal(calls[2]?.source, source);
  await app.close();
});

test("rejects invalid engine, unsupported format, bad encoding, and oversized source", async () => {
  let calls = 0;
  const app = createGateway({
    config: { ...config, maxSourceBytes: 8 },
    renderer: renderer({ render: async () => { calls += 1; return Buffer.from("<svg/>"); } }),
  });
  const invalid = await app.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "bpmn", format: "svg", source: "x" },
  });
  const unsupported = await app.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "d2", format: "png", source: "x" },
  });
  const unsupportedOption = await app.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "d2", format: "svg", source: "x", options: { executable: "bad" } },
  });
  const badEncoded = await app.inject({ method: "GET", url: "/api/v1/render/d2/svg/not_deflate", headers: auth });
  const uriTooLong = await app.inject({
    method: "GET", url: `/api/v1/render/d2/svg/${"a".repeat(8_193)}`, headers: auth,
  });
  const oversized = await app.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "d2", format: "svg", source: "123456789" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(unsupported.json().code, "UNSUPPORTED_FORMAT");
  assert.equal(unsupportedOption.json().code, "UNSUPPORTED_OPTION");
  assert.equal(badEncoded.json().code, "INVALID_ENCODED_SOURCE");
  assert.equal(uriTooLong.statusCode, 414);
  assert.equal(uriTooLong.json().code, "URI_TOO_LONG");
  assert.equal(oversized.statusCode, 413);
  assert.equal(calls, 0);
  await app.close();
});

test("rate limits each authenticated principal with Retry-After", async () => {
  const app = createGateway({
    config: { ...config, rateLimitBurst: 2 },
    renderer: renderer(),
  });
  const request = {
    method: "POST" as const, url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B", cache: { mode: "no-store" } },
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 200);
  const limited = await app.inject(request);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  await app.close();
});

test("caches identical renders and coalesces concurrent misses", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = createGateway({
    config,
    renderer: renderer({ render: async () => { calls += 1; await gate; return Buffer.from("<svg>same</svg>"); } }),
  });
  const request = {
    method: "POST" as const, url: "/api/v1/render", headers: auth,
    payload: { engine: "d2", format: "svg", source: "a -> b" },
  };
  const firstPromise = app.inject(request);
  const secondPromise = app.inject(request);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release?.();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const third = await app.inject(request);
  assert.equal(calls, 1);
  assert.deepEqual([first.headers["x-cache"], second.headers["x-cache"]].sort(), ["HIT", "MISS"]);
  assert.equal(third.headers["x-cache"], "HIT");
  await app.close();
});

test("normalizes renderer failures to documented problem responses", async () => {
  for (const [failure, status, code] of [
    [new RendererFailure("Syntax error", { line: 3, column: 7 }), 422, "DIAGRAM_SYNTAX_ERROR"],
    [new RendererUnavailable("offline"), 503, "RENDERER_UNAVAILABLE"],
    [new RendererTimeout(), 504, "RENDER_TIMEOUT"],
  ] as const) {
    const app = createGateway({ config, renderer: renderer({ render: async () => { throw failure; } }) });
    const response = await app.inject({
      method: "POST", url: "/api/v1/render", headers: auth,
      payload: { engine: "plantuml", format: "svg", source: "@startuml\n@enduml" },
    });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().code, code);
    assert.ok(response.json().requestId);
    await app.close();
  }
});

test("lists per-engine capabilities and reports renderer readiness", async () => {
  const app = createGateway({ config, renderer: renderer({ capabilities: async () => [
    { id: "mermaid", aliases: [], version: "11.15.0", formats: ["svg", "png"], available: false, unavailableReason: "mermaid renderer is not ready" },
    { id: "plantuml", aliases: ["c4plantuml"], version: "1.2026.6", formats: ["svg", "png"], available: true },
    { id: "graphviz", aliases: ["dot"], version: "14.1.3", formats: ["svg", "png"], available: true },
    { id: "d2", aliases: [], version: "0.7.1", formats: ["svg"], available: true },
  ] }) });
  const engines = await app.inject({ method: "GET", url: "/api/v1/engines" });
  const readiness = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(engines.statusCode, 200);
  assert.deepEqual(engines.json().engines.map((item: { id: string }) => item.id), ["mermaid", "plantuml", "graphviz", "d2"]);
  assert.equal(engines.json().engines[1].aliases[0], "c4plantuml");
  assert.equal(engines.json().engines[0].version, "11.15.0");
  assert.equal(engines.json().engines[0].available, false);
  assert.equal(engines.json().engines[1].available, true);
  assert.equal(readiness.statusCode, 503);
  assert.equal(readiness.json().status, "down");
  assert.equal(readiness.json().checks[0].name, "mermaid");
  await app.close();
});

test("distinguishes missing scope from revoked credentials", async () => {
  const noScopeConfig: GatewayConfig = {
    ...config,
    apiKeyRecords: [{
      id: "read-only",
      verifier: apiKeyVerifier("read-only-secret"),
      scopes: ["diagram:read"],
      cachePartition: "read-only",
      status: "active",
    }],
  };
  const forbiddenApp = createGateway({ config: noScopeConfig, renderer: renderer() });
  const forbidden = await forbiddenApp.inject({
    method: "POST", url: "/api/v1/render",
    headers: { authorization: "Bearer read-only-secret" },
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, "FORBIDDEN");
  await forbiddenApp.close();

  const revokedApp = createGateway({
    config: { ...config, apiKeyRecords: [{ ...config.apiKeyRecords[0]!, status: "revoked" }] },
    renderer: renderer(),
  });
  const revoked = await revokedApp.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" },
  });
  assert.equal(revoked.statusCode, 401);
  assert.equal(revoked.json().code, "UNAUTHENTICATED");
  await revokedApp.close();
});

test("isolates HTTP cache and rate limits by principal", async () => {
  let calls = 0;
  const multiKeyConfig: GatewayConfig = {
    ...config,
    rateLimitBurst: 1,
    apiKeyRecords: [
      { id: "a", verifier: apiKeyVerifier("key-a"), scopes: [RENDER_SCOPE], cachePartition: "a", status: "active" },
      { id: "b", verifier: apiKeyVerifier("key-b"), scopes: [RENDER_SCOPE], cachePartition: "b", status: "active" },
    ],
  };
  const app = createGateway({
    config: multiKeyConfig,
    renderer: renderer({ render: async () => { calls += 1; return Buffer.from("<svg>partitioned</svg>"); } }),
  });
  const payload = { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" };
  const firstA = await app.inject({ method: "POST", url: "/api/v1/render", headers: { authorization: "Bearer key-a" }, payload });
  const firstB = await app.inject({ method: "POST", url: "/api/v1/render", headers: { authorization: "Bearer key-b" }, payload });
  const secondA = await app.inject({ method: "POST", url: "/api/v1/render", headers: { authorization: "Bearer key-a" }, payload });
  assert.equal(firstA.headers["x-cache"], "MISS");
  assert.equal(firstB.headers["x-cache"], "MISS");
  assert.equal(secondA.statusCode, 429);
  assert.equal(calls, 2);
  await app.close();
});

test("returns sanitized SVG and rejects invalid or oversized renderer output", async () => {
  const unsafeApp = createGateway({
    config,
    renderer: renderer({ render: async () => Buffer.from('<svg onload="x()"><script>x()</script><text>ok</text></svg>') }),
  });
  const unsafe = await unsafeApp.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" },
  });
  assert.equal(unsafe.statusCode, 200);
  assert.match(unsafe.body, /<text>ok<\/text>/);
  assert.doesNotMatch(unsafe.body, /script|onload/i);
  await unsafeApp.close();

  const invalidPngApp = createGateway({ config, renderer: renderer({ render: async () => Buffer.from("not-png") }) });
  const invalidPng = await invalidPngApp.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "png", source: "flowchart LR; A-->B" },
  });
  assert.equal(invalidPng.statusCode, 502);
  assert.equal(invalidPng.json().code, "INVALID_RENDER_OUTPUT");
  await invalidPngApp.close();

  const largeApp = createGateway({
    config: { ...config, maxOutputBytes: 12 },
    renderer: renderer({ render: async () => Buffer.from("<svg>too-large</svg>") }),
  });
  const large = await largeApp.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "d2", format: "svg", source: "a -> b" },
  });
  assert.equal(large.statusCode, 502);
  assert.equal(large.json().code, "RENDER_OUTPUT_TOO_LARGE");
  await largeApp.close();
});

test("returns capacity error without exceeding backend concurrency", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = createGateway({
    config: { ...config, renderMaxConcurrent: 1, renderMaxQueue: 0 },
    renderer: renderer({ render: async () => { calls += 1; await gate; return Buffer.from("<svg>ok</svg>"); } }),
  });
  const request = {
    method: "POST" as const, url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B", cache: { mode: "no-store" } },
  };
  const firstPromise = app.inject(request);
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const rejected = await app.inject({ ...request, payload: { ...request.payload, source: "flowchart LR; B-->C" } });
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.json().code, "RENDER_CAPACITY_EXCEEDED");
  assert.equal(calls, 1);
  release?.();
  assert.equal((await firstPromise).statusCode, 200);
  await app.close();
});

test("emits allowlisted events and aggregate metrics without source or credential", async () => {
  const events: unknown[] = [];
  const sourceMarker = "PRIVATE_SOURCE_MARKER";
  const app = createGateway({ config, renderer: renderer(), eventSink: (event) => events.push(event) });
  const response = await app.inject({
    method: "POST", url: "/api/v1/render", headers: auth,
    payload: { engine: "mermaid", format: "svg", source: sourceMarker },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(events.length, 1);
  const serializedEvent = JSON.stringify(events[0]);
  assert.match(serializedEvent, /api-key:test-key/);
  assert.doesNotMatch(serializedEvent, /PRIVATE_SOURCE_MARKER|secret/);

  const metrics = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.body, /diagram_gateway_render_requests_total/);
  assert.match(metrics.body, /diagram_gateway_cache_results_total\{result="MISS"\} 1/);
  assert.doesNotMatch(metrics.body, /PRIVATE_SOURCE_MARKER|test-key|secret/);
  await app.close();

  const disabled = createGateway({ config: { ...config, metricsEnabled: false }, renderer: renderer() });
  assert.equal((await disabled.inject({ method: "GET", url: "/metrics" })).statusCode, 404);
  await disabled.close();
});

test("authorizes GitHub OIDC and audits repository policy without logging the JWT", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const oidcConfig = {
    issuer: "https://token.actions.githubusercontent.com",
    audience: "diagram-gateway",
    jwksUrl: "https://unused.example.test/jwks",
    clockToleranceSeconds: 30,
    jwksCacheMaxAgeMs: 600_000,
    jwksCooldownMs: 0,
    jwksTimeoutMs: 1_000,
    repositoryPolicies: [{
      repositoryId: "123456",
      status: "active" as const,
      scopes: [RENDER_SCOPE],
      cachePartition: "github:123456",
      workflowRefs: ["octo/diagrams/.github/workflows/diagram-check.yml@refs/*"],
      events: {
        pull_request: { refs: ["refs/pull/*"], baseRefs: ["main"] },
      },
    }],
  };
  const oidcAuthenticator = new GitHubOidcAuthenticator(
    oidcConfig,
    createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
  );
  const makeToken = (workflowRef: string) => new SignJWT({
    repository_id: "123456",
    repository: "octo/diagrams",
    repository_visibility: "private",
    workflow_ref: workflowRef,
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
    base_ref: "main",
    head_ref: "feature/diagram",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(oidcConfig.issuer)
    .setAudience(oidcConfig.audience)
    .setSubject("repo:octo/diagrams:pull_request")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const acceptedToken = await makeToken("octo/diagrams/.github/workflows/diagram-check.yml@refs/heads/main");
  const deniedToken = await makeToken("octo/diagrams/.github/workflows/untrusted.yml@refs/heads/main");
  const events: Record<string, unknown>[] = [];
  const app = createGateway({
    config: { ...config, apiKeyRecords: [], githubOidc: oidcConfig },
    renderer: renderer(),
    oidcAuthenticator,
    eventSink: (event) => events.push(event),
  });

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${acceptedToken}` },
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" },
  });
  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${deniedToken}` },
    payload: { engine: "mermaid", format: "svg", source: "flowchart LR; B-->C" },
  });

  assert.equal(accepted.statusCode, 200);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "OIDC_POLICY_DENIED");
  assert.deepEqual(events.map((event) => ({
    principalSubject: event.principalSubject,
    repositoryId: event.repositoryId,
    workflowRef: event.workflowRef,
    policyDecision: event.policyDecision,
    statusCode: event.statusCode,
  })), [
    {
      principalSubject: "github-repository:123456",
      repositoryId: "123456",
      workflowRef: "octo/diagrams/.github/workflows/diagram-check.yml@refs/heads/main",
      policyDecision: "allowed",
      statusCode: 200,
    },
    {
      principalSubject: "github-repository:123456",
      repositoryId: "123456",
      workflowRef: "octo/diagrams/.github/workflows/untrusted.yml@refs/heads/main",
      policyDecision: "denied",
      statusCode: 403,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(acceptedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await app.close();
});
