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

# Plan: Fix Browser E2E Screencast (sparse GIF)

## Goal

Make the browser E2E test (`test-browser.ts`) produce a rich screencast GIF instead of just 2 frames.

## Problem

The browser E2E test only takes screenshots at ~8 specific milestones (event-driven). After deduplication, only 2 frames survive, producing a poor demo GIF in PR comments.

## Approach

Add `AutoScreenshotter` (already used in `test-settings.ts`) to `test-browser.ts` with 1-second intervals. This captures the browser state continuously, producing many frames for a smooth GIF.

## Steps

- [x] Import `AutoScreenshotter` from `video-recorder.ts`
- [x] Start auto-screenshotter after first page creation (1s interval)
- [x] Handle page swap mid-test (stop old, start new screenshotter)
- [x] Stop screenshotter in `finally` block before GIF creation
- [ ] Commit and push to trigger CI

---

# Plan: Stabilize Cloudflare Tunnel Recovery

## Goal

Prevent opencode-manager tunnel disconnects from persisting by cleaning up orphaned cloudflared processes and auto-restarting when health drops.

## Problem

Duplicate cloudflared processes can start without coordination, causing the tunnel to disconnect. There is no watchdog to detect `haConnections=0` and restart the tunnel.

## Approach

Add startup cleanup for orphaned cloudflared processes, wait for prior tunnel shutdown, and run a watchdog to restart the tunnel after consecutive failed health checks.

## Steps

- [x] Identify tunnel lifecycle gaps and cleanup behavior
- [x] Add startup cleanup to terminate orphaned cloudflared processes
- [x] Wait for previous tunnel PID to exit with SIGKILL fallback
- [x] Add watchdog to monitor tunnel health and restart on failure
- [ ] Validate by restarting with `--tunnel` and observing stable recovery
- [ ] Commit and push
