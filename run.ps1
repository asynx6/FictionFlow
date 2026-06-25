# ----------------------------------------------------------------------------
# run.ps1 - FictionFlow Quick Run (Windows PowerShell)
# ----------------------------------------------------------------------------
# Otomatis:
#   1. Install root + backend + frontend dependencies (skip jika sudah ada)
#   2. Bootstrap backend/.env dari backend/.env.example (jika belum ada)
#   3. Validasi MODEL_PROVIDER_API_KEY -> STOP jika masih placeholder
#   4. Jalankan backend (sudah include static serve untuk frontend)
# ----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Log($msg)   { Write-Host ('[run]  ' + $msg) -ForegroundColor Cyan }
function Ok($msg)    { Write-Host ('[ok]   ' + $msg) -ForegroundColor Green }
function Warn($msg)  { Write-Host ('[warn] ' + $msg) -ForegroundColor Yellow }
function ErrExit($m) { Write-Host ('[err]  ' + $m) -ForegroundColor Red; exit 1 }

Clear-Host
Write-Host '================================' -ForegroundColor Cyan
Write-Host '  FictionFlow - Quick Run' -ForegroundColor Cyan
Write-Host '================================' -ForegroundColor Cyan
Write-Host ''

# ---- 1. Install root dependencies ----
if (-not (Test-Path 'node_modules')) {
    Log 'Installing root dependencies...'
    npm install
    Ok 'Root dependencies installed.'
} else {
    Ok 'Root dependencies already installed.'
}

# ---- 2. Install backend dependencies ----
if (-not (Test-Path 'backend/node_modules')) {
    Log 'Installing backend dependencies...'
    Push-Location backend
    try { npm install } finally { Pop-Location }
    Ok 'Backend dependencies installed.'
} else {
    Ok 'Backend dependencies already installed.'
}

# ---- 3. Install frontend dependencies (optional, future-proof) ----
if ((Test-Path 'frontend/package.json') -and (-not (Test-Path 'frontend/node_modules'))) {
    Log 'Installing frontend dependencies...'
    Push-Location frontend
    try { npm install } finally { Pop-Location }
    Ok 'Frontend dependencies installed.'
} elseif (Test-Path 'frontend/node_modules') {
    Ok 'Frontend dependencies already installed.'
}

# ---- 3.5 Build CSS ----
Log 'Building frontend CSS...'
Push-Location frontend
try { npm run build:css } finally { Pop-Location }
Ok 'Frontend CSS built.'

# ---- 4. Bootstrap .env ----
if (Test-Path 'backend/.env') {
    Ok 'backend/.env already exists.'
} elseif (Test-Path 'backend/.env.example') {
    Log 'Creating backend/.env from .env.example...'
    Copy-Item 'backend/.env.example' 'backend/.env'
    Ok 'backend/.env created.'
} else {
    ErrExit 'backend/.env.example not found. Cannot bootstrap .env.'
}

# ---- 5. Validate API key ----
Log 'Checking MODEL_PROVIDER_API_KEY...'

$apiKey = $null
$envLines = Get-Content 'backend/.env' -ErrorAction SilentlyContinue
foreach ($line in $envLines) {
    if ($line -match '^\s*MODEL_PROVIDER_API_KEY\s*=\s*(.*)\s*$') {
        $raw = $Matches[1]
        $apiKey = $raw.Trim().Trim('"').Trim("'")
        break
    }
}

$isPlaceholder = $false
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $isPlaceholder = $true
} elseif ($apiKey -match '(?i)xxxx|your-key|change.?me') {
    $isPlaceholder = $true
} elseif ($apiKey -match '^<.*>$') {
    $isPlaceholder = $true
}

if ($isPlaceholder) {
    Write-Host ''
    Write-Host '================================' -ForegroundColor Red
    Write-Host '  API KEY BELUM DIISI' -ForegroundColor Red
    Write-Host '================================' -ForegroundColor Red
    Write-Host ''
    Write-Host '  1. Buka file:  backend/.env' -ForegroundColor Yellow
    Write-Host '  2. Ganti baris:' -ForegroundColor Yellow
    Write-Host '       MODEL_PROVIDER_API_KEY=sk-xxxxxxxxxxxxxxxx' -ForegroundColor DarkYellow
    Write-Host '     menjadi:' -ForegroundColor Yellow
    Write-Host '       MODEL_PROVIDER_API_KEY=sk-KEYKAMUDISINI' -ForegroundColor Green
    Write-Host '  3. Simpan (Ctrl+S), tutup Notepad' -ForegroundColor Yellow
    Write-Host '  4. Jalankan ulang:  .\run.ps1' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Pakai 9Router lokal (gratis)? Set di .env:' -ForegroundColor DarkGray
    Write-Host '    MODEL_PROVIDER_BASE_URL=http://localhost:20128/v1' -ForegroundColor DarkGray
    Write-Host '    MODEL_PROVIDER_API_KEY=anything' -ForegroundColor DarkGray
    Write-Host ''
    $open = Read-Host "Tekan Enter untuk membuka backend/.env di Notepad (atau ketik 's' untuk skip)"
    if ($open -ne 's' -and $open -ne 'S') {
        notepad.exe 'backend/.env'
    }
    exit 0
}

Ok ('API key detected (len=' + $apiKey.Length + ').')

# ---- 6. Run ----
Write-Host ''
Write-Host '================================' -ForegroundColor Green
Write-Host '  Starting FictionFlow' -ForegroundColor Green
Write-Host '================================' -ForegroundColor Green
Write-Host ''
$port = if ($env:PORT) { $env:PORT } else { '3000' }
Write-Host ('  Backend + Frontend:  http://localhost:' + $port) -ForegroundColor Cyan
Write-Host '  Tekan Ctrl-C untuk stop' -ForegroundColor Gray
Write-Host ''

Set-Location backend
npm start
