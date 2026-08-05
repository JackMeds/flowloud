$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "build.ps1")
& (Join-Path $PSScriptRoot "build\GatewayTests.exe") `
    (Join-Path $PSScriptRoot "build\QwenTrayGateway.exe")

if ($LASTEXITCODE -ne 0) {
    throw "Gateway tests failed."
}

