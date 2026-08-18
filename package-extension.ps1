$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "extension"
$destination = Join-Path $PSScriptRoot "dist\Qwen-Reader-Edge"
$resolvedRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
$resolvedDestination = [IO.Path]::GetFullPath($destination)

if (-not $resolvedDestination.StartsWith($resolvedRoot + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to package outside the workspace."
}

$manifestPath = Join-Path $source "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) {
    throw "Only Manifest V3 packages are supported."
}

function Get-ManifestReferences($value) {
    $references = [Collections.Generic.List[string]]::new()
    if ($value.background.service_worker) {
        $references.Add([string]$value.background.service_worker)
    }
    if ($value.options_page) {
        $references.Add([string]$value.options_page)
    }
    if ($value.action.default_popup) {
        $references.Add([string]$value.action.default_popup)
    }
    foreach ($script in @($value.content_scripts)) {
        foreach ($relativePath in @($script.js) + @($script.css)) {
            if ($relativePath) { $references.Add([string]$relativePath) }
        }
    }
    foreach ($group in @($value.web_accessible_resources)) {
        foreach ($relativePath in @($group.resources)) {
            if ($relativePath) { $references.Add([string]$relativePath) }
        }
    }
    return $references | Sort-Object -Unique
}

function Assert-ManifestClosure($root, $value, $label) {
    foreach ($relativePath in Get-ManifestReferences $value) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $relativePath))) {
            throw "$label manifest reference is missing: $relativePath"
        }
    }
}

function Assert-LocalHtmlReferences($root, $label) {
    foreach ($htmlFile in Get-ChildItem -LiteralPath $root -Recurse -File -Filter "*.html") {
        $html = Get-Content -Raw -Encoding UTF8 -LiteralPath $htmlFile.FullName
        $matches = [regex]::Matches($html, '<script[^>]+src\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase')
        foreach ($match in $matches) {
            $reference = $match.Groups[1].Value
            if ($reference -match '^(https?:|data:|//)') { continue }
            $cleanReference = ($reference -split '[?#]')[0]
            $target = Join-Path $htmlFile.DirectoryName $cleanReference
            if (-not (Test-Path -LiteralPath $target)) {
                throw "$label HTML script reference is missing: $($htmlFile.Name) -> $reference"
            }
        }
    }
}

Assert-ManifestClosure $source $manifest "Source"
Assert-LocalHtmlReferences $source "Source"

$required = @(
    "background.js",
    "offscreen.html",
    "offscreen.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "popup-view.js",
    "popup-lab.html",
    "popup-lab.css",
    "popup-lab.js",
    "page-voices.html",
    "page-voices.css",
    "page-voices.js",
    "voice-studio.html",
    "voice-studio.css",
    "voice-studio.js",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "vendor\readability\Readability.js",
    "vendor\readability\LICENSE.md"
)
foreach ($relativePath in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $relativePath))) {
        throw "Required extension file is missing: $relativePath"
    }
}

$sourceFiles = Get-ChildItem -LiteralPath $source -Recurse -File |
    Where-Object {
        $_.FullName -notmatch '[\\/]tests[\\/]' -and
        $_.Name -ne "package.json"
    }
$unsafeEval = $sourceFiles |
    Where-Object { $_.Extension -in @(".js", ".html") } |
    Select-String -Pattern '\beval\s*\('
if ($unsafeEval) {
    throw "Manifest V3 package contains eval()."
}
$remoteScripts = $sourceFiles |
    Where-Object { $_.Extension -eq ".html" } |
    Select-String -Pattern '<script[^>]+src\s*=\s*["'']https?://'
if ($remoteScripts) {
    throw "Extension page contains a remote script."
}

if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null

foreach ($file in $sourceFiles) {
    $relativePath = $file.FullName.Substring($source.Length).TrimStart("\")
    $target = Join-Path $destination $relativePath
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
}

$packagedManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $destination "manifest.json") |
    ConvertFrom-Json
Assert-ManifestClosure $destination $packagedManifest "Packaged"
Assert-LocalHtmlReferences $destination "Packaged"

foreach ($file in $sourceFiles) {
    $relativePath = $file.FullName.Substring($source.Length).TrimStart("\")
    $packagedPath = Join-Path $destination $relativePath
    if (-not (Test-Path -LiteralPath $packagedPath)) {
        throw "Packaged file is missing: $relativePath"
    }
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
    $packagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagedPath).Hash
    if ($sourceHash -ne $packagedHash) {
        throw "Packaged file differs from source: $relativePath"
    }
}

Write-Output ("PACK PASS version={0} files={1} path={2}" -f $packagedManifest.version, $sourceFiles.Count, $destination)
