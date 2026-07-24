import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { comparePilotOutputs } from "./pilot-output-verifier.mjs";
import { writeJsonReport } from "./quality-utils.mjs";

const execFile = promisify(execFileCallback);
const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.dirname(productRoot);
const generatedPath = "product/examples/pilot-repository/generated";
const reportPath = process.env.PILOT_REPRODUCIBILITY_REPORT
  ?? path.join(productRoot, "test-results", "pilot-reproducibility.json");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  }));
  return files.flat();
}

const { stdout } = await execFile(
  "git",
  ["ls-tree", "-r", "--name-only", "HEAD", "--", generatedPath],
  { cwd: repositoryRoot, encoding: "utf8" },
);
const expectedPaths = stdout.split(/\r?\n/u).filter((entry) => entry.endsWith(".svg"));
const actualPaths = (await walk(path.join(repositoryRoot, generatedPath)))
  .filter((entry) => entry.endsWith(".svg"))
  .map((entry) => path.relative(repositoryRoot, entry).replaceAll("\\", "/"));
const allPaths = [...new Set([...expectedPaths, ...actualPaths])].sort();

const entries = await Promise.all(allPaths.map(async (filePath) => {
  let expected = null;
  if (expectedPaths.includes(filePath)) {
    ({ stdout: expected } = await execFile("git", ["show", `HEAD:${filePath}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    }));
  }

  let actual = null;
  if (actualPaths.includes(filePath)) {
    actual = await readFile(path.join(repositoryRoot, filePath));
  }
  return { path: filePath, expected, actual };
}));

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ...comparePilotOutputs(entries),
};
await writeJsonReport(reportPath, report);

for (const file of report.files.filter((entry) => entry.status !== "match")) {
  const message = [
    `Pilot output ${file.status}`,
    `expected=${file.expectedSha256 ?? "none"}`,
    `actual=${file.actualSha256 ?? "none"}`,
  ].join("; ");
  console.error(`::error file=${file.path}::${message}`);
}

if (report.expectedOutputCount !== 4) {
  console.error(`::error::Expected four committed pilot SVG outputs, found ${report.expectedOutputCount}`);
}
if (report.actualOutputCount !== 4) {
  console.error(`::error::Expected four generated pilot SVG outputs, found ${report.actualOutputCount}`);
}

if (report.status !== "passed" || report.expectedOutputCount !== 4 || report.actualOutputCount !== 4) {
  process.exitCode = 1;
} else {
  console.log(`Verified ${report.actualOutputCount} reproducible pilot outputs; report: ${reportPath}`);
}
