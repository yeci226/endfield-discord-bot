$cachePath = Join-Path $env:LOCALAPPDATA "PlatformProcess\Cache\data_1"

if (-not (Test-Path $cachePath)) {
    Write-Host "Could not find data_1 at: $cachePath" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    return
}

Write-Host "Reading $cachePath..."

$stream = [System.IO.File]::Open($cachePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
    $bytes = New-Object byte[] $stream.Length
    [void]$stream.Read($bytes, 0, $bytes.Length)
} finally {
    $stream.Close()
}
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

$text = $text -replace '\\u0026', '&'
$text = $text -replace '\\/', '/'
$text = $text -replace '&amp;', '&'

$allUrlMatches = [regex]::Matches($text, 'https?://[A-Za-z0-9\-\._~:/\?#\[\]@!\$&''\(\)\*\+,;=%]+')
$targetPrefix = 'https://ef-webview.gryphline.com'

$targetUrls = @(
    foreach ($match in $allUrlMatches) {
        $match.Value
    }
) | Where-Object {
    $_ -like "$targetPrefix*"
}

if ($targetUrls.Count -eq 0) {
    Write-Host "No URL from $targetPrefix was found in data_1." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    return
}

$urlsWithToken = $targetUrls | Where-Object { $_ -match 'u8_token=' }
if ($urlsWithToken.Count -gt 0) {
    $url = $urlsWithToken[$urlsWithToken.Count - 1]
} else {
    $url = $targetUrls[$targetUrls.Count - 1]
}

Set-Clipboard -Value $url
Write-Host "Copied to clipboard." -ForegroundColor Green
Read-Host "Press Enter to exit"