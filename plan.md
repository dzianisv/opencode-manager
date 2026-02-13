# Plan: Stabilize Settings E2E CI Health Check

## Goal

Make Settings E2E CI reliably reach a healthy service state by avoiding flaky OpenCode installer version fetches during container startup.

## Problem

The Settings E2E job fails while waiting for `/api/health` because the container entrypoint installs OpenCode and the installer fails to fetch the latest version from GitHub (`Failed to fetch version information`). This keeps OpenCode from installing, so the service never becomes healthy.

## Approach

Pin the OpenCode installer to a known-good minimum version during container startup, with an override for future updates via `OPENCODE_INSTALL_VERSION`.

## Steps

- [x] Identify CI failure in Settings E2E workflow logs
- [x] Inspect container entrypoint OpenCode install flow
- [x] Update entrypoint to pass a pinned version to installer
- [ ] Re-run Settings E2E workflow to confirm health check passes
- [ ] Verify no regressions in other E2E jobs
- [ ] Commit and update PR

---

# Plan: Fix Browser E2E Screencast - Actually Show All Test Steps

## Goal

Fix the browser E2E screencast GIF so it shows the full test flow (home → session → voice active → transcription → response) instead of just 2-3 visually identical frames.

## Problem

The AutoScreenshotter was added (commit 823cafc) but the deduplication in `VideoRecorder` is too aggressive:
- Uses 95% similarity on 32x32 grayscale thumbnails with ±10 pixel tolerance
- Subtle UI changes (text in chat, button states, spinners) are treated as identical
- CI logs confirm: "Deduplicated: 17 → 3 screenshots" — 14 of 17 frames removed
- Result: GIF shows ~2 unique frames + final hold, which is useless as a test record

## Root Cause

The deduplication compares adjacent frames. During idle/waiting periods (which dominate runtime), auto-screenshots look nearly identical. Even meaningful transitions (voice button click, transcription appearing) differ by only a few pixels at 32x32 resolution, so they get removed too.

## Fix

1. **Never deduplicate manual keyframe screenshots** — screenshots from `takeScreenshot()` represent meaningful test milestones and must always be kept
2. **Reduce deduplication aggressiveness** — lower threshold and/or increase comparison resolution
3. **Add text annotations** to screenshots showing the current test step, making visually similar frames distinct

## Steps

- [x] Analyze the problem (dedup too aggressive, 17→3 frames in CI)
- [x] Read VideoRecorder deduplication code
- [x] Modify VideoRecorder to support "keyframe" screenshots that skip deduplication
- [x] Add step name annotations to screenshots via ffmpeg text overlay
- [x] Lower similarity threshold for auto screenshots (0.95 → 0.85)
- [x] Test locally to verify GIF shows full flow (22→7 frames, 6 keyframes preserved)
- [ ] Commit and push

---

# Plan: Stabilize Cloudflare Tunnel Recovery

## Goal

Prevent opencode-manager tunnel disconnects from persisting by cleaning up orphaned cloudflared processes and auto-restarting when health drops.

## Problem

Duplicate cloudflared processes can start without coordination, causing the tunnel to disconnect. There is no watchdog to detect `haConnections=0` and restart the tunnel.

## Approach

Add startup cleanup for orphaned cloudflared processes, wait for prior tunnel shutdown, and run a watchdog to monitor tunnel health and restart on failure.

## Steps

- [x] Identify tunnel lifecycle gaps and cleanup behavior
- [x] Add startup cleanup to terminate orphaned cloudflared processes
- [x] Wait for previous tunnel PID to exit with SIGKILL fallback
- [x] Add watchdog to monitor tunnel health and restart on failure
- [x] Validate by restarting with `--tunnel` and observing stable recovery
- [x] Commit and push

---

# Plan: Move Tunnel Watchdog from CLI to Backend Service (#67)

## Goal

Move the Cloudflare tunnel lifecycle (start, stop, watchdog) from `bin/cli.ts` into a proper backend service so it survives CLI crashes. The backend is the long-running process and should own the tunnel.

## Problem

The tunnel watchdog lives as an in-process `setInterval` in the CLI. When the CLI crashes, the watchdog dies and zombie cloudflared processes go undetected. The CLI also manages tunnel state files, process spawning, and cleanup — all of which belong in the backend.

## Approach

Create `TunnelService` in the backend following the existing service pattern (`whisper.ts`). Expose start/stop/restart via API. Update CLI to delegate tunnel management to the backend API instead of spawning cloudflared directly.

## Steps

