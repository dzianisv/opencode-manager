# OpenCode WebUI - Agent Guidelines

## ⚠️ CRITICAL: Read Product Requirements First

**Before implementing or modifying ANY feature, read `docs/requirements.md`.**

This document defines the mandatory requirements:
1. **Cloudflare Tunnel** - MUST always start, endpoint MUST be in endpoints.json
2. **TTS** - MUST work with Coqui/Chatterbox AND Browser API, switchable in Settings
3. **STT** - MUST work with Faster Whisper AND Browser API, switchable in Settings  
4. **Telegram** - MUST work when TELEGRAM_BOT_TOKEN is provided

**DO NOT** implement changes that violate these requirements.

---

## ⚠️ CRITICAL: Post-Deployment Testing Protocol

**After ANY deployment or service reinstallation, you MUST follow the testing protocol in `docs/testing.md`.**

At minimum, run:
```bash
# Quick verification
curl -s http://localhost:5001/api/health | jq '.status'
curl -s http://localhost:5001/api/stt/status | jq '.server.running'

# Voice E2E tests (11 tests)
bun run scripts/test-voice.ts --url http://localhost:5001 --user admin --pass PASSWORD --skip-talkmode

# Browser E2E test (full pipeline)
bun run scripts/test-browser.ts --url http://localhost:5001 --user admin --pass PASSWORD
```

See `docs/testing.md` for complete test procedures including:
- Manual STT/TTS tests
- Tunnel tests
- Settings UI verification
- Regression tests for known bugs

## ⚠️ CRITICAL: Verification Before Committing

**NEVER commit code claiming a feature or fix works without actually testing it end-to-end.**

**NEVER trust automated tests alone** - they may pass while real user workflows fail (e.g., tests using explicit parameters while users rely on default settings).

Before committing any change that affects startup or core functionality:

1. **Kill all processes and clean up:**
   ```bash
   pnpm cleanup
   # Or manually: lsof -ti:5001,5173,5551,5552,5553,5554 | xargs kill
   ```

2. **Start fresh and verify:**
   ```bash
   # For client mode (connecting to existing opencode)
   opencode serve --port 5551 --hostname 127.0.0.1 &
   sleep 3
   pnpm start:client
   
   # Or for standalone mode
   pnpm start
   ```

3. **Wait for full startup** (~60-90s for model loading) and verify:
   ```bash
   curl -s http://localhost:5001/api/health | jq '.status'  # Should be "healthy"
   curl -s http://localhost:5001/api/stt/status | jq '.server.running'  # Should be true
   curl -s http://localhost:5001/api/repos | jq '.[].fullPath'  # Should list repos
   ```

4. **Test the actual feature** you changed (e.g., voice transcription, file creation, etc.)

5. **MANDATORY: Test via Settings UI** (for voice/STT/TTS changes):
   - Open browser to http://localhost:5001 (or tunnel URL)
   - Go to Settings → Voice
   - Click "Test" button for STT - verify transcription works
   - Click "Test" button for TTS - verify audio plays
   - These use DEFAULT settings (e.g., language="auto") which may differ from test scripts

**DO NOT** trust that previous test runs are still valid after making changes.
**DO NOT** claim "all tests pass" without testing the actual UI with default settings.

## ⚠️ CRITICAL: Never Kill OpenCode Processes

**NEVER run `pkill -f opencode` or similar commands that kill opencode processes.**

The user runs `opencode -c` in their terminal sessions. Killing these processes will terminate the user's active coding sessions and potentially lose their work.

Safe alternatives:
- Kill specific PIDs you spawned: `kill <specific-pid>`
- Use `pnpm cleanup` to kill only managed ports (5001, 5173, 5551, 5552, 5553, 5554)
- Kill by port: `lsof -ti:5551 | xargs kill` (only kills process on that port)

## ⚠️ CRITICAL: Never Kill Cloudflare Tunnel

**ASSUME THE USER IS ALWAYS CONNECTED VIA TUNNEL. NEVER TOUCH CLOUDFLARED.**

**FORBIDDEN COMMANDS - NEVER RUN THESE:**
```bash
# NEVER run any of these:
pkill -f cloudflared
kill $(pgrep cloudflared)
pnpm cleanup  # This may kill tunnel
pnpm start    # This restarts tunnel with new URL
pnpm tunnel:stop
pnpm tunnel:start
killall cloudflared
sudo kill <cloudflared-pid>
```

**WHY:** The user accesses this agent through a Cloudflare tunnel from mobile/remote. Killing or restarting cloudflared disconnects them IMMEDIATELY with no way to reconnect (the URL changes).

**SAFE COMMANDS when user is remote:**
```bash
# These are SAFE:
curl ...                           # Read-only API calls
bun run scripts/test-voice.ts      # Tests against running service
bun run scripts/test-browser.ts    # Browser tests on localhost
pnpm build                         # Build only, no service restart
pnpm test                          # Unit tests only
git ...                            # Version control
opencode-manager status            # Read-only status check
```

