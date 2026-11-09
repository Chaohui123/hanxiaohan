$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root
New-Item -ItemType Directory -Force "data\search-analytics" | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\ONZO.OzonSearchAnalytics")
$acquired = $mutex.WaitOne(0)
if (-not $acquired) {
  "Another search analytics collection is active; this run is skipped." | Out-File -Append -Encoding utf8 "data\search-analytics\scheduled.log"
  exit 0
}

try {
  $url = [Environment]::GetEnvironmentVariable("SEARCH_ANALYTICS_API_URL", "User")
  $key = [Environment]::GetEnvironmentVariable("SEARCH_ANALYTICS_INGEST_KEY", "User")
  if (-not $url -or -not $key) { throw "Configure SEARCH_ANALYTICS_API_URL and SEARCH_ANALYTICS_INGEST_KEY in the current user's environment." }
  $env:SEARCH_ANALYTICS_API_URL = $url
  $env:SEARCH_ANALYTICS_INGEST_KEY = $key
  $companyId = [Environment]::GetEnvironmentVariable("SEARCH_ANALYTICS_COMPANY_ID", "User")
  if ($companyId) { $env:SEARCH_ANALYTICS_COMPANY_ID = $companyId }

  $bridge = Test-NetConnection -ComputerName "127.0.0.1" -Port 10086 -InformationLevel Quiet -WarningAction SilentlyContinue
  if (-not $bridge) {
    & "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" start | Out-Null
    Start-Sleep -Seconds 3
  }
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
  $node = (Get-Command node).Source
  & $node "tools\ozon-search-analytics\src\run-local.mjs" 2>&1 | ForEach-Object {
    $line = $_.ToString()
    $line | Out-File -FilePath "data\search-analytics\scheduled.log" -Append -Encoding utf8
    Write-Host $line
  }
  exit $LASTEXITCODE
} catch {
  $_.Exception.Message | Tee-Object -FilePath "data\search-analytics\scheduled.log" -Append
  exit 1
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
