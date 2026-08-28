param([switch]$SkipTests)
$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$extensionRoot = Join-Path $projectRoot "extension"
$wxtRoot = Join-Path $projectRoot "extension-wxt"
$releaseRoot = Join-Path $projectRoot "dist\release"
$node = "C:\Users\15300\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $node)) { $node = "node" }
function Assert-WorkspacePath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the workspace: $resolved"
    }
    return $resolved
}
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionRoot "manifest.json") | ConvertFrom-Json
$version = [string]$manifest.version_name
if ($version -ne "0.10.0-alpha.1") { throw "Unexpected release version: $version" }

$wxtCli = Join-Path $wxtRoot "node_modules\wxt\bin\wxt.mjs"
$tscCli = Join-Path $wxtRoot "node_modules\typescript\bin\tsc"
if (-not (Test-Path -LiteralPath $wxtCli) -or -not (Test-Path -LiteralPath $tscCli)) {
    throw "WXT build dependencies are missing. Install extension-wxt dependencies before packaging."
}

& $node (Join-Path $projectRoot "scripts\build-transformers-runtime.mjs")
if ($LASTEXITCODE -ne 0) { throw "Unable to build the bundled Transformers.js/ONNX runtime." }

Push-Location $wxtRoot
try {
    & $node $tscCli --noEmit
    if ($LASTEXITCODE -ne 0) { throw "React/WXT typecheck failed." }
    & $node $wxtCli build
    if ($LASTEXITCODE -ne 0) { throw "Chrome React/WXT build failed." }
}
finally {
    Pop-Location
}
& $node (Join-Path $projectRoot "scripts\sync-wxt-ui.cjs")
if ($LASTEXITCODE -ne 0) { throw "Unable to synchronize React/WXT assets into the production extension." }
Push-Location $wxtRoot
try {
    & $node $wxtCli build -b edge
    if ($LASTEXITCODE -ne 0) { throw "Edge React/WXT build failed." }
}
finally {
    Pop-Location
}

if (-not $SkipTests) {
    & (Join-Path $projectRoot "test.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Gateway tests failed." }
    & $node --test (Join-Path $extensionRoot "tests\*.test.cjs")
    if ($LASTEXITCODE -ne 0) { throw "Extension tests failed." }
}
& $node (Join-Path $projectRoot "scripts\release-gate.cjs")
if ($LASTEXITCODE -ne 0) { throw "Chrome/Edge store gate failed." }
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$files = Get-ChildItem -LiteralPath $extensionRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/](tests|node_modules)[\\/]' -and
    $_.Name -notin @('package.json', 'pnpm-lock.yaml') -and $_.Name -notlike 'popup-lab.*'
}
foreach ($browser in @('edge', 'chrome')) {
    $staging = Join-Path $releaseRoot "flowloud-$version-$browser"
    $staging = Assert-WorkspacePath $staging
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    foreach ($artifact in @("$staging.zip", "$staging.zip.sha256")) {
        if (Test-Path -LiteralPath $artifact) { Remove-Item -LiteralPath $artifact -Force }
    }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($extensionRoot.Length).TrimStart('\')
        $target = Join-Path $staging $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
    $zip = "$staging.zip"
    # Use tar for deterministic archives on Windows. Compress-Archive can
    # leave a user-mapped partial zip when an extension asset is inspected by
    # the browser or antivirus during packaging.
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    & tar.exe -a -c -f $zip -C $staging .
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zip)) {
        throw "Unable to create release archive: $zip"
    }
    if ((Get-Item -LiteralPath $zip).Length -gt 12MB) {
        throw "Release archive exceeds the 12 MB budget: $zip"
    }
    $zipEntries = @(& tar.exe -tf $zip) | ForEach-Object { ([string]$_) -replace '^[.\\/]+', '' }
    if ($LASTEXITCODE -ne 0) { throw "Unable to inspect release archive: $zip" }
    $registry = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionRoot "react-ui-build.json") | ConvertFrom-Json
    $requiredEntries = @(
        'manifest.json',
        [string]$manifest.background.service_worker,
        [string]$manifest.action.default_popup,
        [string]$manifest.options_page
    ) + @($registry.files | ForEach-Object { [string]$_ })
    $missingEntries = @($requiredEntries | Where-Object { $_ -and $_ -notin $zipEntries })
    if ($missingEntries.Count -gt 0) {
        throw "Release archive is missing referenced files: $($missingEntries -join ', ')"
    }
    $forbiddenEntries = @($zipEntries | Where-Object {
        $_ -match '(^|/)(tests|node_modules)(/|$)' -or $_ -match '(^|/)popup-lab\.'
    })
    if ($forbiddenEntries.Count -gt 0) {
        throw "Release archive contains development-only files: $($forbiddenEntries -join ', ')"
    }
    $zipStream = [IO.File]::OpenRead($zip)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([BitConverter]::ToString($sha256.ComputeHash($zipStream))).Replace('-', '').ToLowerInvariant()
        }
        finally { $sha256.Dispose() }
    }
    finally { $zipStream.Dispose() }
    Set-Content -Encoding ascii -LiteralPath "$zip.sha256" -Value "$hash  $([IO.Path]::GetFileName($zip))"
    $unpackedRelative = if ($browser -eq 'edge') { 'dist\Flowloud-Edge' } else { 'dist\Flowloud-Chrome' }
    $unpacked = Join-Path $projectRoot $unpackedRelative
    $unpacked = Assert-WorkspacePath $unpacked
    if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
    Copy-Item -LiteralPath $staging -Destination $unpacked -Recurse
}
$forbidden = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File | Where-Object { $_.Extension -in @('.js','.json','.html','.md') } | Select-String -Pattern '(sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY|chrome-user-data|\.wav$)'
if ($forbidden) { throw "Release audit found a possible secret or browser/audio artifact." }
Write-Output "RELEASE PASS $version"
