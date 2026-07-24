import { createHash } from "node:crypto";

function digest(value) {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

export function comparePilotOutputs(entries) {
  const files = entries.map((entry) => {
    const expectedHash = digest(entry.expected);
    const actualHash = digest(entry.actual);
    let status = "match";
    if (entry.expected === null) status = "unexpected";
    else if (entry.actual === null) status = "missing";
    else if (!entry.expected.equals(entry.actual)) status = "drift";

    return {
      path: entry.path,
      status,
      expectedSha256: expectedHash,
      actualSha256: actualHash,
      expectedBytes: entry.expected?.byteLength ?? null,
      actualBytes: entry.actual?.byteLength ?? null,
    };
  });

  return {
    status: files.every((file) => file.status === "match") ? "passed" : "failed",
    expectedOutputCount: entries.filter((entry) => entry.expected !== null).length,
    actualOutputCount: entries.filter((entry) => entry.actual !== null).length,
    files,
  };
}
