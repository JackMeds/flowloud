$ErrorActionPreference = "Stop"

$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$buildDirectory = Join-Path $PSScriptRoot "build"
New-Item -ItemType Directory -Force -Path $buildDirectory | Out-Null

& $compiler `
    /nologo `
    /target:winexe `
    /optimize+ `
    "/out:$buildDirectory\QwenTrayGateway.exe" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Net.Http.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.Windows.Forms.dll `
    "$PSScriptRoot\src\Core.cs" `
    "$PSScriptRoot\src\HttpRequestData.cs" `
    "$PSScriptRoot\src\BackendController.cs" `
    "$PSScriptRoot\src\TcpGateway.cs" `
    "$PSScriptRoot\src\TrayApplication.cs" `
    "$PSScriptRoot\src\Program.cs"

if ($LASTEXITCODE -ne 0) {
    throw "QwenTrayGateway compilation failed."
}

& $compiler `
    /nologo `
    /target:exe `
    "/out:$buildDirectory\GatewayTests.exe" `
    "$PSScriptRoot\tests\TestRunner.cs"

if ($LASTEXITCODE -ne 0) {
    throw "Gateway test compilation failed."
}

