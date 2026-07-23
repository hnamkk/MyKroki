import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";
import { parseDiagramConfig } from "@diagram-as-code/diagram-config";
import fastGlob from "fast-glob";

import { uploadPreviewArtifact } from "./artifact.js";
import { resolveGatewayCredential } from "./auth-provider.js";
import { parseActionInputs, parseNameStatus, resolveWithinRoot, type FileChange } from "./core.js";
import { renderDiagram } from "./gateway-client.js";
import { createRenderRequest, runAction, type ActionOutcome, type RunActionResult } from "./runner.js";

interface PullRequestEvent {
  pull_request?: {
    number?: number;
    base?: { sha?: string };
    head?: { repo?: { fork?: boolean } };
  };
}

function readEvent(): PullRequestEvent {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return {};
  try {
    return JSON.parse(readFileSync(eventPath, "utf8")) as PullRequestEvent;
  } catch {
    return {};
  }
}

function isPullRequest(): boolean {
  return (process.env.GITHUB_EVENT_NAME ?? "").startsWith("pull_request");
}

function readChanges(event: PullRequestEvent): FileChange[] | undefined {
  const baseSha = event.pull_request?.base?.sha;
  const baseRef = process.env.GITHUB_BASE_REF;
  const base = baseSha && /^[0-9a-f]{40}$/i.test(baseSha) ? baseSha : baseRef ? `origin/${baseRef}` : undefined;
  if (!base) return undefined;
  const range = `${base}...HEAD`;
  try {
    const output = execFileSync("git", ["diff", "--name-status", "-M", range], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseNameStatus(output);
  } catch {
    core.warning(`Could not diff ${range}; checking all diagram sources instead.`);
    return undefined;
  }
}

function pullRequestFilesUrl(event: PullRequestEvent): string | undefined {
  const repository = process.env.GITHUB_REPOSITORY;
  const number = event.pull_request?.number;
  return repository && number
    ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/pull/${number}/files`
    : undefined;
}

function outcomeLabel(outcome: ActionOutcome): string {
  return outcome.status === "error" && outcome.code ? `${outcome.status} (${outcome.code})` : outcome.status;
}

async function writeSummary(result: RunActionResult, mode: "check" | "generate", filesUrl?: string): Promise<void> {
  const headline = mode === "check"
    ? result.failed
      ? "Diagram check requires attention."
      : `All ${result.checkedCount} checked diagram(s) are current.`
    : result.failed
      ? "Diagram generation failed; the workspace was not changed."
      : `Generated ${result.changedCount} diagram artifact change(s).`;
  core.summary.addHeading("Diagram as Code").addRaw(`${headline}\n`);
  if (result.outcomes.length > 0) {
    core.summary.addTable([
      [
        { data: "Status", header: true },
        { data: "Source", header: true },
        { data: "Generated output", header: true },
        { data: "Request", header: true },
      ],
      ...result.outcomes.map((item) => [
        outcomeLabel(item),
        item.sourcePath ? `\`${item.sourcePath}\`` : "-",
        `\`${item.outputPath}\``,
        item.requestId ?? "-",
      ]),
    ]);
  }
  if (filesUrl) core.summary.addRaw(`\n[Open the pull request file diff](${filesUrl})\n`);
  await core.summary.write();
}

async function run(): Promise<void> {
  const root = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const inputs = parseActionInputs({
    "gateway-url": core.getInput("gateway-url"),
    "api-key": core.getInput("api-key"),
    "auth-mode": core.getInput("auth-mode"),
    "oidc-audience": core.getInput("oidc-audience"),
    "config-path": core.getInput("config-path"),
    mode: core.getInput("mode"),
    "changed-only": core.getInput("changed-only"),
    "artifact-name": core.getInput("artifact-name"),
    "fail-on-stale": core.getInput("fail-on-stale"),
  });
  const gatewayCredential = await resolveGatewayCredential(inputs, {
    getIdToken: (audience) => core.getIDToken(audience),
    setSecret: (value) => core.setSecret(value),
    warning: (message) => core.warning(message),
  });

  const event = readEvent();
  if (inputs.mode === "generate" && isPullRequest()) {
    const forkHint = event.pull_request?.head?.repo?.fork ? " Fork pull requests do not receive repository secrets." : "";
    throw new Error(`Mode 'generate' is disabled for pull_request events. Run it from a trusted push or workflow_dispatch event.${forkHint}`);
  }

  const config = parseDiagramConfig(readFileSync(resolveWithinRoot(root, inputs.configPath), "utf8"));
  const allSources = (await fastGlob(config.sources, { cwd: root, onlyFiles: true, dot: false }))
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
  const generatedFiles = (await fastGlob(`${config.output.replace(/\/$/, "")}/**/*.{svg,png}`, {
    cwd: root,
    onlyFiles: true,
    dot: false,
  })).map((file) => file.replaceAll("\\", "/")).sort();

  const useChangedFiles = inputs.changedOnly && isPullRequest();
  const changes = useChangedFiles ? readChanges(event) : undefined;
  const normalizedConfigPath = inputs.configPath.replaceAll("\\", "/");
  const renderingInputsChanged = changes?.some((change) =>
    change.path.replaceAll("\\", "/") === normalizedConfigPath
    || change.path.replaceAll("\\", "/") === ".diagram-renderer.lock"
  ) ?? true;
  const forceAll = !useChangedFiles || changes === undefined || renderingInputsChanged;

  const result = await runAction(
    { root, config, inputs, allSources, generatedFiles, changes: changes ?? [], forceAll },
    {
      render: (sourcePath, source, diagramConfig) =>
        renderDiagram(inputs.gatewayUrl, gatewayCredential, createRenderRequest(sourcePath, source, diagramConfig)),
      publish: uploadPreviewArtifact,
      reporter: {
        error: (message, properties) => core.error(message, properties),
        warning: (message) => core.warning(message),
      },
    },
  );

  core.setOutput("checked-count", result.checkedCount);
  core.setOutput("stale-count", result.staleCount);
  core.setOutput("generated-count", result.changedCount);
  await writeSummary(result, inputs.mode, pullRequestFilesUrl(event));
  if (result.failed) {
    core.setFailed(
      result.errorCount > 0
        ? `${result.errorCount} diagram(s) failed to render. See annotations and the preview artifact for details.`
        : `${result.staleCount} generated diagram(s) are missing, stale, or orphaned.`,
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
