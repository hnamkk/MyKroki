import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(productRoot, "..");
const outputDirectory = path.join(productRoot, "test-results");
const outputPath = path.join(outputDirectory, "product-npm.spdx.json");
const npmExecutable = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
const npmArguments = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm sbom --sbom-format=spdx"]
  : ["sbom", "--sbom-format=spdx"];

const sbom = execFileSync(npmExecutable, npmArguments, {
  cwd: productRoot,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});

const document = JSON.parse(sbom);
if (document.spdxVersion !== "SPDX-2.3" || !Array.isArray(document.packages)) {
  throw new Error("npm produced an invalid SPDX document");
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const epochSource = process.env.SOURCE_DATE_EPOCH ?? execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const epoch = Number(epochSource);
if (!/^[a-f0-9]{40}$/.test(commit) || !Number.isSafeInteger(epoch) || epoch <= 0) {
  throw new Error("Cannot derive reproducible SBOM metadata from the Git commit");
}
document.documentNamespace =
  `https://spdx.org/spdxdocs/${encodeURIComponent(document.name)}-${commit}`;
document.creationInfo.created = new Date(epoch * 1_000).toISOString();

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`Prepared npm SBOM at ${outputPath}`);
