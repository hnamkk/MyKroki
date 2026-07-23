import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const separator = process.argv.indexOf("--");
if (separator < 0 || separator === process.argv.length - 1) {
  throw new Error("Usage: node repeat-test.mjs [--attempts N] [--timeout-ms N] [--report PATH] -- command [args...]");
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const attempts = Number(option("--attempts", "3"));
const timeoutMs = Number(option("--timeout-ms", "300000"));
const reportPath = option("--report", "test-results/flaky-control.json");
if (!Number.isSafeInteger(attempts) || attempts < 2) throw new Error("--attempts must be an integer >= 2");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
const [rawCommand, ...commandArgs] = process.argv.slice(separator + 1);
let command = rawCommand;
let spawnArgs = commandArgs;
if (process.platform === "win32" && rawCommand === "npm") {
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error(`Cannot locate npm CLI at ${npmCli}`);
  command = process.execPath;
  spawnArgs = [npmCli, ...commandArgs];
}
const results = [];

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(command, spawnArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: null, signal: null, timedOut, error: error.message });
    });
    child.on("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, timedOut });
    });
  });
  results.push({ attempt, durationMs: Date.now() - startedAt, ...result });
  if (result.exitCode !== 0 || result.timedOut) break;
}

const report = {
  generatedAt: new Date().toISOString(),
  command: [rawCommand, ...commandArgs],
  attemptsRequested: attempts,
  timeoutMs,
  quarantineAllowed: false,
  results,
  passed: results.length === attempts && results.every((result) => result.exitCode === 0 && !result.timedOut),
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
