[CmdletBinding()]
param(
    [switch]$Automate,
    [switch]$KeepOpen,
    [string]$ProfilePath,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$extensionRoot = Join-Path $repoRoot "extension"
$defaultProfile = Join-Path $repoRoot ".tmp-popup-preview-edge"
$defaultOutput = Join-Path $defaultProfile "artifacts"
$profile = if ($ProfilePath) { [IO.Path]::GetFullPath($ProfilePath) } else { $defaultProfile }
$output = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { $defaultOutput }

if (-not (Test-Path -LiteralPath $extensionRoot -PathType Container)) {
    throw "Extension source directory is missing: $extensionRoot"
}

if (-not (Test-Path -LiteralPath $profile -PathType Container)) {
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $output -PathType Container)) {
    New-Item -ItemType Directory -Path $output -Force | Out-Null
}

$edge = @(
    (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $edge) {
    $edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($edgeCommand) { $edge = $edgeCommand.Source }
}
if (-not $edge) {
    throw "Microsoft Edge was not found. Pass a visible Edge installation on PATH or edit the launcher."
}

if (-not $Automate) {
    # Keep these as a string array. This preserves paths containing spaces and
    # avoids PowerShell treating the '+' in a switch value as a separate arg.
    $args = @(
        ('--user-data-dir=' + $profile),
        ('--disable-extensions-except=' + $extensionRoot),
        ('--load-extension=' + $extensionRoot),
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    )
    Start-Process -FilePath $edge -ArgumentList $args
    Write-Output ("EDGE PREVIEW profile={0} extension={1}" -f $profile, $extensionRoot)
    exit 0
}

$node = $env:QWEN_NODE
if (-not $node) {
    $candidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $candidate) { $node = $candidate }
}
if (-not $node) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    throw "Bundled Node was not found. Set QWEN_NODE to node.exe."
}

$nodeScript = Join-Path $PSScriptRoot "preview-extension.mjs"
$nodeArgs = @(
    $nodeScript,
    '--extension-root', $extensionRoot,
    '--profile', $profile,
    '--output', $output,
    '--edge', $edge
)
if ($KeepOpen) { $nodeArgs += '--keep-open' }

& $node @nodeArgs
if ($LASTEXITCODE -ne 0) {
    throw "Preview automation failed with exit code $LASTEXITCODE."
}
