# Diagram as Code for VS Code

The extension previews `.mmd`, `.puml`, `.plantuml`, `.dot`, and `.d2` files through a configured Diagram Gateway. It reports renderer errors in Problems, exports deterministic SVG/PNG, and can render the configured output safely on save.

## Setup

1. Add `.diagram.yml` at the workspace root. Start from `product/.diagram.example.yml`.
2. Set `diagramAsCode.gatewayUrl` to a local or hosted Gateway.
3. For an authenticated Gateway, run `Diagram: Set Gateway API Key`. The key is stored in VS Code SecretStorage. `DIAGRAM_API_KEY` is also supported for development environments.
4. Open a supported diagram and run `Diagram: Check Gateway Connection` to inspect health and renderer availability.

## Commands

- `Diagram: Open Preview` opens a live preview beside the editor.
- `Diagram: Export...` discovers formats supported by the selected renderer.
- `Diagram: Export SVG` and `Diagram: Export PNG` write directly to the deterministic output path from `.diagram.yml`.
- `Diagram: Check Gateway Connection` checks readiness and lists unavailable engines.
- `Diagram: Set Gateway API Key` stores the key in VS Code SecretStorage.

Preview waits for `preview.debounceMs`, cancels or ignores superseded requests, and keeps the last good image visible during a transient error. The preview toolbar supports zoom in, zoom out, fit-to-view, and reset. Renderer line/column errors appear in VS Code Problems and clear after a successful render.

`render.onSave` defaults to `false`. When enabled in `.diagram.yml`, saving writes the configured SVG/PNG through an adjacent temporary file and atomic rename. A render or write failure leaves the previous output unchanged.

When a supported diagram file is active, labeled `Preview` and `Export` buttons appear in the VS Code status bar. Icon buttons also appear in the diagram editor title, while an active preview has refresh and export buttons in its title bar. The same commands are available by right-clicking supported files in the editor or Explorer.

## Project configuration

The extension and GitHub Action use the same parser, deterministic request planner, engine overrides, and output path planner from `@diagram-as-code/diagram-config`. Gateway URL and credentials are intentionally excluded from `.diagram.yml`.

## Build and verify

```console
npm ci --prefix product
npm run typecheck --prefix product
npm test --prefix product
npm --prefix product --workspace=diagram-as-code-vscode run package
npm --prefix product --workspace=diagram-as-code-vscode run test:e2e
```

`VSCODE_TEST_VERSION=1.100.0` selects the minimum supported VS Code version; the default is the current Stable release.