- [x] Research all tunnel-related code across the codebase
- [x] Create GitHub issue #67
- [x] Create feature branch `feature/issue-67-backend-tunnel-service`
- [x] Create `backend/src/services/tunnel-service.ts` with full lifecycle management
  - Spawn/kill cloudflared, capture URL from stderr
  - Watchdog with circuit breaker (5 restarts / 10 min)
  - Health via Prometheus metrics (`cloudflared_tunnel_ha_connections`)
  - Tunnel reachability verification via HTTP HEAD
  - State file management (tunnel.json, tunnel.pid, endpoints.json)
  - Auth from env vars or auth.json
  - Stale state cleanup and orphan killing on start
  - Log rotation (10MB max, 2 backups)
- [x] Update `backend/src/routes/tunnel.ts` — add POST start/stop/restart endpoints
- [x] Update `backend/src/index.ts` — auto-start on `TUNNEL_ENABLED=true`, add to shutdown sequence
- [x] Update `bin/cli.ts` — remove ~200 lines of dead tunnel code, delegate to backend API
- [x] Update `backend/src/routes/services.ts` — add tunnel as managed service
- [x] Write and fix `backend/test/services/tunnel-service.test.ts` (17 tests pass)
- [x] Update `backend/test/routes/services.test.ts` (22 tests pass, tunnel included)
- [x] Run full test suite — 195 pass, 0 fail, 5 skip (no regressions)
- [x] Create PR
- [x] Resolve merge conflicts with main (lock file, port ownership, telegram tests)

---

# Plan: Telegram Test Coverage & Code Quality

## Goal

Add comprehensive test coverage for the Telegram/Messenger integration and fix code quality issues: duplicate `chunkText()`, unused `messageQueue` field.

## Issue: #65
## Branch: feature/issue-65-telegram-test-coverage

## Steps

- [x] 1. Extract duplicate `chunkText()` to shared utility
  - Create `shared/src/utils/text.ts` with `chunkText()` function
  - Export from `shared/src/index.ts`
  - Update `backend/src/services/messenger/providers/telegram.ts` to import from shared
  - Update `backend/src/services/messenger/service.ts` to import from shared
- [x] 2. Remove unused `messageQueue` field from `TelegramProvider`
  - Delete line 63: `private messageQueue: Map<string, Promise<void>> = new Map()`
- [x] 3. Create `backend/test/services/channel-registry.test.ts`
  - register/unregister channels
  - get/getAll/getAllIds
  - startAll/stopAll (with mock channels)
  - start/stop individual channels
  - getStatus/getAllStatuses
  - send() routing
  - onMessage/removeMessageHandler
  - Message broadcast from channel to registry handlers
- [x] 4. Create `backend/test/services/messenger-service.test.ts`
  - isAllowed() authorization logic (empty allowlist = allow all, populated = check)
  - addToAllowlist/removeFromAllowlist
  - getAllSessions/getAllowlist
  - deleteSession
  - seedAllowlistFromEnv
  - getOrCreateSession (mocked OpenCode API)
  - handleMessage flow (authorized vs unauthorized, with/without text)
  - sendToOpenCode SSE parsing (mocked fetch)
- [x] 5. Create `scripts/test-telegram.ts` E2E integration test
  - Tests API endpoints: GET /api/telegram/status, GET /api/telegram/sessions, etc.
  - Tests allowlist CRUD via API
  - Tests bot start/stop lifecycle (gracefully handles invalid tokens)
- [x] 6. Run `pnpm test` to verify all tests pass (235 tests, 13 files)
- [x] 7. Create PR referencing issue #65 -> https://github.com/dzianisv/opencode-manager/pull/66
- [x] 8. Fix `bot.init()` bug: grammy requires `bot.init()` before accessing `bot.botInfo`
  - Changed `bot.api.getMe()` to `await bot.init()` in `start()`
  - Wrapped `bot.botInfo` access in `getStatus()` with try/catch
  - Updated unit test mock to include `init` method
  - Updated test assertion from `getMe` to `init`
  - All 235 tests pass
- [x] 9. Fix `POST /start` empty body crash: wrap `c.req.json()` in try/catch
- [x] 10. Fix `isConfigured()` ordering: check before `getOrCreateSession()` to avoid fetch errors in CI
- [x] 11. Fix `vi.clearAllMocks()` resetting mock return values in tests
- [x] 12. All 237 tests pass (13 files)
- [x] 13. CI green on PR #66 (all 5 jobs passed)
- [x] 14. PR #66 merged (squash) → commit c2665ef
- [x] 15. Issue #65 closed as completed
