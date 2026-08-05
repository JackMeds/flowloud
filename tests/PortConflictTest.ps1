param(
    [Parameter(Mandatory = $true)]
    [string]$GatewayExe,
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$process = Start-Process `
    -FilePath $GatewayExe `
    -ArgumentList @("--config", $ConfigPath, "--no-tray") `
    -WorkingDirectory (Split-Path -Parent $GatewayExe) `
    -WindowStyle Hidden `
    -PassThru

try {
    if (-not $process.WaitForExit(5000)) {
        throw "Gateway remained running after a startup port conflict (PID $($process.Id))."
    }
    if ($process.ExitCode -eq 0) {
        throw "Gateway reported success even though its port was occupied."
    }
    Write-Host "PASS gateway exits silently on startup port conflict"
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}
