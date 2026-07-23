import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GatewayClient,
  RenderCoordinator,
  resolveWorkspaceOutput,
  type RenderOutput,
} from "../src/core.ts";

const svgOutput: RenderOutput = {
  bytes: Buffer.from("<svg>ok</svg>"),
  contentType: "image/svg+xml",
};

test("Gateway client sends auth using the OpenAPI render route", async () => {
  let received: { url: string; init: RequestInit } | undefined;
  const client = new GatewayClient("http://localhost:9000/", "secret", async (input, init) => {
    received = { url: String(input), init: init ?? {} };
    return new Response("<svg>ok</svg>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  });
  const output = await client.render({ engine: "mermaid", format: "svg", source: "A-->B" });
  assert.equal(Buffer.from(output.bytes).toString("utf8"), "<svg>ok</svg>");
  assert.equal(received?.url, "http://localhost:9000/api/v1/render");
  assert.equal(new Headers(received?.init.headers).get("authorization"), "Bearer secret");
});

test("Gateway client exposes structured problem details", async () => {
  const client = new GatewayClient("http://localhost:9000", "secret", async () =>
    new Response(JSON.stringify({
      type: "/problems/diagram-syntax-error",
      title: "Invalid diagram",
      status: 422,
      code: "DIAGRAM_SYNTAX_ERROR",
      message: "bad arrow",
      line: 2,
      requestId: "r1",
    }), { status: 422, headers: { "content-type": "application/problem+json" } }),
  );
  await assert.rejects(
    client.render({ engine: "d2", format: "svg", source: "bad" }),
    (error: Error & { line?: number; requestId?: string }) =>
      error.message.includes("bad arrow") && error.line === 2 && error.requestId === "r1",
  );
});

test("coordinator aborts an older render and caches the latest result", async () => {
  const signals: AbortSignal[] = [];
  const resolvers: Array<(svg: string) => void> = [];
  const coordinator = new RenderCoordinator(async (_request, signal) => {
    signals.push(signal);
    return new Promise<RenderOutput>((resolve) => resolvers.push((svg) => resolve({
      bytes: Buffer.from(svg),
      contentType: "image/svg+xml",
    })));
  });
  const first = coordinator.render("file:///a.mmd", { engine: "mermaid", format: "svg", source: "A" });
  const second = coordinator.render("file:///a.mmd", { engine: "mermaid", format: "svg", source: "B" });
  assert.equal(signals[0]?.aborted, true);
  resolvers[0]?.("<svg>A</svg>");
  resolvers[1]?.("<svg>B</svg>");
  await assert.rejects(first, /superseded/);
  assert.equal(Buffer.from((await second).bytes).toString("utf8"), "<svg>B</svg>");
  assert.equal(
    Buffer.from((await coordinator.render("file:///a.mmd", {
      engine: "mermaid",
      format: "svg",
      source: "B",
    })).bytes).toString("utf8"),
    "<svg>B</svg>",
  );
  assert.equal(signals.length, 2);
});

test("coordinator shares an in-flight render for identical source", async () => {
  let calls = 0;
  let release: ((output: RenderOutput) => void) | undefined;
  const coordinator = new RenderCoordinator(async () => {
    calls += 1;
    return new Promise<string>((resolve) => { release = resolve; });
  });
  const request = { engine: "graphviz" as const, format: "svg" as const, source: "digraph { A -> B }" };
  const preview = coordinator.render("file:///a.dot", request);
  const exportRender = coordinator.render("file:///a.dot", request);
  release?.({ ...svgOutput, bytes: Buffer.from("<svg>shared</svg>") });
  assert.equal(Buffer.from((await preview).bytes).toString("utf8"), "<svg>shared</svg>");
  assert.equal(Buffer.from((await exportRender).bytes).toString("utf8"), "<svg>shared</svg>");
  assert.equal(calls, 1);
});

test("Gateway client validates PNG and supports health and engine discovery", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const client = new GatewayClient("http://localhost:9000", undefined, async (input) => {
    const url = String(input);
    if (url.endsWith("/health/ready")) {
      return Response.json({
        status: "up",
        service: "diagram-gateway",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        checks: [],
      });
    }
    if (url.endsWith("/api/v1/engines")) {
      return Response.json({
        apiVersion: "v1",
        generatedAt: new Date().toISOString(),
        engines: [{ id: "mermaid", aliases: [], version: "1", formats: ["svg", "png"], available: true }],
      });
    }
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  assert.equal((await client.health()).status, "up");
  assert.deepEqual((await client.engines()).engines[0]?.formats, ["svg", "png"]);
  assert.deepEqual(
    Buffer.from((await client.render({ engine: "mermaid", format: "png", source: "A-->B" })).bytes),
    png,
  );
});

test("rejects invalid output signatures and workspace path escapes", async () => {
  const client = new GatewayClient("http://localhost:9000", undefined, async () =>
    new Response("not png", { headers: { "content-type": "image/png" } }),
  );
  await assert.rejects(
    client.render({ engine: "mermaid", format: "png", source: "A-->B" }),
    /invalid PNG/,
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "diagram-output-"));
  assert.throws(() => resolveWorkspaceOutput(root, `..${path.sep}outside.svg`), /inside the workspace/);
  assert.equal(resolveWorkspaceOutput(root, path.join("generated", "a.svg")), path.join(root, "generated", "a.svg"));
});

test("turns network failures into an actionable connection error", async () => {
  const client = new GatewayClient("https://diagrams.example.test", undefined, async () => {
    throw new TypeError("private socket detail");
  });
  await assert.rejects(
    client.health(),
    (error: Error & { code?: string }) =>
      error.code === "GATEWAY_UNREACHABLE"
      && /URL, network, TLS, and service health/.test(error.message)
      && !error.message.includes("private socket detail"),
  );
});
