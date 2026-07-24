# Diagram as Code Server for Windows

This optional installer runs the version-locked Gateway, Kroki, and Mermaid stack on the local Windows machine through Docker Desktop. The release default is `http://127.0.0.1:9000`; a versioned manifest may choose another loopback port when that port is already in use.

## Install

1. Install and start Docker Desktop using Linux containers.
2. Download the versioned server ZIP and verify its SHA-256 against the `SHA256SUMS` file published with the release.
3. Extract the ZIP and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\diagram-server.ps1 install
```

The installer prints a Gateway URL and an API key once. Store the key in VS Code SecretStorage or the GitHub Actions secret; the managed `.env` stores only its SHA-256 verifier record.

## Operations

```powershell
.\diagram-server.ps1 status
.\diagram-server.ps1 logs -Tail 200
.\diagram-server.ps1 restart
.\diagram-server.ps1 rotate-key
.\diagram-server.ps1 rotate-key -Finalize
.\diagram-server.ps1 uninstall
```

To update, download and verify a newer server ZIP, extract it, then run its `diagram-server.ps1 update`. The previous package and configuration are backed up under `%LOCALAPPDATA%\DiagramAsCode\server\backups`; a failed readiness check restores that package automatically.

`uninstall` stops only the managed Compose project and retains configuration. Add `-Purge` only when configuration and verifier records can be removed permanently.
