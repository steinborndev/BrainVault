# BrainVault Windows bootstrap: WSL2 + Ubuntu, then the one-shot Linux setup, then a
# desktop shortcut to the dashboard. Run from PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Safe to re-run. Two-phase by nature: if WSL itself has to be installed first, Windows
# needs a reboot before Ubuntu can run — the script detects that, tells you, and you
# simply run it again after the reboot.

$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu'
$RepoUrl = 'https://github.com/steinborndev/BrainVault.git'
$DashboardUrl = 'http://localhost:8420'

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---- Phase A: WSL2 + Ubuntu present and initialized? -------------------------------
Step 'Checking WSL'
$wslReady = $false
try {
    wsl.exe -d $Distro -- true 2>$null
    if ($LASTEXITCODE -eq 0) { $wslReady = $true }
} catch { }

if (-not $wslReady) {
    Step "Installing WSL2 + $Distro (this may take a few minutes)"
    wsl.exe --install -d $Distro
    Write-Host @"

WSL installation started. If this is the first time WSL is installed on this
machine, Windows may need a REBOOT now. After the reboot:

  1. An 'Ubuntu' window opens once to create your Linux username + password
     (any name/password you like — remember the password, setup needs it for sudo).
  2. Run this script again — it continues where it left off.
"@ -ForegroundColor Yellow
    exit 0
}
Write-Host "WSL + $Distro are ready."

# ---- Phase B: clone + setup inside WSL ---------------------------------------------
Step 'Running the BrainVault setup inside Ubuntu (you will be asked for your Linux sudo password)'
$bash = @"
set -e
if [ ! -d "`$HOME/BrainVault" ]; then
  sudo apt-get update && sudo apt-get install -y git
  git clone $RepoUrl "`$HOME/BrainVault"
fi
cd "`$HOME/BrainVault"
git pull --ff-only || true
bash scripts/setup-all.sh
"@
wsl.exe -d $Distro -- bash -lc $bash
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nSetup inside Ubuntu failed (exit $LASTEXITCODE). Scroll up for the first error; re-running this script is safe." -ForegroundColor Red
    exit 1
}

# ---- Desktop shortcut ---------------------------------------------------------------
Step 'Creating the desktop shortcut'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'BrainVault.url'
@"
[InternetShortcut]
URL=$DashboardUrl
"@ | Set-Content -Path $shortcut -Encoding ASCII
Write-Host "Created $shortcut"

Step 'Done'
Write-Host @"

BrainVault is running. Open the 'BrainVault' shortcut on your desktop
(or $DashboardUrl in any browser).

One step left in the browser: connect your Anthropic account — the dashboard
shows a 'Set up now' banner that takes you to the right place.
"@ -ForegroundColor Green
Start-Process $DashboardUrl
