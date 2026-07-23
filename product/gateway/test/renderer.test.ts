import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { InvalidRenderOutput, RenderOutputTooLarge } from "../dist/output-validator.js";
import {
  KrokiRenderer,
  RendererFailure,
  RendererTimeout,
  RendererUnavailable,
  parseRendererFailure,
  readResponseBody,
} from "../dist/renderer.js";

test("aborts a hanging backend and releases the client for a subsequent render", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    requests += 1;
    if (requests === 1) return;
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end("<svg><text>recovered</text></svg>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const renderer = new KrokiRenderer(`http://127.0.0.1:${address.port}`, 50, 1_000);
    await assert.rejects(
      renderer.render({ engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" }),
      RendererTimeout,
    );
    const recovered = await renderer.render({
      engine: "mermaid",
      format: "svg",
      source: "flowchart LR; B-->C",
    });
    assert.match(recovered.toString("utf8"), /recovered/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects renderer response from Content-Length before buffering", async () => {
  const response = new Response("small", { headers: { "content-length": "100" } });
  await assert.rejects(readResponseBody(response, 10), RenderOutputTooLarge);
});

test("stops streaming when renderer response crosses the byte limit", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  await assert.rejects(readResponseBody(new Response(stream), 10), RenderOutputTooLarge);
});

test("returns renderer response within the byte limit", async () => {
  const body = await readResponseBody(new Response("<svg/>"), 100);
  assert.equal(body.toString("utf8"), "<svg/>");
});

test("rejects a successful Kroki response with the wrong content type", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("<svg/>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  const renderer = new KrokiRenderer("http://kroki", 1_000, 1_000);
  await assert.rejects(
    renderer.render({ engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" }),
    InvalidRenderOutput,
  );
});

test("maps a broken Kroki response stream to renderer unavailable", async (context) => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  context.mock.method(globalThis, "fetch", async () => new Response(stream, {
    status: 200,
    headers: { "content-type": "image/svg+xml" },
  }));
  const renderer = new KrokiRenderer("http://kroki", 1_000, 1_000);
  await assert.rejects(
    renderer.render({ engine: "mermaid", format: "svg", source: "flowchart LR; A-->B" }),
    RendererUnavailable,
  );
});

test("normalizes JSON renderer errors and extracts source location", () => {
  const failure = parseRendererFailure(Buffer.from(JSON.stringify({
    error: { message: "syntax error in line 12, column 8\n    at /srv/kroki/worker.js:4:2" },
  })), "application/json");
  assert.ok(failure instanceof RendererFailure);
  assert.equal(failure.message, "syntax error in line 12, column 8");
  assert.equal(failure.line, 12);
  assert.equal(failure.column, 8);
  assert.doesNotMatch(failure.message, /\/srv\/|worker\.js|\bat\s/);
});

test("discovers independent engine versions and availability with a bounded cache", async (context) => {
  let healthCalls = 0;
  let mermaidAvailable = false;
  let now = 1_000;
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      healthCalls += 1;
      return Response.json({ version: {
        mermaid: "11.15.0", plantuml: "1.2026.6", c4plantuml: "1.2026.6",
        graphviz: "14.1.3", dot: "14.1.3", d2: "0.7.1",
      } });
    }
    if (url.includes("/mermaid/svg") && !mermaidAvailable) {
      return Response.json({ error: { message: "offline" } }, { status: 503 });
    }
    return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  });
  const renderer = new KrokiRenderer("http://kroki", 1_000, 10_000, "fallback", 10, () => now);
  const [first, concurrent] = await Promise.all([renderer.capabilities(), renderer.capabilities()]);
  assert.equal(first.find((engine) => engine.id === "mermaid")?.available, false);
  assert.equal(concurrent.find((engine) => engine.id === "mermaid")?.available, false);
  assert.equal(first.find((engine) => engine.id === "plantuml")?.available, true);
  assert.equal(first.find((engine) => engine.id === "graphviz")?.version, "14.1.3");
  assert.equal((await renderer.capabilities()).find((engine) => engine.id === "mermaid")?.available, false);
  assert.equal(healthCalls, 1);
  mermaidAvailable = true;
  now += 10;
  assert.equal((await renderer.capabilities()).find((engine) => engine.id === "mermaid")?.available, true);
  assert.equal(healthCalls, 2);
});
