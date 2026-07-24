Set-StrictMode -Version Latest

function Get-DiagramServerPaths {
    param([Parameter(Mandatory)][string]$StateRoot)
    $root = [IO.Path]::GetFullPath($StateRoot)
    [pscustomobject]@{
        Root = $root
        Package = Join-Path $root "package"
        Backups = Join-Path $root "backups"
        EnvFile = Join-Path $root ".env"
        Manifest = Join-Path (Join-Path $root "package") "server-manifest.json"
    }
}

function New-DiagramApiKey {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $plain = "dg_" + [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain))
    } finally { $sha.Dispose() }
    $verifier = "sha256:" + ([BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant())
    [pscustomobject]@{
        Plaintext = $plain
        Record = [ordered]@{
            id = "local-admin"
            verifier = $verifier
            scopes = @("diagram:render")
            cachePartition = "local-admin"
            status = "active"
        }
    }
}

function Read-DiagramEnv {
    param([Parameter(Mandatory)][string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) { continue }
        $index = $line.IndexOf("=")
        if ($index -lt 1) { throw "Invalid environment line in $Path" }
        $values[$line.Substring(0, $index)] = $line.Substring($index + 1)
    }
    return $values
}

function Write-DiagramEnv {
    param([Parameter(Mandatory)][hashtable]$Values, [Parameter(Mandatory)][string]$Path)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $content = (($Values.Keys | Sort-Object | ForEach-Object { "$_=$($Values[$_])" }) -join [Environment]::NewLine) + [Environment]::NewLine
    [IO.File]::WriteAllText($Path, $content, (New-Object Text.UTF8Encoding($false)))
}

function Get-DiagramKeyRecords {
    param([Parameter(Mandatory)][hashtable]$Environment)
    $raw = [string]$Environment["DIAGRAM_API_KEY_RECORDS"]
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    try { return @($raw | ConvertFrom-Json) } catch { throw "DIAGRAM_API_KEY_RECORDS is not valid JSON" }
}

function Set-DiagramKeyRecords {
    param([Parameter(Mandatory)][hashtable]$Environment, [Parameter(Mandatory)][object[]]$Records)
    $Environment["DIAGRAM_API_KEY_RECORDS"] = ConvertTo-Json -InputObject @($Records) -Compress -Depth 8
}

function Read-DiagramServerManifest {
    param([Parameter(Mandatory)][string]$PackageRoot)
    $manifestPath = Join-Path $PackageRoot "server-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing server-manifest.json in $PackageRoot" }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { throw "server-manifest.json is invalid JSON" }
    if ($manifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$manifest.productVersion)) {
        throw "Unsupported server manifest"
    }
    try { $gatewayUri = [Uri][string]$manifest.gatewayUrl } catch { throw "server-manifest.json has an invalid gatewayUrl" }
    if ($gatewayUri.Scheme -ne "http" -or $gatewayUri.Host -ne "127.0.0.1" -or $gatewayUri.AbsolutePath -ne "/" -or $gatewayUri.Port -lt 1) {
        throw "Windows installer only supports an HTTP loopback Gateway URL such as http://127.0.0.1:9000"
    }
    foreach ($name in @("gateway", "kroki", "mermaid")) {
        if ([string]::IsNullOrWhiteSpace([string]$manifest.images.$name.reference)) {
            throw "server-manifest.json is missing the $name image reference"
        }
    }
    foreach ($file in @("docker-compose.yml", "docker-compose.windows.yml")) {
        if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $file))) { throw "Missing $file in server package" }
    }
    return $manifest
}

function Set-DiagramImageEnvironment {
    param([Parameter(Mandatory)][hashtable]$Environment, [Parameter(Mandatory)]$Manifest)
    $Environment["GATEWAY_IMAGE"] = [string]$Manifest.images.gateway.reference
    $Environment["KROKI_IMAGE"] = [string]$Manifest.images.kroki.reference
    $Environment["MERMAID_IMAGE"] = [string]$Manifest.images.mermaid.reference
}

function Invoke-DiagramDocker {
    param([Parameter(Mandatory)][string]$PackageRoot, [Parameter(Mandatory)][string]$EnvFile, [Parameter(Mandatory)][string[]]$Command)
    $arguments = @("compose", "--project-name", "diagram-as-code-server", "--env-file", $EnvFile, "-f", (Join-Path $PackageRoot "docker-compose.yml"), "-f", (Join-Path $PackageRoot "docker-compose.windows.yml")) + $Command
    & docker @arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed with exit code $LASTEXITCODE" }
}

function Assert-DiagramDockerReady {
    & docker version --format "{{.Server.Version}}" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker Desktop must be installed and running" }
}

function Wait-DiagramReady {
    param([Parameter(Mandatory)][string]$GatewayUrl, [int]$TimeoutSeconds = 90)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "$GatewayUrl/health/ready" -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Gateway did not become ready at $GatewayUrl within $TimeoutSeconds seconds"
}

function Copy-DiagramPackage {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($file in @("server-manifest.json", "docker-compose.yml", "docker-compose.windows.yml")) {
        Copy-Item -LiteralPath (Join-Path $Source $file) -Destination (Join-Path $Destination $file) -Force
    }
}

