param([string]$Resume)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
New-Item -ItemType Directory -Force "data\weekly-reviews" | Out-Null
$mutex = New-Object System.Threading.Mutex($false, "Local\ONZO.WeeklyReview")
$acquired = $mutex.WaitOne(0)
if (-not $acquired) { exit 0 }

try {
  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8"
  $node = (Get-Command node).Source
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $root "data\weekly-reviews\runner-$stamp.out.log"
  $stderr = Join-Path $root "data\weekly-reviews\runner-$stamp.error.log"
  $arguments = @("--import", "tsx", "scripts/weekly-review-runner.mjs")
  if ($PSBoundParameters.ContainsKey("Resume")) {
    if ([string]::IsNullOrWhiteSpace($Resume)) { throw "Resume must name an existing run directory" }
    $arguments += @("--resume", $Resume)
  }
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  exit $process.ExitCode
} catch {
  $_.Exception.Message | Out-File -FilePath "data\weekly-reviews\runner-error.log" -Append -Encoding utf8
  exit 1
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
