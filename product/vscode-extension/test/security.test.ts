import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionSource = readFileSync(
  new URL("../src/extension.ts", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  contributes: {
    configuration: {
      properties: Record<string, unknown>;
    };
  };
};

test("uses a strict preview CSP and no webview filesystem roots", () => {
  assert.match(extensionSource, /default-src 'none'/);
  assert.doesNotMatch(extensionSource, /unsafe-inline|unsafe-eval/);
  assert.match(extensionSource, /localResourceRoots: \[\]/);
  assert.match(extensionSource, /Buffer\.from\(output\.bytes\)\.toString\("base64"\)/);
});

test("keeps API keys out of contributed project settings", () => {
  const settings = Object.keys(manifest.contributes.configuration.properties);
  assert.deepEqual(settings.sort(), [
    "diagramAsCode.configFile",
    "diagramAsCode.gatewayUrl",
  ]);
  assert.match(extensionSource, /context\.secrets|extensionContext\.secrets/);
});
