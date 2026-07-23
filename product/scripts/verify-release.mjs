import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await readFile(path.join(productRoot, "package.json"), "utf8"));
const tag = `product-v${packageManifest.version}`;
const releaseDirectory = path.join(productRoot, "release", tag);
const manifest = JSON.parse(await readFile(path.join(releaseDirectory, "manifest.json"), "utf8"));

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

if (manifest.version !== packageManifest.version || manifest.tag !== tag) {
  throw new Error("Release manifest version/tag does not match package.json");
}
if (manifest.configurationSchemaVersion !== 1) {
  throw new Error("Release manifest must lock .diagram.yml schema version 1");
}
for (const component of ["gateway", "kroki", "mermaid"]) {
  const image = manifest.images?.[component];
  if (!image?.reference?.includes("diagram-as-code-") || image.tag !== tag) {
    throw new Error(`Release manifest does not pin the ${component} image to ${tag}`);
  }
}

for (const artifact of manifest.artifacts) {
  const content = await readFile(path.join(releaseDirectory, artifact.name));
  if (content.byteLength !== artifact.bytes || sha256(content) !== artifact.sha256) {
    throw new Error(`Release artifact does not match manifest: ${artifact.name}`);
  }
  if (artifact.name.endsWith(".spdx.json")) {
    const sbom = JSON.parse(content.toString("utf8"));
    if (sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.packages)) {
      throw new Error(`Release artifact is not a valid SPDX document: ${artifact.name}`);
    }
  }
}

const checksumSource = await readFile(path.join(releaseDirectory, "SHA256SUMS"), "utf8");
const checksumEntries = new Map(checksumSource.trim().split(/\r?\n/).map((line) => {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) throw new Error(`Invalid checksum line: ${line}`);
  return [match[2], match[1]];
}));
for (const [name, expected] of checksumEntries) {
  const filePath = path.join(releaseDirectory, name);
  await stat(filePath);
  if (sha256(await readFile(filePath)) !== expected) {
    throw new Error(`SHA256SUMS mismatch: ${name}`);
  }
}

console.log(`Verified ${tag}: ${manifest.artifacts.length} artifacts and ${checksumEntries.size} checksums`);
