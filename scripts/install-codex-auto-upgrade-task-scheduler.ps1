$ErrorActionPreference = 'Stop'

$TaskName = if ($env:TASK_NAME) { $env:TASK_NAME } elseif ($env:LABEL) { $env:LABEL } else { 'codex-cli-auto-upgrade' }
$BotTaskName = if ($env:BOT_TASK_NAME) { $env:BOT_TASK_NAME } elseif ($env:BOT_LABEL) { $env:BOT_LABEL } else { 'codex-discord-bot' }
$ScheduleHourRaw = if ($env:SCHEDULE_HOUR) { $env:SCHEDULE_HOUR } else { '5' }
$ScheduleMinuteRaw = if ($env:SCHEDULE_MINUTE) { $env:SCHEDULE_MINUTE } else { '15' }

try {
  $ScheduleHour = [int]$ScheduleHourRaw
} catch {
  throw "invalid SCHEDULE_HOUR=$ScheduleHourRaw (expected 0-23)"
}
try {
  $ScheduleMinute = [int]$ScheduleMinuteRaw
} catch {
  throw "invalid SCHEDULE_MINUTE=$ScheduleMinuteRaw (expected 0-59)"
}
if ($ScheduleHour -lt 0 -or $ScheduleHour -gt 23) {
  throw "invalid SCHEDULE_HOUR=$ScheduleHour (expected 0-23)"
}
if ($ScheduleMinute -lt 0 -or $ScheduleMinute -gt 59) {
  throw "invalid SCHEDULE_MINUTE=$ScheduleMinute (expected 0-59)"
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$UpgradeScript = Join-Path $PSScriptRoot 'codex-auto-upgrade.ps1'
$LogPath = Join-Path $ProjectRoot 'logs/codex-auto-upgrade.log'
$timeText = '{0:D2}:{1:D2}' -f $ScheduleHour, $ScheduleMinute
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UpgradeScript`" -BotTaskName `"$BotTaskName`""

$createArgs = @('/Create', '/F', '/SC', 'DAILY', '/TN', $TaskName, '/ST', $timeText, '/TR', $taskCommand)
& schtasks.exe @createArgs | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "failed to create scheduled task: $TaskName"
}

& schtasks.exe /Run /TN $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "task created but initial run failed: $TaskName"
}

Write-Output "installed task: $TaskName"
Write-Output "schedule:      daily at $timeText"
Write-Output "upgrade cmd:   $taskCommand"
Write-Output "logs:          $LogPath"