function Install-DiagramServer {
    param([Parameter(Mandatory)][string]$PackageRoot, [Parameter(Mandatory)][string]$StateRoot)
    $manifest = Read-DiagramServerManifest -PackageRoot $PackageRoot
    Assert-DiagramDockerReady
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    $wasInstalled = Test-Path -LiteralPath $paths.Package
    New-Item -ItemType Directory -Force -Path $paths.Root, $paths.Backups | Out-Null
    $environment = Read-DiagramEnv -Path $paths.EnvFile
    $createdKey = $null
    $configuredRecords = @(Get-DiagramKeyRecords -Environment $environment)
    if ($configuredRecords.Count -eq 0) {
        $createdKey = New-DiagramApiKey
        Set-DiagramKeyRecords -Environment $environment -Records @($createdKey.Record)
    }
    $environment["GATEWAY_PORT"] = ([Uri][string]$manifest.gatewayUrl).Port.ToString()
    Set-DiagramImageEnvironment -Environment $environment -Manifest $manifest
    Write-DiagramEnv -Values $environment -Path $paths.EnvFile
    Copy-DiagramPackage -Source $PackageRoot -Destination $paths.Package
    try {
        Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("up", "-d", "--remove-orphans")
        Wait-DiagramReady -GatewayUrl $manifest.gatewayUrl
    } catch {
        if (-not $wasInstalled) {
            try { Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("down", "--remove-orphans") } catch { }
        }
        throw
    }
    [pscustomobject]@{
        GatewayUrl = $manifest.gatewayUrl
        ProductVersion = $manifest.productVersion
        ApiKey = if ($null -ne $createdKey) { $createdKey.Plaintext } else { $null }
    }
}

function Get-DiagramServerStatus {
    param([Parameter(Mandatory)][string]$StateRoot)
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    $manifest = Read-DiagramServerManifest -PackageRoot $paths.Package
    Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("ps")
    try { Wait-DiagramReady -GatewayUrl $manifest.gatewayUrl -TimeoutSeconds 3; $ready = $true } catch { $ready = $false }
    [pscustomobject]@{ GatewayUrl = $manifest.gatewayUrl; ProductVersion = $manifest.productVersion; Ready = $ready }
}

function Get-DiagramServerLogs {
    param([Parameter(Mandatory)][string]$StateRoot, [ValidateRange(1, 10000)][int]$Tail = 200)
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("logs", "--tail=$Tail", "gateway", "kroki", "mermaid")
}

function Restart-DiagramServer {
    param([Parameter(Mandatory)][string]$StateRoot)
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    $manifest = Read-DiagramServerManifest -PackageRoot $paths.Package
    Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("restart")
    Wait-DiagramReady -GatewayUrl $manifest.gatewayUrl
}

function Rotate-DiagramServerKey {
    param([Parameter(Mandatory)][string]$StateRoot, [switch]$Finalize)
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    $environment = Read-DiagramEnv -Path $paths.EnvFile
    $records = @(Get-DiagramKeyRecords -Environment $environment)
    if ($Finalize) {
        if ($records.Count -lt 2) { throw "No pending rotated API key to finalize" }
        $updated = @($records[0])
    } else {
        $newKey = New-DiagramApiKey
        $updated = @($newKey.Record) + @($records)
    }
    Set-DiagramKeyRecords -Environment $environment -Records $updated
    Write-DiagramEnv -Values $environment -Path $paths.EnvFile
    Restart-DiagramServer -StateRoot $StateRoot
    if ($Finalize) { return [pscustomobject]@{ Finalized = $true } }
    return [pscustomobject]@{ Finalized = $false; ApiKey = $newKey.Plaintext }
}

function Update-DiagramServer {
    param([Parameter(Mandatory)][string]$PackageRoot, [Parameter(Mandatory)][string]$StateRoot)
    $manifest = Read-DiagramServerManifest -PackageRoot $PackageRoot
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    if (-not (Test-Path -LiteralPath $paths.Package)) { throw "No installed Diagram server found at $StateRoot" }
    $backup = Join-Path $paths.Backups ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"))
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Copy-Item -LiteralPath $paths.Package -Destination (Join-Path $backup "package") -Recurse -Force
    Copy-Item -LiteralPath $paths.EnvFile -Destination (Join-Path $backup ".env") -Force
    try {
        Copy-DiagramPackage -Source $PackageRoot -Destination $paths.Package
        $environment = Read-DiagramEnv -Path $paths.EnvFile
        Set-DiagramImageEnvironment -Environment $environment -Manifest $manifest
        Write-DiagramEnv -Values $environment -Path $paths.EnvFile
        Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("up", "-d", "--remove-orphans")
        Wait-DiagramReady -GatewayUrl $manifest.gatewayUrl
    } catch {
        Copy-DiagramPackage -Source (Join-Path $backup "package") -Destination $paths.Package
        Copy-Item -LiteralPath (Join-Path $backup ".env") -Destination $paths.EnvFile -Force
        Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("up", "-d", "--remove-orphans")
        throw "Update failed and the previous package was restored: $($_.Exception.Message)"
    }
    [pscustomobject]@{ ProductVersion = $manifest.productVersion; Backup = $backup }
}

function Uninstall-DiagramServer {
    param([Parameter(Mandatory)][string]$StateRoot, [switch]$Purge)
    $paths = Get-DiagramServerPaths -StateRoot $StateRoot
    if (Test-Path -LiteralPath $paths.Package) {
        Invoke-DiagramDocker -PackageRoot $paths.Package -EnvFile $paths.EnvFile -Command @("down", "--remove-orphans")
    }
    if ($Purge) {
        if ($paths.Root -notmatch "DiagramAsCode[\\/]server$") { throw "Refusing to purge an unexpected state root" }
        Remove-Item -LiteralPath $paths.Root -Recurse -Force
    }
}

Export-ModuleMember -Function @(
    "Get-DiagramServerPaths", "New-DiagramApiKey", "Read-DiagramEnv", "Read-DiagramServerManifest",
    "Install-DiagramServer", "Get-DiagramServerStatus", "Get-DiagramServerLogs", "Restart-DiagramServer",
    "Rotate-DiagramServerKey", "Update-DiagramServer", "Uninstall-DiagramServer"
)
