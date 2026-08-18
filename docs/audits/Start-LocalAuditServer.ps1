[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1024, 65535)]
    [int]$Port = 8787
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StaticRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$DefaultDocument = '2026-08-17-qwen-reader-v0.5.1-e2e-fixture.html'
$Prefix = "http://127.0.0.1:{0}/" -f $Port

function Get-ContentType {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $MimeTypes = @{
        '.css'  = 'text/css; charset=utf-8'
        '.gif'  = 'image/gif'
        '.html' = 'text/html; charset=utf-8'
        '.htm'  = 'text/html; charset=utf-8'
        '.jpeg' = 'image/jpeg'
        '.jpg'  = 'image/jpeg'
        '.js'   = 'text/javascript; charset=utf-8'
        '.json' = 'application/json; charset=utf-8'
        '.png'  = 'image/png'
        '.svg'  = 'image/svg+xml; charset=utf-8'
        '.txt'  = 'text/plain; charset=utf-8'
        '.wav'  = 'audio/wav'
    }

    $Extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($MimeTypes.ContainsKey($Extension)) {
        return $MimeTypes[$Extension]
    }

    return 'application/octet-stream'
}

function Write-Response {
    param(
        [Parameter(Mandatory = $true)]
        [System.Net.HttpListenerContext]$Context,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$ContentType,
        [Parameter(Mandatory = $true)]
        [byte[]]$Body
    )

    $Response = $Context.Response
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.Headers['Cache-Control'] = 'no-store'
    $Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $Response.ContentLength64 = $Body.Length

    try {
        if ($Context.Request.HttpMethod -ne 'HEAD' -and $Body.Length -gt 0) {
            $Response.OutputStream.Write($Body, 0, $Body.Length)
        }
    }
    finally {
        $Response.Close()
    }
}

function Write-TextResponse {
    param(
        [Parameter(Mandatory = $true)]
        [System.Net.HttpListenerContext]$Context,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $Body = [Text.Encoding]::UTF8.GetBytes($Message)
    Write-Response -Context $Context -StatusCode $StatusCode -ContentType 'text/plain; charset=utf-8' -Body $Body
}

function Get-SafeFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RequestPath,
        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    try {
        $DecodedPath = [Uri]::UnescapeDataString($RequestPath)
    }
    catch {
        return $null
    }

    if ([string]::IsNullOrWhiteSpace($DecodedPath) -or $DecodedPath.IndexOf([char]0) -ge 0) {
        return $null
    }

    $RelativePath = $DecodedPath.Replace('/', [IO.Path]::DirectorySeparatorChar).TrimStart([IO.Path]::DirectorySeparatorChar)
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath.IndexOf(':') -ge 0 -or [IO.Path]::IsPathRooted($RelativePath)) {
        return $null
    }

    try {
        $CandidatePath = [IO.Path]::GetFullPath([IO.Path]::Combine($RootPath, $RelativePath))
    }
    catch {
        return $null
    }

    $RootWithSeparator = $RootPath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $IsInsideRoot = $CandidatePath.Equals($RootPath, [StringComparison]::OrdinalIgnoreCase) -or
        $CandidatePath.StartsWith($RootWithSeparator, [StringComparison]::OrdinalIgnoreCase)
    if (-not $IsInsideRoot) {
        return $null
    }

    # Reject reparse points so a junction or symlink cannot escape the audit directory.
    $CurrentPath = $RootPath
    $SeparatorPattern = [regex]::Escape([IO.Path]::DirectorySeparatorChar)
    foreach ($Segment in ($RelativePath -split $SeparatorPattern)) {
        if ([string]::IsNullOrEmpty($Segment)) {
            continue
        }

        $CurrentPath = Join-Path -Path $CurrentPath -ChildPath $Segment
        if (Test-Path -LiteralPath $CurrentPath) {
            $Item = Get-Item -LiteralPath $CurrentPath -Force
            if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                return $null
            }
        }
    }

    return $CandidatePath
}

$Listener = [System.Net.HttpListener]::new()
$Listener.Prefixes.Add($Prefix)

try {
    $Listener.Start()
    Write-Host "Serving audit files from $StaticRoot"
    Write-Host "Open $Prefix$DefaultDocument"
    Write-Host 'Press Ctrl+C to stop.'

    while ($Listener.IsListening) {
        try {
            $Context = $Listener.GetContext()
        }
        catch [System.Net.HttpListenerException] {
            break
        }

        try {
            $Method = $Context.Request.HttpMethod.ToUpperInvariant()
            if ($Method -ne 'GET' -and $Method -ne 'HEAD') {
                $Context.Response.Headers['Allow'] = 'GET, HEAD'
                Write-TextResponse -Context $Context -StatusCode 405 -Message 'Method Not Allowed'
                continue
            }

            $RequestPath = $Context.Request.Url.AbsolutePath
            if ($RequestPath -eq '/') {
                $RequestPath = "/$DefaultDocument"
            }

            $FilePath = Get-SafeFilePath -RequestPath $RequestPath -RootPath $StaticRoot
            if ($null -eq $FilePath -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
                Write-TextResponse -Context $Context -StatusCode 404 -Message 'Not Found'
                continue
            }

            $Body = [IO.File]::ReadAllBytes($FilePath)
            Write-Response -Context $Context -StatusCode 200 -ContentType (Get-ContentType -Path $FilePath) -Body $Body
        }
        catch {
            try {
                Write-TextResponse -Context $Context -StatusCode 500 -Message 'Internal Server Error'
            }
            catch {
                # The client may have disconnected before an error response was possible.
            }
        }
    }
}
finally {
    if ($Listener.IsListening) {
        $Listener.Stop()
    }
    $Listener.Close()
}
