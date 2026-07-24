import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
  "package.json",
  "packages/contracts/package.json",
  "packages/diagram-config/package.json",
  "gateway/package.json",
  "vscode-extension/package.json",
  "github-action/package.json",
];

test("locks package versions, release notes, and Windows bundle tooling together", async () => {
  const manifests = await Promise.all(packagePaths.map(async (relativePath) =>
    JSON.parse(await readFile(path.join(productRoot, relativePath), "utf8"))));
  const [product] = manifests;
  assert.equal(new Set(manifests.map((manifest) => manifest.version)).size, 1);
  await readFile(path.join(productRoot, "docs", "releases", `${product.version}.md`), "utf8");
  const scripts = product.scripts;
  assert.match(scripts["test:server-bundle"], /create-server-bundle/);
  assert.match(scripts["release:prepare"], /test:server-bundle/);
  const windowsCompose = await readFile(path.join(productRoot, "deploy", "docker-compose.windows.yml"), "utf8");
  assert.match(windowsCompose, /ports:\s*!override/);
  assert.match(windowsCompose, /127\.0\.0\.1:\$\{GATEWAY_PORT:-9000\}:9000/);
});
