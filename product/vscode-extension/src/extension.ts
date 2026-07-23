import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  detectDiagramEngine,
  type OutputFormat,
  type RenderRequest,
} from "@diagram-as-code/contracts";
import {
  deterministicRenderRequest,
  outputPathForSource,
  parseDiagramConfig,
  type DiagramConfig,
} from "@diagram-as-code/diagram-config";
import * as vscode from "vscode";

import {
  GatewayClient,
  GatewayError,
  RenderCoordinator,
  resolveWorkspaceOutput,
  type EngineInfo,
  type RenderOutput,
} from "./core.js";

const SECRET_PREFIX = "diagramAsCode.apiKey:";
const SUPPORTED_EXTENSIONS = ".mmd, .puml, .plantuml, .dot, or .d2";

interface GatewayContext {
  apiKey: string | undefined;
  gatewayUrl: string;
}

interface ProjectContext extends GatewayContext {
  config: DiagramConfig;
  folder: vscode.WorkspaceFolder;
  relativePath: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function nonce(): string {
  return randomBytes(18).toString("base64");
}

function isSuperseded(error: unknown): boolean {
  return error instanceof Error && /superseded|aborted/i.test(error.message);
}

function previewHtml(output: RenderOutput, errorMessage?: string): string {
  const image = Buffer.from(output.bytes).toString("base64");
  const imageType = output.contentType === "image/png" ? "image/png" : "image/svg+xml";
  const token = nonce();
  const error = errorMessage
    ? `<div class="notice" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${token}'; script-src 'nonce-${token}';">
<style nonce="${token}">
html,body{height:100%;margin:0}body{background:var(--vscode-editor-background);color:var(--vscode-foreground);overflow:hidden;font-family:var(--vscode-font-family)}
.toolbar{position:fixed;z-index:2;top:8px;right:8px;display:flex;gap:4px;padding:4px;border:1px solid var(--vscode-widget-border);background:var(--vscode-editorWidget-background)}
button{width:30px;height:28px;padding:0;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer}
button:hover{background:var(--vscode-toolbar-hoverBackground)}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.viewport{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:48px 24px 24px;display:grid;place-items:center}
img{display:block;transform-origin:center;transition:transform 80ms ease-out}
.fit img{max-width:100%;max-height:100%;object-fit:contain}
.notice{position:fixed;z-index:3;left:12px;bottom:12px;max-width:min(720px,calc(100% - 24px));padding:8px 10px;border:1px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-inputValidation-errorForeground);white-space:pre-wrap}
</style></head>
<body><div class="toolbar" role="toolbar" aria-label="Preview zoom">
<button id="zoomOut" title="Zoom out" aria-label="Zoom out">&#8722;</button>
<button id="zoomIn" title="Zoom in" aria-label="Zoom in">+</button>
<button id="fit" title="Fit to view" aria-label="Fit to view">&#8596;</button>
<button id="reset" title="Reset zoom" aria-label="Reset zoom">1:1</button>
</div>
<div id="viewport" class="viewport fit"><img id="diagram" alt="Diagram preview" src="data:${imageType};base64,${image}"></div>${error}
<script nonce="${token}">
const viewport=document.getElementById("viewport");const diagram=document.getElementById("diagram");let scale=1;
const apply=()=>{viewport.classList.remove("fit");diagram.style.transform="scale("+scale+")"};
document.getElementById("zoomIn").addEventListener("click",()=>{scale=Math.min(4,scale+0.1);apply()});
document.getElementById("zoomOut").addEventListener("click",()=>{scale=Math.max(0.1,scale-0.1);apply()});
document.getElementById("fit").addEventListener("click",()=>{scale=1;diagram.style.transform="";viewport.classList.add("fit")});
document.getElementById("reset").addEventListener("click",()=>{scale=1;apply()});
</script></body></html>`;
}

function messageHtml(message: string): string {
  const token = nonce();
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${token}';">
<style nonce="${token}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px}.message{white-space:pre-wrap}</style>
</head><body><div class="message">${escapeHtml(message)}</div></body></html>`;
}

async function gatewayContext(
  extensionContext: vscode.ExtensionContext,
  resource?: vscode.Uri,
): Promise<GatewayContext> {
  const value = vscode.workspace
    .getConfiguration("diagramAsCode", resource)
    .get<string>("gatewayUrl", "http://localhost:9000")
    .trim();
  let gatewayUrl: string;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    gatewayUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error("diagramAsCode.gatewayUrl must be an HTTP(S) URL without embedded credentials.");
  }
  const storedKey = await extensionContext.secrets.get(`${SECRET_PREFIX}${gatewayUrl}`);
  return {
    gatewayUrl,
    apiKey: process.env.DIAGRAM_API_KEY ?? storedKey,
  };
}

async function readProjectContext(
  extensionContext: vscode.ExtensionContext,
  document: vscode.TextDocument,
): Promise<ProjectContext> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) throw new Error("Open the diagram inside a VS Code workspace.");

  const configName = vscode.workspace
    .getConfiguration("diagramAsCode", document.uri)
    .get<string>("configFile", ".diagram.yml");
  if (path.isAbsolute(configName) || configName.split(/[\\/]/).includes("..")) {
    throw new Error("diagramAsCode.configFile must remain inside the workspace.");
  }
  const configUri = vscode.Uri.joinPath(folder.uri, configName);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(configUri);
  } catch {
    throw new Error(`Cannot read ${configName}. Add the project configuration before rendering.`);
  }
  const config = parseDiagramConfig(Buffer.from(bytes).toString("utf8"));
  const relativePath = path.relative(folder.uri.fsPath, document.uri.fsPath).replaceAll("\\", "/");
  if (relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("Diagram source must remain inside its workspace folder.");
  }
  return {
    ...await gatewayContext(extensionContext, document.uri),
    config,
    folder,
    relativePath,
  };
}

class DiagnosticManager implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("diagram-as-code");

  clear(document: vscode.TextDocument): void {
    this.collection.delete(document.uri);
  }

  report(document: vscode.TextDocument, error: unknown): void {
    const gatewayError = error instanceof GatewayError ? error : undefined;
    const requestedLine = Math.max(1, gatewayError?.line ?? 1);
    const line = Math.min(requestedLine - 1, Math.max(0, document.lineCount - 1));
    const lineText = document.lineAt(line).text;
    const requestedColumn = Math.max(1, gatewayError?.column ?? 1);
    const column = Math.min(requestedColumn - 1, lineText.length);
    const end = Math.min(column + 1, Math.max(column, lineText.length));
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, column, line, end),
      error instanceof Error ? error.message : String(error),
      vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = "Diagram as Code";
    diagnostic.code = gatewayError?.code ?? "EXTENSION_ERROR";
    this.collection.set(document.uri, [diagnostic]);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

class PreviewSession implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private revision = 0;
  private lastOutput: RenderOutput | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly renderDocument: (document: vscode.TextDocument) => Promise<RenderOutput>,
    private readonly debounceMs: number,
    onDispose: () => void,
    onActivate: () => void,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.document.uri.toString()) this.schedule();
      }),
      panel.onDidDispose(() => {
        onDispose();
        this.dispose();
      }),
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) onActivate();
      }),
    );
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  schedule(delay = this.debounceMs): void {
    if (this.timer) clearTimeout(this.timer);
    const scheduledRevision = ++this.revision;
    this.timer = setTimeout(() => void this.update(scheduledRevision), delay);
  }

  async update(expectedRevision: number): Promise<void> {
    try {
      const output = await this.renderDocument(this.document);
      if (expectedRevision !== this.revision) return;
      this.lastOutput = output;
      this.panel.webview.html = previewHtml(output);
    } catch (error) {
      if (expectedRevision !== this.revision) return;
      if (isSuperseded(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.html = this.lastOutput
        ? previewHtml(this.lastOutput, message)
        : messageHtml(message);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

class DiagramController implements vscode.Disposable {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly coordinators = new Map<string, { fingerprint: string; coordinator: RenderCoordinator }>();
  private readonly diagnostics = new DiagnosticManager();
  private readonly saveListener: vscode.Disposable;
  private activePreviewResource: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
      if (detectDiagramEngine(document.uri.fsPath)) void this.renderOnSave(document);
    });
  }

  async render(document: vscode.TextDocument, formatOverride: OutputFormat = "svg"): Promise<RenderOutput> {
    if (!detectDiagramEngine(document.uri.fsPath)) {
      throw new Error(`The active file is not a supported ${SUPPORTED_EXTENSIONS} diagram.`);
    }
    try {
      const project = await readProjectContext(this.context, document);
      const request = deterministicRenderRequest(
        project.relativePath,
        document.getText(),
        project.config,
        formatOverride,
      );
      const resource = `${document.uri.toString()}\0${request.format}`;
      const fingerprint = `${project.gatewayUrl}\0${project.apiKey ?? ""}`;
      let entry = this.coordinators.get(resource);
      if (!entry || entry.fingerprint !== fingerprint) {
        const client = new GatewayClient(project.gatewayUrl, project.apiKey);
        entry = {
          fingerprint,
          coordinator: new RenderCoordinator((renderRequest, signal) => client.render(renderRequest, signal)),
        };
        this.coordinators.set(resource, entry);
      }
      const output = await entry.coordinator.render(resource, request);
      this.diagnostics.clear(document);
      return output;
    } catch (error) {
      if (!isSuperseded(error)) this.diagnostics.report(document, error);
      throw error;
    }
  }

  async preview(document: vscode.TextDocument): Promise<void> {
    const resource = document.uri.toString();
    const existing = this.sessions.get(resource);
    if (existing) {
      this.activePreviewResource = resource;
      existing.reveal();
      existing.schedule(0);
      return;
    }

    const project = await readProjectContext(this.context, document);
    const panel = vscode.window.createWebviewPanel(
      "diagramAsCode.preview",
      `Preview: ${path.basename(document.uri.fsPath)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    panel.webview.html = messageHtml("Rendering...");
    const session = new PreviewSession(
      document,
      panel,
      (current) => this.render(current, "svg"),
      project.config.preview.debounceMs,
      () => {
        this.sessions.delete(resource);
        if (this.activePreviewResource === resource) this.activePreviewResource = undefined;
      },
      () => { this.activePreviewResource = resource; },
    );
    this.sessions.set(resource, session);
    this.activePreviewResource = resource;
    session.schedule(0);
  }

  async refreshActivePreview(): Promise<void> {
    this.activePreviewSession().schedule(0);
  }

  async exportActivePreview(format?: OutputFormat): Promise<void> {
    const session = this.activePreviewSession();
    await this.export(session.document, format ?? await this.pickFormat(session.document));
  }

  async export(document: vscode.TextDocument, format?: OutputFormat): Promise<void> {
    await this.writeOutput(document, format ?? await this.pickFormat(document), true);
  }

  async checkConnection(resource?: vscode.Uri): Promise<void> {
    const gateway = await gatewayContext(this.context, resource);
    const client = new GatewayClient(gateway.gatewayUrl, gateway.apiKey, fetch, 10_000);
    try {
      const [health, catalog] = await Promise.all([client.health(), client.engines()]);
      const available = catalog.engines.filter((engine) => engine.available);
      const unavailable = catalog.engines.filter((engine) => !engine.available);
      const detail = [
        `${available.length}/${catalog.engines.length} engines available`,
        unavailable.length
          ? `Unavailable: ${unavailable.map((engine) => engine.id).join(", ")}`
          : undefined,
      ].filter(Boolean).join(". ");
      void vscode.window.showInformationMessage(
        `Diagram Gateway ${health.status} (${health.version}). ${detail}.`,
      );
    } catch (error) {
      const choice = await vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
        "Open Settings",
        "Set API Key",
      );
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "diagramAsCode.gatewayUrl");
      } else if (choice === "Set API Key") {
        await this.setApiKey(resource);
      }
    }
  }

  async setApiKey(resource?: vscode.Uri): Promise<void> {
    const gateway = await gatewayContext(this.context, resource);
    const apiKey = await vscode.window.showInputBox({
      title: "Diagram Gateway API Key",
      password: true,
      ignoreFocusOut: true,
      prompt: gateway.gatewayUrl,
    });
    if (apiKey === undefined) return;
    if (apiKey.trim() === "") {
      await this.context.secrets.delete(`${SECRET_PREFIX}${gateway.gatewayUrl}`);
      void vscode.window.showInformationMessage("Diagram Gateway API key removed from SecretStorage.");
      return;
    }
    await this.context.secrets.store(`${SECRET_PREFIX}${gateway.gatewayUrl}`, apiKey.trim());
    void vscode.window.showInformationMessage("Diagram Gateway API key stored in VS Code SecretStorage.");
  }

  dispose(): void {
    this.saveListener.dispose();
    this.diagnostics.dispose();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.coordinators.clear();
  }

  private async pickFormat(document: vscode.TextDocument): Promise<OutputFormat> {
    const project = await readProjectContext(this.context, document);
    const client = new GatewayClient(project.gatewayUrl, project.apiKey, fetch, 10_000);
    const catalog = await client.engines();
    const engine = detectDiagramEngine(document.uri.fsPath);
    const descriptor = catalog.engines.find((candidate) =>
      candidate.id === engine || candidate.aliases.includes(engine ?? "")
    );
    if (!descriptor) throw new Error(`Gateway does not advertise the '${engine}' renderer.`);
    if (!descriptor.available) {
      throw new Error(descriptor.unavailableReason
        ? `${descriptor.id} is unavailable: ${descriptor.unavailableReason}`
        : `${descriptor.id} is unavailable.`);
    }
    const selected = await vscode.window.showQuickPick(
      descriptor.formats.map((format) => ({
        label: format.toUpperCase(),
        description: format === "svg" ? "Scalable vector output" : "PNG bitmap output",
        format,
      })),
      { title: "Export Diagram", placeHolder: "Choose an output format" },
    );
    if (!selected) throw new Error("Diagram export was cancelled.");
    return selected.format;
  }

  private async renderOnSave(document: vscode.TextDocument): Promise<void> {
    try {
      const project = await readProjectContext(this.context, document);
      if (!project.config.render.onSave) return;
      const settings = deterministicRenderRequest(
        project.relativePath,
        document.getText(),
        project.config,
      );
      await this.writeOutput(document, settings.format, false, project);
    } catch (error) {
      this.diagnostics.report(document, error);
      void vscode.window.showErrorMessage(
        `Render on save failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async writeOutput(
    document: vscode.TextDocument,
    format: OutputFormat,
    announce: boolean,
    existingProject?: ProjectContext,
  ): Promise<void> {
    const project = existingProject ?? await readProjectContext(this.context, document);
    const outputRelativePath = outputPathForSource(project.relativePath, project.config, format);
    if (!outputRelativePath) {
      throw new Error("The active diagram is not included by .diagram.yml sources.");
    }
    const outputPath = resolveWorkspaceOutput(project.folder.uri.fsPath, outputRelativePath);
    const output = await this.render(document, format);
    const outputUri = vscode.Uri.file(outputPath);
    const temporaryUri = vscode.Uri.file(`${outputPath}.tmp-${process.pid}-${Date.now()}`);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outputPath)));
    try {
      await vscode.workspace.fs.writeFile(temporaryUri, output.bytes);
      await vscode.workspace.fs.rename(temporaryUri, outputUri, { overwrite: true });
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(temporaryUri);
      } catch {
        // A failed render/write must not disturb the last known-good output.
      }
      throw error;
    }
    if (announce) {
      void vscode.window.showInformationMessage(`Exported ${vscode.workspace.asRelativePath(outputUri)}`);
    }
  }

  private activePreviewSession(): PreviewSession {
    const session = this.activePreviewResource
      ? this.sessions.get(this.activePreviewResource)
      : undefined;
    if (!session) throw new Error("Focus a Diagram as Code preview first.");
    return session;
  }
}

class DiagramStatusBar implements vscode.Disposable {
  private readonly previewItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  private readonly exportItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly editorListener: vscode.Disposable;

  constructor() {
    this.previewItem.name = "Diagram Preview";
    this.previewItem.text = "$(eye) Preview";
    this.previewItem.tooltip = "Open Diagram Preview";
    this.previewItem.command = "diagramAsCode.preview";

    this.exportItem.name = "Diagram Export";
    this.exportItem.text = "$(export) Export";
    this.exportItem.tooltip = "Export Diagram";
    this.exportItem.command = "diagramAsCode.export";

    this.editorListener = vscode.window.onDidChangeActiveTextEditor(() => this.update());
    this.update();
  }

  dispose(): void {
    this.editorListener.dispose();
    this.previewItem.dispose();
    this.exportItem.dispose();
  }

  private update(): void {
    const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (filePath && detectDiagramEngine(filePath)) {
      this.previewItem.show();
      this.exportItem.show();
      return;
    }
    this.previewItem.hide();
    this.exportItem.hide();
  }
}

function activeDocument(): vscode.TextDocument {
  const document = vscode.window.activeTextEditor?.document;
  if (!document) throw new Error("Open a diagram source file first.");
  return document;
}

async function commandDocument(resource?: vscode.Uri): Promise<vscode.TextDocument> {
  if (!resource) return activeDocument();
  const active = vscode.window.activeTextEditor?.document;
  if (active?.uri.toString() === resource.toString()) return active;
  return vscode.workspace.openTextDocument(resource);
}

async function showCommandError(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new DiagramController(context);
  const statusBar = new DiagramStatusBar();
  context.subscriptions.push(
    controller,
    statusBar,
    vscode.commands.registerCommand("diagramAsCode.preview", (resource?: vscode.Uri) =>
      showCommandError(async () => controller.preview(await commandDocument(resource))),
    ),
    vscode.commands.registerCommand("diagramAsCode.export", (resource?: vscode.Uri) =>
      showCommandError(async () => controller.export(await commandDocument(resource))),
    ),
    vscode.commands.registerCommand("diagramAsCode.exportSvg", (resource?: vscode.Uri) =>
      showCommandError(async () => controller.export(await commandDocument(resource), "svg")),
    ),
    vscode.commands.registerCommand("diagramAsCode.exportPng", (resource?: vscode.Uri) =>
      showCommandError(async () => controller.export(await commandDocument(resource), "png")),
    ),
    vscode.commands.registerCommand("diagramAsCode.refreshPreview", () =>
      showCommandError(() => controller.refreshActivePreview()),
    ),
    vscode.commands.registerCommand("diagramAsCode.exportPreview", () =>
      showCommandError(() => controller.exportActivePreview()),
    ),
    vscode.commands.registerCommand("diagramAsCode.checkConnection", (resource?: vscode.Uri) =>
      controller.checkConnection(resource ?? vscode.window.activeTextEditor?.document.uri),
    ),
    vscode.commands.registerCommand("diagramAsCode.setApiKey", (resource?: vscode.Uri) =>
      showCommandError(() => controller.setApiKey(resource ?? vscode.window.activeTextEditor?.document.uri)),
    ),
  );
}

export function deactivate(): void {}
