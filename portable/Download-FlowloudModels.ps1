param(
    [ValidateSet("0.6b-q4", "1.7b-q8")][string]$Profile = "0.6b-q4",
    [string]$Destination = (Join-Path $PSScriptRoot "models"),
    [switch]$Delete
)
$ErrorActionPreference = "Stop"
$catalog = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot "model-catalog.json") | ConvertFrom-Json
$selected = $catalog.profiles.$Profile
if (-not $selected) { throw "Unknown model profile: $Profile" }
$resolvedDestination = [IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $resolvedDestination)) { New-Item -ItemType Directory -Path $resolvedDestination -Force | Out-Null }

foreach ($file in $selected.files) {
    $target = Join-Path $resolvedDestination $file.name
    if ($Delete) {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        if (Test-Path -LiteralPath "$target.partial") { Remove-Item -LiteralPath "$target.partial" -Force }
        Write-Output "Deleted $($file.name)"
        continue
    }
    if (Test-Path -LiteralPath $target) {
        $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
        if ($existingHash -eq $file.sha256) { Write-Output "Verified $($file.name)"; continue }
        Move-Item -LiteralPath $target -Destination "$target.invalid" -Force
    }
    $partial = "$target.partial"
    $url = "https://huggingface.co/$($catalog.repository)/resolve/$($catalog.revision)/$($file.name)?download=true"
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        try {
            $offset = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0 }
            $client = [Net.Http.HttpClient]::new()
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $url)
            if ($offset -gt 0) { $request.Headers.Range = [Net.Http.Headers.RangeHeaderValue]::new($offset, $null) }
            $response = $client.Send($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead)
            $response.EnsureSuccessStatusCode() | Out-Null
            $mode = if ($offset -gt 0 -and $response.StatusCode -eq [Net.HttpStatusCode]::PartialContent) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
            $input = $response.Content.ReadAsStream()
            $output = [IO.File]::Open($partial, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose(); $response.Dispose(); $request.Dispose(); $client.Dispose() }
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
            if ($hash -ne $file.sha256) { throw "SHA-256 mismatch for $($file.name)" }
            Move-Item -LiteralPath $partial -Destination $target -Force
            Write-Output "Downloaded and verified $($file.name)"
            break
        } catch {
            if ($attempt -ge 3) { throw }
            Write-Warning "Download attempt $attempt failed; retrying with resume support."
        }
    }
}
