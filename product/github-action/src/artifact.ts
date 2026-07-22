import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DefaultArtifactClient } from "@actions/artifact";

import { resolveWithinRoot } from "./core.js";
import type { ActionManifest, PreviewOutput } from "./runner.js";

export async function uploadPreviewArtifact(
  name: string,
  outputs: PreviewOutput[],
  manifest: ActionManifest,
): Promise<void> {
  const stagingParent = process.env.RUNNER_TEMP && existsSync(process.env.RUNNER_TEMP)
    ? process.env.RUNNER_TEMP
    : os.tmpdir();
  const stagingRoot = mkdtempSync(path.join(stagingParent, "diagram-action-"));
  try {
    const files: string[] = [];
    for (const output of outputs) {
      const target = resolveWithinRoot(stagingRoot, output.outputPath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, output.content);
      files.push(target);
    }
    const manifestPath = path.join(stagingRoot, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    files.push(manifestPath);
    await new DefaultArtifactClient().uploadArtifact(name, files, stagingRoot, { compressionLevel: 6 });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
