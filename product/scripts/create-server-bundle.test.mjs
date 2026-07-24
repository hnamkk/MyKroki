import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServerBundle } from "./create-server-bundle.mjs";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("creates a Windows server ZIP with installer, loopback compose override, and manifest", async () => {
  const releaseDirectory = await mkdtemp(path.join(os.tmpdir(), "diagram-server-bundle-"));
  const output = await createServerBundle({
    productRoot,
    releaseDirectory,
    version: "0.1.0-test",
    images: { gateway: "gateway:test", kroki: "kroki:test", mermaid: "mermaid:test" },
  });
  const archive = await readFile(output);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  for (const name of ["diagram-server.ps1", "DiagramServer.psm1", "docker-compose.windows.yml", "server-manifest.json"]) {
    assert.ok(archive.includes(Buffer.from(name)), `missing ${name}`);
  }
  assert.ok(archive.includes(Buffer.from("127.0.0.1:9000")));
});
