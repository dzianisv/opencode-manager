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
- [x] Update local E2E runner to start backend/frontend on alternate ports
- [x] Disable screencast deduplication for UI E2E tests
- [x] Run local UI E2E tests (no Docker) and capture artifacts
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
- [ ] Validate by restarting with `--tunnel` and observing stable recovery
- [ ] Commit and push
