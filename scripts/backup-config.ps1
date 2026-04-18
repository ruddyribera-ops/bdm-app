# BDM App - Config Backup Script
# Run this locally to backup Railway environment variables
# Usage: .\scripts\backup-config.ps1

param(
    [string]$OutputFile = "bdm-config-backup.txt",
    [switch]$ShowValues  # Use -ShowValues to display actual values (careful sharing!)
)

$ErrorActionPreference = "Stop"

Write-Host "=== BDM App Config Backup ===" -ForegroundColor Cyan

# 1. Try Railway CLI
$hasRailway = Get-Command railway -ErrorAction SilentlyContinue

if ($hasRailway) {
    Write-Host "`n[1/3] Pulling Railway environment variables..." -ForegroundColor Yellow
    try {
        $railwayEnv = railway env list 2>&1
        if ($LASTEXITCODE -eq 0) {
            $railwayEnv | Out-File -FilePath $OutputFile -Encoding UTF8
            Write-Host "Railway vars saved to: $OutputFile" -ForegroundColor Green

            if (-not $ShowValues) {
                Write-Host "NOTE: Values hidden. Run with -ShowValues to see actual secrets." -ForegroundColor Yellow
                # Redact values for security
                (Get-Content $OutputFile) -replace '=.*', '=***REDACTED***' | Out-File "$OutputFile.redacted"
                Write-Host "Redacted copy saved to: $OutputFile.redacted" -ForegroundColor Green
            }
        }
    } catch {
        Write-Host "Railway CLI failed: $_" -ForegroundColor Red
    }
} else {
    Write-Host "`n[!] Railway CLI not found. Install from: https://docs.railway.app/guides/cli" -ForegroundColor Yellow
}

# 2. Save required env var清单 (template)
Write-Host "`n[2/3] Saving env var template..." -ForegroundColor Yellow
$template = @"
# BDM App - Required Environment Variables
# Copy this to .env and fill in values for local development
# DO NOT commit .env to git!

# --- Required ---
APP_PASSWORD=        # Main app password (ask team)
GEMINI_API_KEY=     # Google AI API key (from Google AI Studio)

# --- Optional (defaults work for local dev) ---
APP_SECRET=         # HMAC secret for token signing (default: bdm-secret)
PORT=3000           # Server port (default: 3000)
NODE_ENV=production

# --- Backup Info ---
# Backup Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
# Railway Project: bdm-app-prod
# Railway URL: https://railway.app/project/bdm-app-prod
"@

$template | Out-File -FilePath "bdm-env-template.txt" -Encoding UTF8
Write-Host "Env template saved to: bdm-env-template.txt" -ForegroundColor Green

# 3. Generate git commit backup info
Write-Host "`n[3/3] Saving git state snapshot..." -ForegroundColor Yellow
$gitInfo = @"
# Git State at Backup
Commit: $(git rev-parse HEAD 2>$null)
Branch: $(git branch --show-current 2>$null)
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Status: $(git status --short 2>$null)
"@
$gitInfo | Out-File -FilePath "bdm-git-state.txt" -Encoding UTF8
Write-Host "Git state saved to: bdm-git-state.txt" -ForegroundColor Green

# Summary
Write-Host "`n=== Backup Complete ===" -ForegroundColor Cyan
Write-Host "Files created:"
Write-Host "  - $OutputFile       (Railway vars from CLI)"
if (-not $ShowValues) { Write-Host "  - $OutputFile.redacted (same, values hidden)" }
Write-Host "  - bdm-env-template.txt (local dev template)"
Write-Host "  - bdm-git-state.txt   (git snapshot)"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Review bdm-env-template.txt and copy to .env for local dev"
Write-Host "  2. Store Railway vars securely (password manager)"
Write-Host "  3. Commit bdm-env-template.txt to docs/ if it's gitignored"