**IF YOU NEED TO RESTART SERVICES:**
1. Ask the user FIRST
2. Wait for explicit confirmation
3. Only then proceed

**Safe alternatives when user is remote:**
- Kill only specific backend processes: `kill <pid>` for the backend PID only
- Restart individual services without touching the tunnel
- Ask user to run cleanup themselves when ready

## ⚠️ CRITICAL: Never Run E2E Tests That Spawn Services When User Is Connected

**NEVER run `test-npm-install.ts`, `test-startup.ts`, or similar tests that spawn `opencode-manager start` while the user is connected remotely.**

These tests:
- Spawn new service instances on different ports
- May interfere with the running tunnel or service
- Can cause the tunnel to drop, disconnecting the user

**Before running E2E tests:**
1. Ask the user if they are connected via tunnel
2. If yes, do NOT run tests that spawn services
3. Only run safe tests like unit tests (`pnpm test`) or static analysis

**Safe tests when user is remote:**
- `pnpm test` - Unit tests (no service spawning)
- `bun run scripts/test-npm-install.ts --skip-start --skip-service` - Only tests installation, not runtime
- Code linting and type checking

## Commands

- `pnpm dev` - Start both backend (5001) and frontend (5173)
- `pnpm dev:backend` - Backend only: `bun --watch backend/src/index.ts`
- `pnpm dev:frontend` - Frontend only: `cd frontend && vite`
- `pnpm build` - Build both backend and frontend
- `pnpm test` - Run backend tests: `cd backend && bun test`
- `cd backend && bun test <filename>` - Run single test file
- `cd backend && vitest --ui` - Test UI with coverage
- `cd backend && vitest --coverage` - Coverage report (80% threshold)
- `pnpm lint` - Lint both backend and frontend
- `pnpm lint:backend` - Backend linting
- `pnpm lint:frontend` - Frontend linting

## Persistent Tunnel (Recommended for Remote Development)

The Cloudflare tunnel now runs as a **persistent background process** that survives backend/frontend restarts:

```bash
# Start tunnel once (persists until explicitly stopped)
pnpm tunnel:start

# Check tunnel status and get URL
pnpm tunnel:status

# Now you can restart backend freely without losing tunnel connection
pnpm dev:backend  # Ctrl+C and restart as needed

# Stop tunnel when done
pnpm tunnel:stop
```

The tunnel state is stored in `~/.local/run/opencode-manager/tunnel.json`.

**Benefits:**
- Restart backend without disconnecting mobile/remote users
- Same tunnel URL persists across backend restarts  
- `pnpm cleanup` does NOT kill the tunnel

## Native Local Development (No Docker)

Run opencode-manager natively on macOS without Docker:

```bash
# Normal mode - spawns opencode serve with Cloudflare tunnel
pnpm start

# Client mode - connect to existing opencode instance with tunnel
# (shows list of running opencode servers to choose from)
pnpm start:client

# Without Cloudflare tunnel (local only)
pnpm start:no-tunnel

# Client mode without tunnel
bun scripts/start-native.ts --client

# Custom port
bun scripts/start-native.ts --port 3000
```

### Requirements

- Bun installed
- Node.js (for frontend)
- `cloudflared` for tunnel mode: `brew install cloudflared`
- OpenCode installed: `curl -fsSL https://opencode.ai/install | bash`

### How Client Mode Works

