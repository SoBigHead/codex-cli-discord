$ErrorActionPreference = 'Stop'

param(
  [string]$BotTaskName = $env:BOT_TASK_NAME,
  [string]$NodeBin = $(if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }),
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PassthroughArgs
)

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $ProjectRoot 'logs'
$StdoutPath = Join-Path $LogDir 'codex-auto-upgrade.log'
$StderrPath = Join-Path $LogDir 'codex-auto-upgrade.err.log'
$CoreScript = Join-Path $PSScriptRoot 'codex-auto-upgrade.mjs'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

if ($BotTaskName) {
  $env:BOT_TASK_NAME = $BotTaskName
}

& $NodeBin $CoreScript @PassthroughArgs 1>>$StdoutPath 2>>$StderrPath
exit $LASTEXITCODE
