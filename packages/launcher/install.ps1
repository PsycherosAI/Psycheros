# Psycheros Installer — Windows
# Run this in PowerShell: .\install.ps1

# Default to the public canonical repo. Set $env:PSYCHEROS_REPO to override
# (slug or URL form) when testing against a fork or the private staging repo.
$repoInput = if ($env:PSYCHEROS_REPO) { $env:PSYCHEROS_REPO } else { "PsycherosAI/Psycheros" }
$repoInput = $repoInput -replace '^https://github\.com/', ''
$repoInput = $repoInput -replace '^git@github\.com:', ''
$repoInput = $repoInput -replace '\.git$', ''
$MonorepoSlug = $repoInput
$MonorepoRepo = "https://github.com/$MonorepoSlug.git"

Write-Host ""
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host "    Psycheros Installer" -ForegroundColor Cyan
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Check prerequisites ---
Write-Host "[1/4] Checking prerequisites..." -ForegroundColor Yellow

# Git
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Host "  Git is not installed." -ForegroundColor Red
    Write-Host "  Download it from: https://git-scm.com/download/win" -ForegroundColor White
    exit 1
}
Write-Host "  Git: $(& git --version)"

# Deno
$denoCmd = Get-Command deno -ErrorAction SilentlyContinue
if ($denoCmd) {
    $ver = & deno --version 2>$null | Select-Object -First 1
    Write-Host "  Deno: $ver" -ForegroundColor Green
} else {
    Write-Host "  Deno not found. Installing..." -ForegroundColor Yellow
    irm https://deno.land/install.ps1 | iex

    $denoCmd = Get-Command deno -ErrorAction SilentlyContinue
    if (-not $denoCmd) {
        Write-Host "  Deno installation failed." -ForegroundColor Red
        Write-Host "  Please install manually: https://deno.land" -ForegroundColor White
        exit 1
    }
    Write-Host "  Deno installed successfully." -ForegroundColor Green
    Write-Host "  If 'deno' isn't recognized, restart your terminal." -ForegroundColor Yellow
}
Write-Host ""

