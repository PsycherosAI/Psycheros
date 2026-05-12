# Psycheros Launcher — Windows
# Right-click this file and select "Run with PowerShell"

Write-Host ""
Write-Host "  Psycheros Launcher" -ForegroundColor Cyan
Write-Host ""

# Check for Deno
$denoCmd = Get-Command deno -ErrorAction SilentlyContinue
if (-not $denoCmd) {
    Write-Host "  Deno not found. Installing..." -ForegroundColor Yellow
    irm https://deno.land/install.ps1 | iex

    $denoCmd = Get-Command deno -ErrorAction SilentlyContinue
    if (-not $denoCmd) {
        Write-Host "  Deno installation failed." -ForegroundColor Red
        Write-Host "  Please install manually: https://deno.land" -ForegroundColor White
        Write-Host "  Then run this script again." -ForegroundColor White
        Read-Host "`n  Press Enter to exit"
        exit 1
    }
    Write-Host "  Deno installed!" -ForegroundColor Green
}

# Check for Git (optional — dashboard can download repos without it)
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    Write-Host "  Git:  $(& git --version)"
} else {
    Write-Host "  Git:  not found (updates will be slower without it)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Opening dashboard in your browser..." -ForegroundColor Cyan
Write-Host ""

# Find dashboard.ts — same directory as this script
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dashboard = Join-Path $ScriptDir "dashboard.ts"

if (-not (Test-Path $Dashboard)) {
    Write-Host "  dashboard.ts not found in $ScriptDir" -ForegroundColor Red
    Write-Host "  Make sure run.ps1 and dashboard.ts are in the same folder." -ForegroundColor White
    Read-Host "`n  Press Enter to exit"
    exit 1
}

deno run --allow-net --allow-read --allow-write --allow-run --allow-env $Dashboard
