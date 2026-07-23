import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTests, runVSCodeCommand } from "@vscode/test-electron";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.VSCODE_TEST_VERSION || "stable";
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "diagram-vscode-e2e-"));
const workspace = path.join(temporaryRoot, "workspace");
const vsix = path.join(extensionRoot, "dist", "diagram-as-code-vscode.vsix");

try {
  await cp(path.join(extensionRoot, "test", "fixtures", "workspace"), workspace, {
    recursive: true,
  });
  await runVSCodeCommand(["--install-extension", vsix, "--force"], {
    version,
    spawn: { stdio: "inherit" },
  });
  delete process.env.ELECTRON_RUN_AS_NODE;
  await runTests({
    version,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, "dist-test", "suite.cjs"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
    ],
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
