import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsce = path.resolve(extensionRoot, "..", "node_modules", "@vscode", "vsce", "vsce");

execFileSync(process.execPath, [
  vsce,
  "package",
  "--no-dependencies",
  "--out",
  "dist/diagram-as-code-vscode.vsix",
], {
  cwd: extensionRoot,
  env: {
    ...process.env,
    SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "315532800",
  },
  stdio: "inherit",
});
