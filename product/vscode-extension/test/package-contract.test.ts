import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const manifestPath = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  publisher: string;
  icon: string;
  galleryBanner: { color: string; theme: string };
  files: string[];
  repository: { url: string };
};

test("declares Marketplace metadata and packages a real icon", () => {
  assert.match(manifest.publisher, /^[a-z0-9][a-z0-9-]{1,63}$/);
  assert.match(manifest.repository.url, /^https:\/\/github\.com\//);
  assert.match(manifest.galleryBanner.color, /^#[0-9a-f]{6}$/i);
  assert.equal(manifest.galleryBanner.theme, "dark");
  assert.ok(manifest.files.includes(manifest.icon));
  const icon = new URL(`../${manifest.icon}`, import.meta.url);
  assert.ok(existsSync(icon));
  assert.ok(statSync(icon).size > 512);
  assert.deepEqual(readFileSync(icon).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
