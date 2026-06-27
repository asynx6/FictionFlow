#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# run.sh — FictionFlow Quick Run (Linux / macOS / WSL / Git Bash)
# ----------------------------------------------------------------------------
# Otomatis:
#   1. Install backend + frontend dependencies (skip jika sudah ada)
#   2. Bootstrap backend/.env dari backend/.env.example (jika belum ada)
#   3. Build frontend CSS (tailwindcss --minify) — wajib sukses sebelum start
#   4. Validasi MODEL_PROVIDER_API_KEY → STOP jika masih placeholder
#   5. Jalankan backend (sudah include static serve untuk frontend)
#
# Catatan: root package.json sudah dihapus, jadi tidak ada langkah npm install
# di root. Backend & frontend masing-masing punya package.json sendiri.
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

# ---- 0. Cek Node + npm ----
if ! command -v node >/dev/null 2>&1; then
  err "Node.js tidak ditemukan. Install dari https://nodejs.org (versi >=18)."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm tidak ditemukan. Install Node.js (versi >=18) dari https://nodejs.org."
  exit 1
fi
ok "Node $(node -v) / npm $(npm -v)"

# ---- 1. Install backend dependencies ----
if [ ! -d "backend/node_modules" ]; then
  log "Installing backend dependencies..."
  (cd backend && npm install)
  ok "Backend dependencies installed."
else
  ok "Backend dependencies already installed."
fi

# ---- 2. Install frontend dependencies (wajib untuk build:css) ----
if [ ! -f "frontend/package.json" ]; then
  err "frontend/package.json tidak ditemukan. Repo mungkin corrupt — checkout ulang frontend/."
  exit 1
fi
if [ ! -d "frontend/node_modules" ]; then
  log "Installing frontend dependencies..."
  (cd frontend && npm install)
  ok "Frontend dependencies installed."
else
  ok "Frontend dependencies already installed."
fi

# ---- 3. Build CSS (wajib sebelum start, tailwind.output.css tidak di-commit) ----
log "Building frontend CSS..."
if ! (cd frontend && npm run build:css); then
  err "Build CSS gagal. Periksa sintaks di frontend/public/css/tailwind.input.css."
  err "Atau jalankan manual: cd frontend && npm run build:css"
  exit 1
fi
ok "Frontend CSS built → frontend/public/css/tailwind.output.css"

# ---- 4. Bootstrap .env ----
if [ -f "backend/.env" ]; then
  ok "backend/.env already exists."
elif [ -f "backend/.env.example" ]; then
  log "Creating backend/.env from .env.example..."
  cp backend/.env.example backend/.env
  ok "backend/.env created."
else
  err "backend/.env.example tidak ditemukan. Tidak bisa bootstrap .env."
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
