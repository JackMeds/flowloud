param(
  [int]$LargeObjectMiB = 10
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  $objects = git rev-list --objects --all
  $batch = $objects | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize) %(rest)'
  $threshold = $LargeObjectMiB * 1MB
  $large = @($batch | ForEach-Object {
    if ($_ -match '^([0-9a-f]+) blob ([0-9]+) (.+)$' -and [int64]$Matches[2] -ge $threshold) {
      [pscustomobject]@{ MiB = [math]::Round(([int64]$Matches[2] / 1MB), 2); Path = $Matches[3]; Object = $Matches[1] }
    }
  } | Sort-Object MiB -Descending)

  $riskyNames = @(git log --all --format= --name-only | Where-Object {
    $_ -match '(?i)(\.env|secret|token|credential|cookies?|\.wav$|\.mp3$|\.gguf$|browser-data|user-data)'
  } | Sort-Object -Unique)

  $patchText = git log --all --format= --no-ext-diff -p -- . ':!extension/vendor/**'
  $secretPattern = '(?i)(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|Authorization:\s*Bearer\s+[A-Za-z0-9._-]{12,})'
  $secretMatches = @($patchText | Select-String -Pattern $secretPattern).Count

  Write-Host "Public-history audit"
  Write-Host "Large blobs (>= $LargeObjectMiB MiB): $($large.Count)"
  $large | Format-Table -AutoSize
  Write-Host "Risky historical paths: $($riskyNames.Count)"
  $riskyNames | ForEach-Object { Write-Host " - $_" }
  Write-Host "Potential secret-pattern matches (values suppressed): $secretMatches"
  if ($secretMatches -gt 0) { exit 2 }
} finally {
  Pop-Location
}
