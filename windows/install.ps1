# AudioScribe installer for Windows.
# Sets up the transcription tools (Miniforge + Whisper + Montreal Forced
# Aligner), lets After Effects load the panel, and installs it.
# Safe to run again: anything already installed is skipped or updated.

$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$ExtSrc = Join-Path $Root 'com.ace.audioscribe'
$Log    = Join-Path $env:LOCALAPPDATA 'AudioScribe-install.log'

function Step($m) { Write-Host "`n$m" -ForegroundColor White }
function Fail($m) {
  Write-Host "`nSomething went wrong: $m" -ForegroundColor Red
  Write-Host "Details are in $Log - send that file to whoever gave you AudioScribe."
  exit 1
}
function Run($exe, [string[]]$argList) {
  # Native tools write progress to stderr; don't let PowerShell treat that as an error.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $exe @argList *>> $Log
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($code -ne 0) { throw "$exe exited with $code" }
}

Clear-Host
Write-Host "AudioScribe installer"
Write-Host "This takes about 10 minutes the first time, mostly downloading."
Write-Host "Log: $Log"
Add-Content $Log "---- $(Get-Date)"

if (-not (Test-Path $ExtSrc)) { Fail "Keep this installer in the same folder as com.ace.audioscribe." }
if (Get-Process -Name 'AfterFX' -ErrorAction SilentlyContinue) {
  Read-Host "After Effects is open. Please quit it, then press Enter"
}

# 1. Miniforge, reusing any existing conda install.
Step "1/5  Python"
$Base = $null
foreach ($d in @("$env:USERPROFILE\miniforge3", "$env:USERPROFILE\miniconda3", "$env:USERPROFILE\anaconda3",
                 "$env:LOCALAPPDATA\miniforge3", "C:\ProgramData\miniforge3")) {
  if (Test-Path "$d\Scripts\conda.exe") { $Base = $d; break }
}
if (-not $Base) {
  Write-Host "Downloading Miniforge..."
  $inst = Join-Path $env:TEMP 'Miniforge3-Windows-x86_64.exe'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -OutFile $inst `
      'https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Windows-x86_64.exe'
  } catch { Fail "Couldn't download Miniforge. Check your internet connection." }
  $Base = "$env:USERPROFILE\miniforge3"
  $p = Start-Process -FilePath $inst -Wait -PassThru -ArgumentList `
    '/InstallationType=JustMe', '/RegisterPython=0', '/AddToPath=0', '/S', "/D=$Base"
  if (-not (Test-Path "$Base\Scripts\conda.exe")) { Fail "Miniforge didn't install." }
} else { Write-Host "Found an existing install at $Base" }
$Conda = "$Base\Scripts\conda.exe"

# 2. The "aligner" environment with MFA.
Step "2/5  Speech aligner"
$AlEnv = "$Base\envs\aligner"
if (-not (Test-Path "$AlEnv\python.exe")) {
  Write-Host "Creating the environment (the slow part)..."
  try { Run $Conda @('create', '-y', '-n', 'aligner', '-c', 'conda-forge', 'montreal-forced-aligner', 'python=3.11') }
  catch { Fail "Couldn't create the aligner environment." }
} else { Write-Host "Already set up." }
$env:PATH = "$AlEnv;$AlEnv\Scripts;$AlEnv\Library\bin;$env:PATH"

# 3. Whisper and the English aligner models.
Step "3/5  Whisper and language models"
try {
  Run "$AlEnv\python.exe" @('-m', 'pip', 'install', '--upgrade', 'faster-whisper')
  Run "$AlEnv\Scripts\mfa.exe" @('model', 'download', 'acoustic', 'english_us_arpa')
  Run "$AlEnv\Scripts\mfa.exe" @('model', 'download', 'dictionary', 'english_us_arpa')
  Run "$AlEnv\python.exe" @('-c', 'import faster_whisper')
} catch { Fail "Couldn't install Whisper or the aligner models." }

# 4. Allow After Effects to load the panel.
Step "4/5  After Effects permissions"
foreach ($v in 9..13) {
  $k = "HKCU:\Software\Adobe\CSXS.$v"
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name 'PlayerDebugMode' -Value '1'
}

# 5. Install the panel.
Step "5/5  Installing the panel"
$Dest = "$env:APPDATA\Adobe\CEP\extensions"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Target = Join-Path $Dest 'com.ace.audioscribe'
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
Copy-Item -Recurse $ExtSrc $Target
Get-ChildItem -Recurse $Target | Unblock-File

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Open After Effects, then Window > Extensions > AudioScribe."
Write-Host "Select a layer with dialogue and press Transcribe."
Write-Host "(The first transcription downloads the Whisper model, so give it a minute.)"
