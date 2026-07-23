import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import * as vscode from "vscode";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async (): Promise<void> => {
      if (await predicate()) {
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.`));
      } else {
        setTimeout(() => void check(), 50);
      }
    };
    void check();
  });
}

async function replaceDocument(document: vscode.TextDocument, source: string): Promise<void> {
  const editor = await vscode.window.showTextDocument(document);
  const lastLine = document.lineAt(document.lineCount - 1);
  const range = new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);
  assert.equal(await editor.edit((builder) => builder.replace(range, source)), true);
}

function startGateway(): Promise<{ server: Server; url: string; requests: string[] }> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/health/ready") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          status: "up",
          service: "diagram-gateway",
          version: "e2e",
          timestamp: new Date().toISOString(),
          checks: [],
        }));
        return;
      }
      if (request.url === "/api/v1/engines") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          apiVersion: "v1",
          generatedAt: new Date().toISOString(),
          engines: [{
            id: "mermaid",
            aliases: [],
            version: "e2e",
            formats: ["svg", "png"],
            available: true,
          }],
        }));
        return;
      }
      if (request.url !== "/api/v1/render" || request.method !== "POST") {
        response.statusCode = 404;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          source: string;
          format: "svg" | "png";
        };
        requests.push(body.source);
        const respond = (): void => {
          if (body.source.includes("INVALID")) {
            response.statusCode = 422;
            response.setHeader("content-type", "application/problem+json");
            response.end(JSON.stringify({
              type: "/problems/diagram-syntax-error",
              title: "Invalid diagram",
              status: 422,
              code: "DIAGRAM_SYNTAX_ERROR",
              message: "Mock syntax error",
              requestId: "vscode-e2e",
              line: 2,
              column: 3,
            }));
            return;
          }
          if (body.format === "png") {
            response.setHeader("content-type", "image/png");
            response.end(PNG);
            return;
          }
          response.setHeader("content-type", "image/svg+xml");
          response.end(`<svg xmlns="http://www.w3.org/2000/svg"><text>${body.source.length}</text></svg>`);
        };
        if (body.source.includes("SLOW")) {
          setTimeout(respond, 500);
        } else {
          respond();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Mock Gateway did not bind a TCP port.");
      resolve({ server, url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

export async function run(): Promise<void> {
  console.log("Starting Diagram as Code Extension Host E2E.");
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "E2E workspace must be open.");
  const gateway = await startGateway();
  try {
    await vscode.workspace.getConfiguration("diagramAsCode", folder.uri).update(
      "gatewayUrl",
      gateway.url,
      vscode.ConfigurationTarget.Workspace,
    );
    const extension = vscode.extensions.getExtension("diagram-as-code.diagram-as-code-vscode");
    assert.ok(extension, "Extension must be installed and discoverable.");
    await extension.activate();
    console.log("Extension activated.");

    const sourceUri = vscode.Uri.joinPath(folder.uri, "diagrams", "flow.mmd");
    const document = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, "diagram-mermaid");

    await replaceDocument(document, "flowchart LR\n  Source --> Preview\n");
    await document.save();
    const svgUri = vscode.Uri.joinPath(folder.uri, "generated", "flow.svg");
    await assert.rejects(vscode.workspace.fs.stat(svgUri));

    await vscode.commands.executeCommand("diagramAsCode.preview", sourceUri);
    await vscode.commands.executeCommand("diagramAsCode.exportSvg", sourceUri);
    assert.match(Buffer.from(await vscode.workspace.fs.readFile(svgUri)).toString("utf8"), /<svg/);

    await vscode.commands.executeCommand("diagramAsCode.exportPng", sourceUri);
    const pngUri = vscode.Uri.joinPath(folder.uri, "generated", "flow.png");
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(pngUri)), PNG);
    console.log("SVG and PNG export passed.");

    await replaceDocument(document, "flowchart LR\n  INVALID");
    await vscode.commands.executeCommand("diagramAsCode.exportSvg", sourceUri);
    await waitFor("syntax-error diagnostic", () => vscode.languages.getDiagnostics(sourceUri).length === 1);
    const diagnostic = vscode.languages.getDiagnostics(sourceUri)[0];
    assert.equal(diagnostic?.range.start.line, 1);
    assert.equal(diagnostic?.range.start.character, 2);
    console.log("Diagnostics mapping passed.");

    await replaceDocument(document, "flowchart LR\n  Fixed --> Valid");
    await vscode.commands.executeCommand("diagramAsCode.exportSvg", sourceUri);
    assert.equal(vscode.languages.getDiagnostics(sourceUri).length, 0);
    console.log("Diagnostic clearing passed.");

    await replaceDocument(document, "flowchart LR\n  SLOW INVALID");
    await waitFor(
      "the delayed preview request",
      () => gateway.requests.some((source) => source.includes("SLOW INVALID")),
    );
    await replaceDocument(document, "flowchart LR\n  Latest --> Valid");
    await waitFor("the latest preview response", () =>
      gateway.requests.some((source) => source.includes("Latest --> Valid"))
      && vscode.languages.getDiagnostics(sourceUri).length === 0
    );
    console.log("Stale preview response suppression passed.");

    const configUri = vscode.Uri.joinPath(folder.uri, ".diagram.yml");
    const config = Buffer.from(await vscode.workspace.fs.readFile(configUri))
      .toString("utf8")
      .replace("onSave: false", "onSave: true");
    await vscode.workspace.fs.writeFile(configUri, Buffer.from(config));
    await replaceDocument(document, "flowchart LR\n  Save --> Generated");
    const expectedSourceLength = document.getText().length;
    await document.save();
    await waitFor(
      "the render-on-save Gateway request",
      () => gateway.requests.some((source) => source.includes("Save --> Generated")),
    );
    await waitFor("render-on-save output", async () => {
      try {
        const currentOutput = Buffer.from(await vscode.workspace.fs.readFile(svgUri)).toString("utf8");
        return currentOutput.includes(`>${expectedSourceLength}<`);
      } catch {
        return false;
      }
    });
    const lastGood = Buffer.from(await vscode.workspace.fs.readFile(svgUri));
    assert.match(lastGood.toString("utf8"), new RegExp(`>${expectedSourceLength}<`));

    await replaceDocument(document, "flowchart LR\n  INVALID");
    await document.save();
    await waitFor(
      "render-on-save syntax-error diagnostic",
      () => vscode.languages.getDiagnostics(sourceUri).length === 1,
    );
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(svgUri)), lastGood);
    console.log("Render-on-save atomicity passed.");

    await vscode.commands.executeCommand("diagramAsCode.checkConnection", sourceUri);
    console.log("Diagram as Code Extension Host E2E passed.");
  } finally {
    await new Promise<void>((resolve, reject) => {
      gateway.server.close((error) => error ? reject(error) : resolve());
    });
  }
}
