$cacheDir = Join-Path $env:LOCALAPPDATA "PlatformProcess\Cache"
$targetPrefix = 'https://ef-webview.gryphline.com'

if (-not (Test-Path $cacheDir)) {
    Write-Host "Could not find cache directory: $cacheDir" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    return
}

$cacheFiles = Get-ChildItem -Path $cacheDir -File -Filter "data_*" | Sort-Object LastWriteTime -Descending
if ($cacheFiles.Count -eq 0) {
    Write-Host "No cache files (data_*) were found in: $cacheDir" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    return
}

$targetUrls = New-Object System.Collections.Generic.List[string]
$unreadableCount = 0

foreach ($cacheFile in $cacheFiles) {
    Write-Host "Scanning $($cacheFile.FullName)..."

    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $cacheFile.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        )

        $bytes = New-Object byte[] $stream.Length
        [void]$stream.Read($bytes, 0, $bytes.Length)
    } catch [System.IO.IOException] {
        $unreadableCount++
        continue
    } finally {
        if ($null -ne $stream) {
            $stream.Close()
        }
    }

    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $text = $text -replace '\\u0026', '&'
    $text = $text -replace '\\/', '/'
    $text = $text -replace '&amp;', '&'

    $allUrlMatches = [regex]::Matches($text, 'https?://[A-Za-z0-9\-\._~:/\?#\[\]@!\$&''\(\)\*\+,;=%]+')
    foreach ($match in $allUrlMatches) {
        $candidateUrl = $match.Value
        if ($candidateUrl -like "$targetPrefix*") {
            $targetUrls.Add($candidateUrl)
        }
    }

    if ($targetUrls | Where-Object { $_ -match 'u8_token=' }) {
        break
    }
}

if ($targetUrls.Count -eq 0) {
    if ($unreadableCount -gt 0 -and $unreadableCount -eq $cacheFiles.Count) {
        Write-Host "All cache files are currently locked by another process." -ForegroundColor Red
        Write-Host "Please keep the gacha record page open and try again after minimizing the game for a few seconds." -ForegroundColor Yellow
    } else {
        Write-Host "No URL from $targetPrefix was found in cache files." -ForegroundColor Red
    }
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