When using `--client`, the script:
1. Scans for running opencode processes using `lsof`
2. Checks health via `/doc` endpoint on each discovered port
3. Fetches version info from `/global/health`
4. Lists all healthy instances with directory, version, and PID
5. Lets you select which instance to connect to
6. Starts the backend in "client mode" (doesn't spawn opencode serve)

This is useful when you already have `opencode` running in a terminal and want the web UI to connect to it.

## NPM Package Installation Test

Test the npm package installation flow end-to-end:

```bash
# Run the comprehensive npm installation E2E test
bun run scripts/test-npm-install.ts

# Quick test (skip slow start and service tests)
bun run scripts/test-npm-install.ts --skip-start --skip-service
```

This test:
1. Uninstalls any existing opencode-manager installation
2. Installs from GitHub: `bun install -g github:dzianisv/opencode-manager`
3. Verifies binary is in PATH and help command works
4. Verifies `backend/dist/` and `frontend/dist/` exist (postinstall extraction)
5. Verifies whisper-server.py script exists
6. Tests `opencode-manager start` command (starts backend and verifies health)
7. Tests `opencode-manager install-service` and `uninstall-service`

Tests performed:
- Binary exists in PATH
- Help command works
- Version output
- Backend dist exists
- Frontend dist exists  
- Whisper server script exists
- Start command works (health check)
- Service install/uninstall (macOS/Linux)

## Voice E2E Tests

Test STT (Speech-to-Text), TTS (Text-to-Speech), and Talk Mode functionality:

```bash
# Local development (no auth required)
bun run scripts/test-voice.ts

# Remote deployment (with auth)
bun run scripts/test-voice.ts --url https://your-url.com --user admin --pass secret

# Using environment variables
OPENCODE_URL=https://your-url.com OPENCODE_USER=admin OPENCODE_PASS=secret bun run scripts/test-voice.ts

# Custom test phrase
bun run scripts/test-voice.ts --text "Your custom phrase to transcribe"

# Skip slow talk mode flow test
bun run scripts/test-voice.ts --skip-talkmode
```

Requirements for STT test:
- macOS with `say` command (for audio generation)
- `ffmpeg` installed (for audio conversion)
- Whisper server running (auto-starts with backend)

Tests performed:
1. Health endpoint connectivity
2. Voice settings (TTS, STT, TalkMode config)
3. STT server status and available models
4. STT transcription with generated audio
5. TTS voices and synthesis endpoints
6. OpenCode session creation
7. Full talk mode flow: Audio -> STT -> Send to OpenCode -> Poll for response

## Browser E2E Test (Real Audio Pipeline)

Test the complete voice pipeline using Chrome's fake audio capture:

```bash
# Start the app with Cloudflare tunnel
pnpm start

# Wait for startup (~90s for model loading), then note the tunnel URL
# Example: https://wallet-geographical-task-governance.trycloudflare.com

# Run browser E2E test over tunnel (headless)
bun run scripts/test-browser.ts --url https://YOUR-TUNNEL-URL.trycloudflare.com

# Run with visible browser for debugging
bun run scripts/test-browser.ts --url https://YOUR-TUNNEL-URL.trycloudflare.com --no-headless

# Local testing (no tunnel)
bun run scripts/test-browser.ts --url http://localhost:5001

# Use Web Audio API injection (alternative to fake audio device)
bun run scripts/test-browser.ts --web-audio
```

This test:
1. Generates test audio using macOS `say` command (or espeak/pico2wave on Linux)
2. Launches Chrome with `--use-file-for-fake-audio-capture` flag OR Web Audio API injection
3. Opens the app, navigates to a session, starts Talk Mode
4. Chrome captures audio from the fake device instead of microphone
5. Audio flows through real STT pipeline (MediaRecorder → /api/stt/transcribe → Whisper)
6. Verifies transcription matches expected text
7. Waits for OpenCode to respond and verifies the answer

Requirements:
- macOS with `say` command OR Linux with espeak/pico2wave
- `ffmpeg` installed (`brew install ffmpeg`)
- Chromium/Chrome installed (Puppeteer downloads automatically)

### Cloudflare Tunnel Notes

The tunnel uses HTTP/2 protocol to avoid QUIC conflicts with Tailscale VPN:
- QUIC protocol causes Cloudflare Error 1033 when Tailscale is running
- Backend must be healthy before starting tunnel (models take ~90s to load)
- The `pnpm start` command handles this automatically

## Code Style

- No comments, self-documenting code only
- No console logs (use Bun's logger or proper error handling)
- Strict TypeScript everywhere, proper typing required
- Named imports only: `import { Hono } from 'hono'`, `import { useState } from 'react'`

### Backend (Bun + Hono)

- Hono framework with Zod validation, Better SQLite3 database
- Error handling with try/catch and structured logging
- Follow existing route/service/utility structure
- Use async/await consistently, avoid .then() chains
- Test coverage: 80% minimum required

### Frontend (React + Vite)

- @/ alias for components: `import { Button } from '@/components/ui/button'`
- Radix UI + Tailwind CSS, React Hook Form + Zod
- React Query (@tanstack/react-query) for state management
- ESLint TypeScript rules enforced
- Use React hooks properly, no direct state mutations

### General

- DRY principles, follow existing patterns
- Use SOLID principles throughout design and implementation:
  - **Single Responsibility**: Each module/class/function should have one reason to change—keep responsibilities focused.
  - **Open/Closed**: Entities should be open for extension, closed for modification—prefer adding new code over altering stable code.
  - **Liskov Substitution**: Subtypes must be substitutable for their base types—no breaking expected behavior when swapping implementations.
  - **Interface Segregation**: Prefer small, specific interfaces over large, general ones—clients shouldn’t depend on methods they don’t use.
  - **Dependency Inversion**: Depend on abstractions, not concretions—inject dependencies and avoid hard-coding implementations.
- YAGNI: Don’t build or keep code you don’t need. If you change something, remove the unused parts. use the new code or keep the old, but don’t keep both.
- Never leave dead code: remove unused code, commented-out blocks, and unused variables/imports.
- ./temp/opencode is reference only, never commit has opencode src
- Use shared types from workspace package (@opencode-manager/shared)
- OpenCode server runs on port 5551, backend API on port 5001
- Prefer pnpm over npm for all package management
- Run `pnpm lint` after completing tasks to ensure code quality