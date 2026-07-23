import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  deterministicRenderRequest,
  outputPathForSource,
  type DiagramConfig,
} from "@diagram-as-code/diagram-config";

export interface FileChange {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string;
}

export interface VerificationItem {
  sourcePath: string;
  outputPath: string;
  operation: "verify" | "remove";
}

export type ActionMode = "check" | "generate";
export type ActionAuthMode = "auto" | "oidc" | "api-key" | "none";

export interface ActionInputs {
  gatewayUrl: string;
  apiKey: string | undefined;
  authMode: ActionAuthMode;
  oidcAudience: string | undefined;
  configPath: string;
  mode: ActionMode;
  changedOnly: boolean;
  artifactName: string;
  failOnStale: boolean;
}

function normalize(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseBooleanInput(name: string, value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Input '${name}' must be 'true' or 'false'.`);
}

function assertSafeRelativePath(name: string, value: string): string {
  const normalized = normalize(value.trim());
  if (
    normalized === ""
    || path.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
  ) {
    throw new Error(`Input '${name}' must be a repository-relative path without '..'.`);
  }
  return normalized;
}

export function parseActionInputs(values: Record<string, string>): ActionInputs {
  const gatewayValue = values["gateway-url"]?.trim() ?? "";
  if (gatewayValue === "") throw new Error("Input 'gateway-url' is required.");
  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(gatewayValue);
  } catch {
    throw new Error("Input 'gateway-url' must be a valid HTTP(S) URL.");
  }
  if (!(["http:", "https:"] as string[]).includes(gatewayUrl.protocol) || gatewayUrl.username || gatewayUrl.password) {
    throw new Error("Input 'gateway-url' must be an HTTP(S) URL without embedded credentials.");
  }

  const mode = (values.mode?.trim().toLowerCase() || "check") as ActionMode;
  if (mode !== "check" && mode !== "generate") {
    throw new Error("Input 'mode' must be 'check' or 'generate'.");
  }
  const artifactName = values["artifact-name"]?.trim() || "diagram-previews";
  if (artifactName.length > 128 || /[\\/\x00-\x1f]/.test(artifactName)) {
    throw new Error("Input 'artifact-name' must be at most 128 characters and contain no path separators or control characters.");
  }
  const authMode = (values["auth-mode"]?.trim().toLowerCase() || "auto") as ActionAuthMode;
  if (!["auto", "oidc", "api-key", "none"].includes(authMode)) {
    throw new Error("Input 'auth-mode' must be 'auto', 'oidc', 'api-key', or 'none'.");
  }

  return {
    gatewayUrl: gatewayUrl.toString().replace(/\/$/, ""),
    apiKey: values["api-key"]?.trim() || undefined,
    authMode,
    oidcAudience: values["oidc-audience"]?.trim() || undefined,
    configPath: assertSafeRelativePath("config-path", values["config-path"] || ".diagram.yml"),
    mode,
    changedOnly: parseBooleanInput("changed-only", values["changed-only"] ?? "", true),
    artifactName,
    failOnStale: parseBooleanInput("fail-on-stale", values["fail-on-stale"] ?? "", true),
  };
}

export function resolveWithinRoot(root: string, relativePath: string): string {
  const safePath = assertSafeRelativePath("path", relativePath);
  const absoluteRoot = realpathSync(path.resolve(root));
  const absolutePath = path.resolve(absoluteRoot, safePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the repository workspace: ${relativePath}`);
  }
  let existingAncestor = absolutePath;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const resolvedAncestor = realpathSync(existingAncestor);
  const realRelative = path.relative(absoluteRoot, resolvedAncestor);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Path resolves outside the repository workspace: ${relativePath}`);
  }
  return absolutePath;
}

export function buildVerificationPlan(
  changes: FileChange[],
  allSources: string[],
  config: DiagramConfig,
  forceAll: boolean,
): VerificationItem[] {
  const items = new Map<string, VerificationItem>();
  const sourceByOutput = new Map<string, string>();
  for (const source of allSources) {
    const generated = outputPathForSource(source, config);
    if (generated) sourceByOutput.set(generated, normalize(source));
  }

  const add = (sourcePath: string, operation: VerificationItem["operation"]): void => {
    const generated = outputPathForSource(sourcePath, config);
    if (!generated) return;
    items.set(`${operation}:${normalize(sourcePath)}`, {
      sourcePath: normalize(sourcePath),
      outputPath: generated,
      operation,
    });
  };

  if (forceAll) {
    for (const source of allSources) add(source, "verify");
  } else {
    for (const change of changes) {
      if (change.status === "D") add(change.path, "remove");
      else if (change.status === "R") {
        if (change.oldPath) add(change.oldPath, "remove");
        add(change.path, "verify");
      } else {
        add(change.path, "verify");
      }
      const sourceForGenerated = sourceByOutput.get(normalize(change.path));
      if (sourceForGenerated) add(sourceForGenerated, "verify");
    }
  }

  const byOutput = new Map<string, VerificationItem>();
  for (const item of items.values()) {
    const current = byOutput.get(item.outputPath);
    if (!current || item.operation === "verify") byOutput.set(item.outputPath, item);
  }
  return [...byOutput.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

export function deterministicRequest(
  sourcePath: string,
  source: string,
  config: DiagramConfig,
): ReturnType<typeof deterministicRenderRequest> {
  return deterministicRenderRequest(sourcePath, source, config);
}

export function parseNameStatus(output: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [rawStatus, firstPath, secondPath] = line.split("\t");
    if (!rawStatus || !firstPath) continue;
    const status = rawStatus[0];
    if (status === "R" && secondPath) {
      changes.push({ status: "R", oldPath: firstPath, path: secondPath });
    } else if (status === "A" || status === "M" || status === "D") {
      changes.push({ status, path: firstPath });
    }
  }
  return changes;
}

export function findOrphanedOutputs(
  allSources: string[],
  generatedFiles: string[],
  config: DiagramConfig,
): VerificationItem[] {
  const expected = new Set(
    allSources
      .map((source) => outputPathForSource(source, config))
      .filter((value): value is string => value !== undefined)
      .map(normalize),
  );
  return generatedFiles
    .map(normalize)
    .filter((outputPath) => !expected.has(outputPath))
    .map((outputPath) => ({ sourcePath: "", outputPath, operation: "remove" as const }))
    .sort((a, b) => a.outputPath.localeCompare(b.outputPath));
}

export function assertUniqueOutputPaths(allSources: string[], config: DiagramConfig): void {
  const sourceByOutput = new Map<string, string>();
  for (const source of allSources) {
    const output = outputPathForSource(source, config);
    if (!output) continue;
    const existing = sourceByOutput.get(output);
    if (existing && existing !== normalize(source)) {
      throw new Error(`Diagram sources '${existing}' and '${normalize(source)}' map to the same output '${output}'.`);
    }
    sourceByOutput.set(output, normalize(source));
  }
}
