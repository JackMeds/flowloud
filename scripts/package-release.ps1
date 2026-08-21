param([switch]$SkipTests)
$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$extensionRoot = Join-Path $projectRoot "extension"
$releaseRoot = Join-Path $projectRoot "dist\release"
function Assert-WorkspacePath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the workspace: $resolved"
    }
    return $resolved
}
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionRoot "manifest.json") | ConvertFrom-Json
$version = [string]$manifest.version_name
if ($version -ne "0.9.0-beta.2") { throw "Unexpected release version: $version" }
if (-not $SkipTests) {
    & (Join-Path $projectRoot "test.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Gateway tests failed." }
    $node = "C:\Users\15300\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (-not (Test-Path -LiteralPath $node)) { $node = "node" }
    & $node --test (Join-Path $extensionRoot "tests\*.test.cjs")
    if ($LASTEXITCODE -ne 0) { throw "Extension tests failed." }
}
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
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
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
