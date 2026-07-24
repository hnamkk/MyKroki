[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory)]
    [ValidateSet("install", "status", "logs", "restart", "update", "rotate-key", "uninstall")]
    [string]$Command,
    [string]$PackageRoot = $PSScriptRoot,
    [ValidateRange(1, 10000)][int]$Tail = 200,
    [switch]$Finalize,
    [switch]$Purge,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA "DiagramAsCode\server")
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "DiagramServer.psm1") -Force -DisableNameChecking

switch ($Command) {
    "install" {
        $result = Install-DiagramServer -PackageRoot $PackageRoot -StateRoot $StateRoot
        Write-Output "Gateway URL: $($result.GatewayUrl)"
        Write-Output "Product version: $($result.ProductVersion)"
        if ($result.ApiKey) { Write-Output "API key (store it now; it will not be shown again): $($result.ApiKey)" }
    }
    "status" { Get-DiagramServerStatus -StateRoot $StateRoot }
    "logs" { Get-DiagramServerLogs -StateRoot $StateRoot -Tail $Tail }
    "restart" { Restart-DiagramServer -StateRoot $StateRoot }
    "update" { Update-DiagramServer -PackageRoot $PackageRoot -StateRoot $StateRoot }
    "rotate-key" {
        $result = Rotate-DiagramServerKey -StateRoot $StateRoot -Finalize:$Finalize
        if ($result.ApiKey) { Write-Output "New API key (store it now; it will not be shown again): $($result.ApiKey)" }
    }
    "uninstall" { Uninstall-DiagramServer -StateRoot $StateRoot -Purge:$Purge }
}
