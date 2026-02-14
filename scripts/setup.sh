#!/bin/bash
set -e

REPO="dzianisv/opencode-manager"
NO_TUNNEL=false
SKIP_SERVICE=false

for arg in "$@"; do
  case "$arg" in
    --no-tunnel) NO_TUNNEL=true ;;
    --skip-service) SKIP_SERVICE=true ;;
    --help|-h)
      echo "Usage: curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/setup.sh | bash"
      echo ""
      echo "Options (pass via: curl ... | bash -s -- --no-tunnel):"
      echo "  --no-tunnel      Install without Cloudflare tunnel"
      echo "  --skip-service   Install CLI only, don't register as system service"
      echo "  -h, --help       Show this help"
      exit 0
      ;;
  esac
done

info() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }
fail() { echo "ERROR: $*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      fail "Unsupported OS: $OS. Only macOS and Linux are supported." ;;
esac

info "Setting up OpenCode Manager on $PLATFORM ($ARCH)"
echo ""

# --- Bun ---
if ! command_exists bun; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command_exists bun; then
    fail "Bun installation failed. Install manually: https://bun.sh"
  fi
  info "Bun installed: $(bun --version)"
else
  info "Bun found: $(bun --version)"
fi

# --- OpenCode ---
if ! command_exists opencode; then
  info "Installing OpenCode..."
  curl -fsSL https://opencode.ai/install | bash
  export PATH="$HOME/.opencode/bin:$PATH"
  if ! command_exists opencode; then
    warn "OpenCode installation failed. Install manually: https://opencode.ai"
    warn "Continuing anyway - you can install it later."
  else
    info "OpenCode installed: $(opencode version 2>/dev/null || echo 'ok')"
  fi
else
  info "OpenCode found: $(opencode version 2>/dev/null || echo 'ok')"
fi

# --- cloudflared (optional) ---
if [ "$NO_TUNNEL" = false ]; then
  if ! command_exists cloudflared; then
    info "Installing cloudflared for Cloudflare tunnel..."
    case "$PLATFORM" in
      macOS)
        if command_exists brew; then
          brew install cloudflared
        else
          warn "Homebrew not found. Install cloudflared manually: brew install cloudflared"
          warn "Continuing without tunnel support."
          NO_TUNNEL=true
        fi
        ;;
      Linux)
        if command_exists apt-get; then
          curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
          echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs 2>/dev/null || echo stable) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
          sudo apt-get update -qq && sudo apt-get install -y -qq cloudflared
        elif command_exists yum; then
          sudo yum install -y cloudflared 2>/dev/null || {
            warn "Could not install cloudflared via yum."
            warn "Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            NO_TUNNEL=true
          }
        else
          warn "No supported package manager found for cloudflared."
          warn "Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
          NO_TUNNEL=true
        fi
        ;;
    esac
    if [ "$NO_TUNNEL" = false ] && command_exists cloudflared; then
      info "cloudflared installed: $(cloudflared --version 2>&1 | head -1)"
    fi
  else
    info "cloudflared found: $(cloudflared --version 2>&1 | head -1)"
  fi
fi

echo ""

# --- opencode-manager ---
info "Installing opencode-manager..."
bun remove -g opencode-manager 2>/dev/null || true
bun install -g "github:$REPO"

GLOBAL_DIR="$(bun pm ls -g 2>/dev/null | head -1 | sed 's/ .*//' || echo "$HOME/.bun/install/global")"
if [ -d "$GLOBAL_DIR" ]; then
  (cd "$GLOBAL_DIR" && bun pm trust opencode-manager 2>/dev/null || true)
fi

if ! command_exists opencode-manager; then
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command_exists opencode-manager; then
    fail "opencode-manager not found in PATH after installation."
  fi
fi

info "opencode-manager installed"

# --- Install as service ---
if [ "$SKIP_SERVICE" = true ]; then
  echo ""
  info "Setup complete (service installation skipped)."
  echo ""
  echo "Run manually:"
  echo "  opencode-manager start          # Start the server"
  echo "  opencode-manager start --tunnel  # Start with Cloudflare tunnel"
  echo "  opencode-manager install-service # Install as system service"
  exit 0
fi

echo ""
SERVICE_ARGS=""
if [ "$NO_TUNNEL" = true ]; then
  SERVICE_ARGS="--no-tunnel"
fi
info "Installing as system service..."
opencode-manager install-service $SERVICE_ARGS

echo ""
info "Waiting for service to start (up to 120s)..."

AUTH_FILE="$HOME/.local/run/opencode-manager/auth.json"
CURL_AUTH=""
if [ -f "$AUTH_FILE" ]; then
  CURL_AUTH="-u $(jq -r '"\(.username):\(.password)"' "$AUTH_FILE" 2>/dev/null || true)"
fi

HEALTHY=false
for i in $(seq 1 40); do
  if curl -sf $CURL_AUTH http://localhost:5001/api/health 2>/dev/null | grep -q '"status":"healthy"'; then
    HEALTHY=true
    break
  fi
  printf "."
  sleep 3
done
echo ""

if [ "$HEALTHY" = true ]; then
  info "Service is healthy!"
  echo ""

  ENDPOINTS_FILE="$HOME/.local/run/opencode-manager/endpoints.json"
  if [ "$NO_TUNNEL" = false ]; then
    info "Waiting for tunnel URL (up to 30s)..."
    for j in $(seq 1 10); do
      if [ -f "$ENDPOINTS_FILE" ] && jq -e '.endpoints[] | select(.type == "tunnel")' "$ENDPOINTS_FILE" >/dev/null 2>&1; then
        TUNNEL_URL=$(jq -r '.endpoints[] | select(.type == "tunnel") | .url' "$ENDPOINTS_FILE" | tail -1)
        echo ""
        echo "============================================"
        echo "  OpenCode Manager is ready!"
        echo ""
        echo "  Local:  http://localhost:5001"
        echo "  Tunnel: $TUNNEL_URL"
        echo ""
        if [ -f "$AUTH_FILE" ]; then
          echo "  Username: $(jq -r '.username' "$AUTH_FILE")"
          echo "  Password: $(jq -r '.password' "$AUTH_FILE")"
        fi
        echo ""
        echo "  Status:    opencode-manager status"
        echo "  Logs:      opencode-manager logs"
        echo "  Uninstall: opencode-manager uninstall-service"
        echo "============================================"
        exit 0
      fi
      printf "."
      sleep 3
    done
    echo ""
    warn "Tunnel not available yet. Check later: opencode-manager status"
  fi

  echo ""
  echo "============================================"
  echo "  OpenCode Manager is ready!"
  echo ""
  echo "  Local: http://localhost:5001"
  if [ -f "$AUTH_FILE" ]; then
    echo ""
    echo "  Username: $(jq -r '.username' "$AUTH_FILE")"
    echo "  Password: $(jq -r '.password' "$AUTH_FILE")"
  fi
  echo ""
  echo "  Status:    opencode-manager status"
  echo "  Logs:      opencode-manager logs"
  echo "  Uninstall: opencode-manager uninstall-service"
  echo "============================================"
else
  warn "Service did not become healthy within 120s."
  echo "Check status: opencode-manager status"
  echo "Check logs:   opencode-manager logs"
  exit 1
fi
