BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\DiagramServer.psm1"
    Import-Module $modulePath -Force -DisableNameChecking
}

Describe "Diagram as Code Windows installer" {
    It "creates a random plaintext key and a verifier record without retaining the plaintext" {
        $key = New-DiagramApiKey
        $key.Plaintext | Should -Match "^dg_[A-Za-z0-9_-]{40,}$"
        $key.Record.verifier | Should -Match "^sha256:[a-f0-9]{64}$"
        ($key.Record | ConvertTo-Json -Compress) | Should -Not -Match [Regex]::Escape($key.Plaintext)
    }

    It "treats a missing verifier-record setting as an empty collection" {
        InModuleScope DiagramServer {
            $records = @(Get-DiagramKeyRecords -Environment @{})
            $records.Count | Should -Be 0
        }
    }

    It "accepts only a loopback server manifest with the required compose files" {
        $root = Join-Path $TestDrive "package"
        New-Item -ItemType Directory -Path $root | Out-Null
        Set-Content -LiteralPath (Join-Path $root "docker-compose.yml") -Value "services: {}" -NoNewline
        Set-Content -LiteralPath (Join-Path $root "docker-compose.windows.yml") -Value "services: {}" -NoNewline
        @{ schemaVersion = 1; productVersion = "0.1.0"; gatewayUrl = "http://127.0.0.1:9000"; images = @{ gateway = @{ reference = "gateway:test" }; kroki = @{ reference = "kroki:test" }; mermaid = @{ reference = "mermaid:test" } } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root "server-manifest.json")
        $manifest = Read-DiagramServerManifest -PackageRoot $root
        $manifest.productVersion | Should -Be "0.1.0"
        (@{ schemaVersion = 1; productVersion = "0.1.0"; gatewayUrl = "http://127.0.0.1:19000"; images = @{ gateway = @{ reference = "gateway:test" }; kroki = @{ reference = "kroki:test" }; mermaid = @{ reference = "mermaid:test" } } } | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $root "server-manifest.json")
        (Read-DiagramServerManifest -PackageRoot $root).gatewayUrl | Should -Be "http://127.0.0.1:19000"
        (@{ schemaVersion = 1; productVersion = "0.1.0"; gatewayUrl = "http://0.0.0.0:9000"; images = @{ gateway = @{ reference = "gateway:test" }; kroki = @{ reference = "kroki:test" }; mermaid = @{ reference = "mermaid:test" } } } | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $root "server-manifest.json")
        { Read-DiagramServerManifest -PackageRoot $root } | Should -Throw "*loopback*"
    }

    It "keeps all managed paths below the requested state root" {
        $root = Join-Path $TestDrive "DiagramAsCode\server"
        $paths = Get-DiagramServerPaths -StateRoot $root
        $paths.Package.StartsWith($paths.Root) | Should -BeTrue
        $paths.Backups.StartsWith($paths.Root) | Should -BeTrue
        $paths.EnvFile.StartsWith($paths.Root) | Should -BeTrue
    }

    It "contains cleanup logic for a failed first install" {
        $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\DiagramServer.psm1") -Raw
        $source | Should -Match 'if \(-not \$wasInstalled\)'
        $source | Should -Match 'down", "--remove-orphans'
    }
}
