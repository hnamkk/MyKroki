import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("pilot generation builds runtime workspace packages after a clean install", async () => {
  const packageJson = JSON.parse(await readFile(path.join(productRoot, "package.json"), "utf8"));
  const prerequisite = packageJson.scripts["prepilot:generate"];

  assert.equal(typeof prerequisite, "string");
  const contractsBuild = "npm --workspace=@diagram-as-code/contracts run build";
  const configBuild = "npm --workspace=@diagram-as-code/diagram-config run build";
  assert.ok(prerequisite.includes(contractsBuild));
  assert.ok(prerequisite.includes(configBuild));
  assert.ok(
    prerequisite.indexOf(contractsBuild) < prerequisite.indexOf(configBuild),
    "contracts must build before diagram-config",
  );
});
