param([string]$CodeExecutable, [string]$TestSuite = 'extension-host.cjs', [string]$FixturePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $CodeExecutable) {
    $codeCommand = (Get-Command code.cmd -ErrorAction Stop).Source
    $CodeExecutable = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCommand)) 'Code.exe'
}
$testRoot = Join-Path $projectRoot '.test-work'
$fixture = if ($FixturePath) { (Resolve-Path -LiteralPath $FixturePath).Path } else { Join-Path $testRoot 'host-fixture' }
$profile = Join-Path $testRoot 'vscode-profile'
$extensions = Join-Path $testRoot 'vscode-extensions'
New-Item -ItemType Directory -Path $fixture, (Join-Path $fixture '.vscode'), (Join-Path $profile 'User'), $extensions -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fixture '.vscode\settings.json') -Value '{}' -Encoding utf8
if (-not $FixturePath) { Set-Content -LiteralPath (Join-Path $fixture 'main.py') -Value "import os`nimport numpy`nimport cv2`n" -Encoding utf8 }
Set-Content -LiteralPath (Join-Path $profile 'User\settings.json') -Value '{"security.workspace.trust.enabled":false,"telemetry.telemetryLevel":"off","update.mode":"none","extensions.autoUpdate":false,"workbench.startupEditor":"none"}' -Encoding utf8
$resultFile = Join-Path $testRoot 'host-result.json'
if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile }
$suitePath = Join-Path (Join-Path $projectRoot 'tests') $TestSuite
$arguments = @('--new-window', "--user-data-dir=`"$profile`"", "--extensions-dir=`"$extensions`"", "--extensionDevelopmentPath=`"$projectRoot`"", "--extensionTestsPath=`"$suitePath`"", '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', "`"$fixture`"")
$hostProcess = Start-Process -FilePath $CodeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru
Write-Output "Isolated VS Code test process: $($hostProcess.Id)"
Write-Output "Result file: $resultFile"
