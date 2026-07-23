import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  downloadAndUnzipVSCode,
  runTests,
  runVSCodeCommand,
} from "@vscode/test-electron";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.VSCODE_TEST_VERSION || "stable";
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "diagram-vscode-e2e-"));
const workspace = path.join(temporaryRoot, "workspace");
const extensionsDirectory = path.join(temporaryRoot, "extensions");
const userDataDirectory = path.join(temporaryRoot, "user-data");
const vsix = path.join(extensionRoot, "dist", "diagram-as-code-vscode.vsix");

async function isolateWindowsMutexes(vscodeExecutablePath) {
  if (process.platform !== "win32") return;

  // Archive builds share the same updater and singleton mutex names as the
  // preinstalled VS Code on hosted Windows runners unless product metadata is
  // isolated before invoking either the CLI or Extension Host.
  const executableRoot = path.dirname(vscodeExecutablePath);
  const entries = await readdir(executableRoot, { withFileTypes: true });
  const roots = [
    executableRoot,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => (
      path.join(executableRoot, entry.name)
    )),
  ];
  for (const root of roots) {
    const productJsonPath = path.join(root, "resources", "app", "product.json");
    try {
      const product = JSON.parse(await readFile(productJsonPath, "utf8"));
      product.win32VersionedUpdate = false;
      product.win32MutexName = `vscode-diagram-as-code-e2e-${process.pid}`;
      await writeFile(productJsonPath, `${JSON.stringify(product, null, 2)}\n`);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Could not find product.json below ${executableRoot}.`);
}

try {
  await cp(path.join(extensionRoot, "test", "fixtures", "workspace"), workspace, {
    recursive: true,
  });
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version });
  await isolateWindowsMutexes(vscodeExecutablePath);
  const profileArgs = [
    `--extensions-dir=${extensionsDirectory}`,
    `--user-data-dir=${userDataDirectory}`,
  ];
  await runVSCodeCommand(["--install-extension", vsix, "--force", ...profileArgs], {
    version,
    spawn: { stdio: "inherit" },
  });
  delete process.env.ELECTRON_RUN_AS_NODE;
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, "dist-test", "suite.cjs"),
    launchArgs: [
      workspace,
      ...profileArgs,
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
    ],
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
