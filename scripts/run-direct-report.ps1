$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
New-Item -ItemType Directory -Force "temp\direct-reports" | Out-Null
& "C:\Program Files\nodejs\node.exe" "scripts\direct-report-collect.mjs" | Tee-Object -FilePath "temp\direct-reports\scheduled.log" -Append
exit $LASTEXITCODE
