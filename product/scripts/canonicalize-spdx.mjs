import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(productRoot, "..");
const [input, component] = process.argv.slice(2);
if (!input || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(component ?? "")) {
  throw new Error("Usage: node scripts/canonicalize-spdx.mjs <path> <component>");
}

const absolutePath = path.resolve(repositoryRoot, input);
const relativePath = path.relative(repositoryRoot, absolutePath);
if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
  throw new Error("SPDX path must stay inside the repository");
}

const document = JSON.parse(await readFile(absolutePath, "utf8"));
if (document.spdxVersion !== "SPDX-2.3" || !Array.isArray(document.packages)) {
  throw new Error(`Invalid SPDX document: ${relativePath}`);
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
  throw new Error("Cannot derive reproducible SPDX metadata from the Git commit");
}

document.documentNamespace = `https://spdx.org/spdxdocs/diagram-as-code-${component}-${commit}`;
document.creationInfo.created = new Date(epoch * 1_000).toISOString();
await writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`Canonicalized ${relativePath}`);