# --- Step 2: Install directory ---
$DefaultDir = "$HOME\psycheros"
Write-Host "[2/4] Choose install location" -ForegroundColor Yellow
$installDir = Read-Host "  Install directory? [$DefaultDir]"
if ([string]::IsNullOrWhiteSpace($installDir)) {
    $installDir = $DefaultDir
}
$installDir = $installDir.TrimEnd('\')
$parentDir = Split-Path -Parent $installDir
if ($parentDir) {
    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
}
Write-Host "  Using: $installDir" -ForegroundColor Green
Write-Host ""

# --- Step 3: Clone monorepo ---
Write-Host "[3/4] Downloading Psycheros monorepo..." -ForegroundColor Yellow

$psycherosPkgPresent = Test-Path "$installDir\packages\psycheros"
if ((Test-Path "$installDir\.git") -and $psycherosPkgPresent) {
    Write-Host "  Monorepo already present, updating..." -ForegroundColor Cyan
    Set-Location $installDir
    git pull --ff-only
} elseif ((Test-Path $installDir) -and ((Get-ChildItem -Force $installDir -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)) {
    Write-Host "  $installDir exists and is not a Psycheros monorepo checkout." -ForegroundColor Red
    Write-Host "  Pick a different install directory, or remove the existing one first:" -ForegroundColor White
    Write-Host "    Remove-Item -Recurse -Force $installDir" -ForegroundColor White
    exit 1
} else {
    Write-Host "  Cloning $MonorepoSlug..." -ForegroundColor Cyan
    git clone $MonorepoRepo $installDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Could not clone monorepo. Check your internet connection and try again." -ForegroundColor Red
        Write-Host "  Manual command: git clone $MonorepoRepo $installDir" -ForegroundColor White
        exit 1
    }
}
Write-Host ""

# --- Step 4: Settings ---
Write-Host "[4/4] Configuration" -ForegroundColor Yellow
Write-Host ""

$userName = Read-Host "  Your name? [You]"
if ([string]::IsNullOrWhiteSpace($userName)) { $userName = "You" }

$entityName = Read-Host "  Entity's name? [Assistant]"
if ([string]::IsNullOrWhiteSpace($entityName)) { $entityName = "Assistant" }

# Detect timezone
$tz = "UTC"
try {
    $detected = [System.TimeZoneInfo]::Local.Id
    if ($detected) { $tz = $detected }
} catch {}

$tzInput = Read-Host "  Timezone? [$tz]"
if (-not [string]::IsNullOrWhiteSpace($tzInput)) { $tz = $tzInput }

# Write settings
$psycherosPkgDir = "$installDir\packages\psycheros"
$settingsDir = "$psycherosPkgDir\.psycheros"
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null

$settings = @{
    entityName = $entityName
    userName   = $userName
    timezone   = $tz
} | ConvertTo-Json
Set-Content -Path "$settingsDir\general-settings.json" -Value $settings -Encoding UTF8

Write-Host "  Settings saved." -ForegroundColor Green
Write-Host ""

# Save dashboard state so the web launcher knows the install directory.
# The dashboard reads from $APPDATA\psycheros-launcher\state.json on Windows;
# fall back to the legacy $HOME path when APPDATA is unavailable.
$dashboardState = @{ installDir = $installDir } | ConvertTo-Json
$appData = $env:APPDATA
if (-not $appData) { $appData = $env:LOCALAPPDATA }
if ($appData) {
    $stateDir = Join-Path $appData "psycheros-launcher"
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $dashboardStatePath = Join-Path $stateDir "state.json"
} else {
    $dashboardStatePath = "$HOME\.psycheros-launcher-state.json"
}
Set-Content -Path $dashboardStatePath -Value $dashboardState -Encoding UTF8
Write-Host "  Dashboard state saved." -ForegroundColor Green
Write-Host ""

# --- Generate launcher scripts ---
Write-Host "Creating launcher scripts..." -ForegroundColor Yellow

# Helper to write .ps1 files with CRLF line endings (required by Windows PowerShell)
function Write-CrlfFile {
    param([string]$Path, [string]$Content)
    $Content = ($Content -replace "`r`n", "`n") -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# start.ps1
$startContent = @'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$dir\packages\psycheros"

Write-Host ""
Write-Host "Starting Psycheros..." -ForegroundColor Cyan
Write-Host ""

Start-Sleep -Seconds 3
Start-Process "http://localhost:3000"

deno task start
'@
Write-CrlfFile -Path "$installDir\start.ps1" -Content $startContent

# stop.ps1
$stopContent = @'
Write-Host "Stopping Psycheros..." -ForegroundColor Cyan
Get-Process -Name "deno" -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Done." -ForegroundColor Green
'@
Write-CrlfFile -Path "$installDir\stop.ps1" -Content $stopContent

# update.ps1
$updateContent = @'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "Updating Psycheros monorepo..." -ForegroundColor Cyan
Set-Location "$dir"
git pull --ff-only

Write-Host ""
Write-Host "Update complete! Run .\start.ps1 to launch." -ForegroundColor Green
Write-Host ""
'@
Write-CrlfFile -Path "$installDir\update.ps1" -Content $updateContent

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# --- All done ---
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Your install directory:"
Write-Host "    $installDir\"
Write-Host "      packages\psycheros\      (main app)"
Write-Host "      packages\entity-core\    (entity memory & identity)"
Write-Host "      packages\entity-loom\    (memory import wizard)"
Write-Host "      start.ps1                (launch Psycheros)"
Write-Host "      stop.ps1                 (stop Psycheros)"
Write-Host "      update.ps1               (pull latest updates)"
Write-Host ""
Write-Host "  To get started:" -ForegroundColor White
Write-Host "    cd $installDir && .\start.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  On first run, Deno will download dependencies (this may take a moment)."
Write-Host "  After that, open http://localhost:3000 and add your API key in Settings."
Write-Host ""
