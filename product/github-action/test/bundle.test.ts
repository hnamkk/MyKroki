import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("committed CommonJS bundle starts under Node 24", () => {
  const result = spawnSync(process.execPath, ["dist/index.cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      "INPUT_GATEWAY-URL": "",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /Input 'gateway-url' is required\./);
  assert.doesNotMatch(output, /ERR_INVALID_ARG_VALUE|createRequire/);
});
