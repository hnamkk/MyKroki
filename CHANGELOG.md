# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes land in the `Unreleased` section as part of the pull request that introduces them.
On release, the [Release workflow](.github/workflows/release.yml) rolls this section into a
versioned entry and uses it as the GitHub release notes.

## [Unreleased]

### Added

- Integrate the Diagram as Code product workspace with its Fastify Gateway, shared contracts, VS Code extension, GitHub Action, deployment files, and product CI/release workflows.
- Standardize `.diagram.yml` with a shared JSON Schema and output planner, align Gateway and clients to the OpenAPI v1 routes, and add per-principal rate limiting.
- Harden the Gateway production boundary with hashed API-key records and scopes, partitioned weighted TTL cache with failure degradation, bounded render concurrency, response-size limits, SVG sanitization, PNG/content-type validation, structured redacted events, and aggregate Prometheus metrics.
- Publish real per-engine renderer versions and isolated availability with deterministic capability caching, add SVG/PNG/C4/DOT acceptance and determinism gates, neutralize unsafe PlantUML includes, normalize renderer diagnostics without internal stack traces, and reap CLI process trees on timeout.
- Complete the GitHub Action MVP with strict inputs and workspace path guards, read-only stale/orphan checks, renderer annotations, safe preview artifacts, API-key masking, Gateway failure taxonomy, changed-file planning, and transactional generate mode guarded from pull requests.

### Changed

- Reduce container CI time by fixing the false multi-architecture build condition, loading native images only once before smoke tests, persisting BuildKit layers with a stable Docker-input cache key, and bounding the build and smoke-test steps with diagnostics on failure.
- Make Product CI build Kroki and Mermaid from the same checkout, trigger on fork/renderer changes, bound every E2E stage, and persist fork image layers.
- Make Node SEA renderer stages reproducible with lockfile installs, optional native tooling, and host-independent lint input.

### Fixed

- Make the bundled GitHub Action start correctly on the Node.js 24 runner by preserving `import.meta.url` semantics in its CommonJS bundle.

## [0.31.1] - 2026-07-15

### Changed

- Update Node.js base Docker images to 24.18 (Alpine) and 24.17 (Bookworm) ([#2093](https://github.com/yuzutech/kroki/pull/2093))

### Fixed

- Preserve leading whitespace of the first line in GoAT diagrams ([#2086](https://github.com/yuzutech/kroki/pull/2086))

### Diagram libraries

- Update blockdiag to 3.4.2 ([#2085](https://github.com/yuzutech/kroki/pull/2085))

## [0.31.0] - 2026-06-11

This release adds support for GoAT diagrams and brings back the ELK and tidy-tree layouts in Mermaid 🎉

### Added

- Integrate GoAT (Go ASCII diagrams) ([#2033](https://github.com/yuzutech/kroki/pull/2033))
- Support ELK and tidy-tree alternate layouts in Mermaid ([#2080](https://github.com/yuzutech/kroki/pull/2080))

### Fixed

- Prevent browser leak and bound resource usage in companion containers ([#2076](https://github.com/yuzutech/kroki/pull/2076))

### Diagram libraries

- blockdiag (actdiag, nwdiag, packetdiag, rackdiag, seqdiag) 3.3.0
- BPMN 18.18.0
- diagrams.net 29.6.1
- Excalidraw 0.18.1
- GraphViz 14.1.3
- Mermaid 11.15.0
- PlantUML (and C4) 1.2026.6
- Structurizr 6.2.1
- Vega-Lite 6.4.3
- WaveDrom 3.6.1
