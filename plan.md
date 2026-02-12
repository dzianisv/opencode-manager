# Plan: Tunnel Resilience - Circuit Breaker, Reachability Check, PID Guard, Watchdog Improvements

## Goal

Prevent Cloudflare tunnel failures from persisting undetected. Address all known failure modes: infinite restart loops, unverified URLs, dual-instance conflicts, and premature process kills.

## Issue: #62

## Problem

The tunnel watchdog has multiple failure modes:
1. "Tunnel not found" causes infinite restart loop (cloudflared retries forever, watchdog kills & restarts forever)
2. No URL reachability check after startup (regex match trusted blindly)
3. No instance guard (two opencode-manager processes fight over port 5001 via launchd KeepAlive)
4. Watchdog doesn't re-check before killing (tunnel may have recovered)

## Steps

- [x] Create GitHub issue #62
- [x] Create branch fix/tunnel-resilience-62
- [ ] 1. Circuit breaker + error detection
  - [ ] Parse cloudflared stderr for fatal errors ("Unauthorized", "Tunnel not found")
  - [ ] Set a `fatalError` flag on the tunnel process when detected
  - [ ] Track consecutive restart failures in watchdog state
  - [ ] After MAX_TUNNEL_RESTARTS (5) consecutive failures, stop retrying, log clear error
  - [ ] Reset counter when a restart succeeds (ha_connections > 0)
- [ ] 2. URL reachability check after start
  - [ ] After startCloudflaredTunnel() gets URL, HTTP HEAD to verify
  - [ ] Retry up to 3 times with 2s backoff
  - [ ] Only publish to endpoints.json after verification
- [ ] 3. Lock file / PID guard
  - [ ] Write PID lock file (~/.local/run/opencode-manager/manager.pid) on startup
  - [ ] Check lock file before starting; if PID alive, warn and exit
  - [ ] Clean up lock file on exit (SIGINT/SIGTERM handler)
- [ ] 4. Watchdog recovery improvements
  - [ ] Re-check ha_connections immediately before killing cloudflared
  - [ ] Add ±5s jitter to watchdog interval to desync from launchd ThrottleInterval (30s)
- [ ] Run tests (pnpm test)
- [ ] Create PR, verify CI
