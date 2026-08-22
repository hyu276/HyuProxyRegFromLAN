$ErrorActionPreference = "Stop"
$Agent = Join-Path $PSScriptRoot "agent.py"
$Python = (Get-Command python).Source
$Action = New-ScheduledTaskAction -Execute $Python -Argument "`"$Agent`" run"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "Hyu LAN Proxy Agent" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Outbound-only heartbeat agent for Hyu LAN Proxy Registry" -Force
Write-Host "Installed. The agent will start at logon. Start it now with: python `"$Agent`" run"
