# Changelog

## Unreleased

- Add Problems diagnostics with renderer line/column mapping and automatic clearing.
- Add deterministic SVG/PNG export, optional safe render-on-save, and workspace/symlink output guards.
- Add Gateway health/engine discovery, actionable connection checks, and supported-format selection.
- Add zoom, fit, and reset controls under a nonce-based strict webview CSP.
- Add packaged VSIX installation and Extension Host E2E coverage for minimum and current VS Code versions.
- Fix Windows Extension Host flakiness by isolating VS Code mutexes and separating preview/render-on-save request lanes.

## 0.1.0

- Add Gateway-backed live preview for five dedicated diagram file extensions.
- Add stable, atomic SVG export and SecretStorage API keys.
- Add labeled status bar actions plus editor, preview-title, and context-menu controls for preview and export workflows.
