$ErrorActionPreference = "Stop"

$Agent = Join-Path $PSScriptRoot "agent.py"
if (-not (Test-Path $Agent)) {
  throw "agent.py was not found at $Agent"
}

$PythonCommand = Get-Command python -ErrorAction SilentlyContinue
$UsePyLauncher = $false
if (-not $PythonCommand) {
  $PythonCommand = Get-Command py -ErrorAction SilentlyContinue
  $UsePyLauncher = $true
}
if (-not $PythonCommand) {
  throw "Python was not found. Install Python 3.10+ and ensure python.exe or py.exe is available in PATH."
}

$Python = $PythonCommand.Source
if ($UsePyLauncher) {
  $Status = & $Python -3 $Agent status | ConvertFrom-Json
  $Arguments = "-3 `"$Agent`" run"
} else {
  $Status = & $Python $Agent status | ConvertFrom-Json
  $Arguments = "`"$Agent`" run"
}

if (-not $Status.paired) {
  throw "This device is not paired yet. Pair it from the dashboard before installing auto-start."
}

$Action = New-ScheduledTaskAction -Execute $Python -Argument $Arguments
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName "Hyu LAN Proxy Agent" `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Outbound-only heartbeat agent for Hyu LAN Proxy Registry" `
  -Force | Out-Null

Write-Host "Installed Scheduled Task: Hyu LAN Proxy Agent"
Write-Host "The agent will start at logon and will be restarted after failures."
Write-Host "To test it now, run: $Python $Arguments"
