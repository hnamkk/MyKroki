import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { DiagramConfig } from "@diagram-as-code/diagram-config";

import {
  buildVerificationPlan,
  assertUniqueOutputPaths,
  deterministicRequest,
  findOrphanedOutputs,
  resolveWithinRoot,
  type ActionInputs,
  type FileChange,
  type VerificationItem,
} from "./core.js";
import { GatewayFailure } from "./gateway-client.js";
import { applyWorkspaceTransaction } from "./workspace.js";

export type OutcomeStatus = "current" | "missing" | "stale" | "orphaned" | "generated" | "error";

export interface ActionOutcome {
  sourcePath?: string;
  outputPath: string;
  status: OutcomeStatus;
  sha256?: string;
  code?: string;
  requestId?: string;
}

export interface PreviewOutput {
  outputPath: string;
  content: Buffer;
}

export interface ActionManifest {
  schemaVersion: 1;
  mode: ActionInputs["mode"];
  outcomes: ActionOutcome[];
}

export interface Reporter {
  error(message: string, properties: { file?: string; startLine?: number; startColumn?: number }): void;
  warning(message: string): void;
}

export interface RunDependencies {
  render(sourcePath: string, source: string, config: DiagramConfig): Promise<Buffer>;
  publish(name: string, outputs: PreviewOutput[], manifest: ActionManifest): Promise<void>;
  reporter: Reporter;
}

export interface RunActionOptions {
  root: string;
  config: DiagramConfig;
  inputs: ActionInputs;
  allSources: string[];
  generatedFiles: string[];
  changes?: FileChange[];
  forceAll: boolean;
}

export interface RunActionResult {
  checkedCount: number;
  staleCount: number;
  errorCount: number;
  changedCount: number;
  outcomes: ActionOutcome[];
  failed: boolean;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function generatedOutputEquals(outputPath: string, committed: Buffer, rendered: Buffer): boolean {
  if (!outputPath.toLowerCase().endsWith(".svg")) return committed.equals(rendered);
  const normalizeLineEndings = (content: Buffer) => content.toString("utf8").replaceAll("\r\n", "\n");
  return normalizeLineEndings(committed) === normalizeLineEndings(rendered);
}

function mergePlan(base: VerificationItem[], additions: VerificationItem[]): VerificationItem[] {
  const byOutput = new Map<string, VerificationItem>();
  for (const item of [...base, ...additions]) byOutput.set(item.outputPath, item);
  return [...byOutput.values()].sort((a, b) => a.outputPath.localeCompare(b.outputPath));
}

export async function runAction(options: RunActionOptions, dependencies: RunDependencies): Promise<RunActionResult> {
  const { root, config, inputs } = options;
  assertUniqueOutputPaths(options.allSources, config);
  const basePlan = buildVerificationPlan(options.changes ?? [], options.allSources, config, options.forceAll);
  const plan = options.forceAll
    ? mergePlan(basePlan, findOrphanedOutputs(options.allSources, options.generatedFiles, config))
    : basePlan;
  const outcomes: ActionOutcome[] = [];
  const previews: PreviewOutput[] = [];
  const mutations: Array<{ outputPath: string; content?: Buffer }> = [];

  for (const item of plan) {
    const absoluteOutput = resolveWithinRoot(root, item.outputPath);
    if (item.operation === "remove") {
      if (existsSync(absoluteOutput)) {
        outcomes.push({
          ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
          outputPath: item.outputPath,
          status: "orphaned",
        });
        if (inputs.mode === "generate") mutations.push({ outputPath: item.outputPath });
      }
      continue;
    }

    try {
      const source = readFileSync(resolveWithinRoot(root, item.sourcePath), "utf8");
      const output = await dependencies.render(item.sourcePath, source, config);
      previews.push({ outputPath: item.outputPath, content: output });
      const digest = sha256(output);
      const status = !existsSync(absoluteOutput)
        ? "missing"
        : generatedOutputEquals(item.outputPath, readFileSync(absoluteOutput), output)
          ? "current"
          : "stale";
      outcomes.push({ sourcePath: item.sourcePath, outputPath: item.outputPath, status, sha256: digest });
      if (inputs.mode === "generate" && status !== "current") {
        mutations.push({ outputPath: item.outputPath, content: output });
      }
    } catch (error) {
      const failure = error instanceof GatewayFailure ? error : undefined;
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        sourcePath: item.sourcePath,
        outputPath: item.outputPath,
        status: "error",
        code: failure?.code ?? "ACTION_RENDER_ERROR",
        ...(failure?.requestId ? { requestId: failure.requestId } : {}),
      });
      dependencies.reporter.error(message, {
        file: item.sourcePath,
        ...(failure?.line !== undefined ? { startLine: failure.line } : {}),
        ...(failure?.column !== undefined ? { startColumn: failure.column } : {}),
      });
    }
  }

  const errorCount = outcomes.filter((item) => item.status === "error").length;
  if (inputs.mode === "generate" && errorCount === 0) {
    applyWorkspaceTransaction(root, mutations);
    for (const outcome of outcomes) {
      if (outcome.status === "missing" || outcome.status === "stale" || outcome.status === "orphaned") {
        outcome.status = "generated";
      }
    }
  } else if (inputs.mode === "generate" && mutations.length > 0) {
    dependencies.reporter.warning("No generated files were written because at least one diagram failed to render.");
  }

  const manifest: ActionManifest = { schemaVersion: 1, mode: inputs.mode, outcomes };
  await dependencies.publish(inputs.artifactName, previews, manifest);

  const staleCount = outcomes.filter((item) =>
    item.status === "missing" || item.status === "stale" || item.status === "orphaned"
  ).length;
  return {
    checkedCount: plan.filter((item) => item.operation === "verify").length,
    staleCount,
    errorCount,
    changedCount: outcomes.filter((item) => item.status === "generated").length,
    outcomes,
    failed: errorCount > 0 || (inputs.mode === "check" && inputs.failOnStale && staleCount > 0),
  };
}

export function createRenderRequest(sourcePath: string, source: string, config: DiagramConfig) {
  return deterministicRequest(sourcePath, source, config);
}
