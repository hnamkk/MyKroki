import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { writeJsonReport } from "./quality-utils.mjs";

const execFileAsync = promisify(execFile);
const targets = (process.env.CONTAINER_POLICY_TARGETS ?? "")
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);
if (targets.length === 0) throw new Error("Set CONTAINER_POLICY_TARGETS to a comma-separated list of containers");

const { stdout } = await execFileAsync("docker", ["inspect", ...targets], { maxBuffer: 10 * 1024 * 1024 });
const inspections = JSON.parse(stdout);
const results = inspections.map((inspection) => {
  const user = inspection.Config?.User ?? "";
  const host = inspection.HostConfig ?? {};
  const checks = {
    nonRoot: user !== "" && user !== "0" && user !== "root",
    readOnlyRootFilesystem: host.ReadonlyRootfs === true,
    memoryLimit: Number(host.Memory) > 0,
    cpuLimit: Number(host.NanoCpus) > 0,
    processLimit: Number(host.PidsLimit) > 0,
    capabilitiesDropped: (host.CapDrop ?? []).includes("ALL"),
    noNewPrivileges: (host.SecurityOpt ?? []).includes("no-new-privileges:true"),
    restartPolicy: host.RestartPolicy?.Name === "unless-stopped",
  };
  return {
    name: String(inspection.Name ?? "").replace(/^\//, ""),
    image: inspection.Config?.Image,
    user,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
});

const report = { generatedAt: new Date().toISOString(), results, passed: results.every((result) => result.passed) };
await writeJsonReport(process.env.QUALITY_REPORT_PATH ?? "test-results/container-policy.json", report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) throw new Error("One or more rendering containers violate the runtime confinement policy");
