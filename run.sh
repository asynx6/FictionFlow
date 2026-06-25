#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# run.sh — FictionFlow Quick Run (Linux / macOS / WSL / Git Bash)
# ----------------------------------------------------------------------------
# Otomatis:
#   1. Install root + backend + frontend dependencies (skip jika sudah ada)
#   2. Bootstrap backend/.env dari backend/.env.example (jika belum ada)
#   3. Validasi MODEL_PROVIDER_API_KEY → STOP jika masih placeholder
#   4. Jalankan backend (sudah include static serve untuk frontend)
# ----------------------------------------------------------------------------

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[run]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC}  $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[err]${NC} $1"; }

echo ""
echo -e "${CYAN}================================${NC}"
echo -e "${CYAN}  FictionFlow — Quick Run${NC}"
echo -e "${CYAN}================================${NC}"
echo ""

# ---- 1. Install root dependencies ----
if [ ! -d "node_modules" ]; then
  log "Installing root dependencies..."
  npm install
  ok "Root dependencies installed."
else
  ok "Root dependencies already installed."
fi

# ---- 2. Install backend dependencies ----
if [ ! -d "backend/node_modules" ]; then
  log "Installing backend dependencies..."
  (cd backend && npm install)
  ok "Backend dependencies installed."
else
  ok "Backend dependencies already installed."
fi

# ---- 3. Install frontend dependencies (optional, future-proof) ----
if [ -f "frontend/package.json" ] && [ ! -d "frontend/node_modules" ]; then
  log "Installing frontend dependencies..."
  (cd frontend && npm install)
  ok "Frontend dependencies installed."
elif [ -d "frontend/node_modules" ]; then
  ok "Frontend dependencies already installed."
fi

# ---- 3.5 Build CSS ----
log "Building frontend CSS..."
(cd frontend && npm run build:css)
ok "Frontend CSS built."

# ---- 4. Bootstrap .env ----
if [ -f "backend/.env" ]; then
  ok "backend/.env already exists."
elif [ -f "backend/.env.example" ]; then
  log "Creating backend/.env from .env.example..."
  cp backend/.env.example backend/.env
  ok "backend/.env created."
else
  err "backend/.env.example not found. Cannot bootstrap .env."
  exit 1
fi

# ---- 5. Validate API key ----
log "Checking MODEL_PROVIDER_API_KEY..."

set +e
KEY=$(grep -E '^[[:space:]]*MODEL_PROVIDER_API_KEY[[:space:]]*=' backend/.env \
  | head -n 1 \
  | sed -E 's/^[[:space:]]*MODEL_PROVIDER_API_KEY[[:space:]]*=[[:space:]]*//' \
  | sed -E 's/^["'\''](.*)["'\'']$/\1/' \
  | sed -E 's/[[:space:]]*$//')
set -e

PLACEHOLDER_PATTERNS='^(sk-xxx|sk-XXXX|sk-xxxxxxxx|xxxxxxxxx|your-|<.*>)$'
IS_PLACEHOLDER=0
if [ -z "$KEY" ]; then
  IS_PLACEHOLDER=1
elif echo "$KEY" | grep -qiE 'xxxx|your-key|change.?me|<.*>'; then
  IS_PLACEHOLDER=1
fi

if [ "$IS_PLACEHOLDER" = "1" ]; then
  echo ""
  echo -e "${RED}================================${NC}"
  echo -e "${RED}  ⚠️   API KEY BELUM DIISI${NC}"
  echo -e "${RED}================================${NC}"
  echo ""
  echo "  1. Buka file:  backend/.env"
  echo "  2. Ganti baris:  MODEL_PROVIDER_API_KEY=sk-xxxxxxxxxxxxxxxx"
  echo "     menjadi:     MODEL_PROVIDER_API_KEY=sk-KEYKAMUDISINI"
  echo "  3. Simpan, lalu jalankan ulang:  ./run.sh"
  echo ""
  echo "  Pakai 9Router lokal (gratis)? Set:"
  echo "    MODEL_PROVIDER_BASE_URL=http://localhost:20128/v1"
  echo "    MODEL_PROVIDER_API_KEY=anything"
  echo ""
  exit 0
fi

ok "API key detected (len=${#KEY})."

# ---- 6. Run ----
echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  ✅  Starting FictionFlow${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
PORT="${PORT:-3000}"
echo "  🌐 Backend + Frontend:  http://localhost:${PORT}"
echo "  ⏹  Tekan Ctrl+C untuk stop"
echo ""

cd backend
exec npm start
