# OpenCode Manager - QA Testing System

This directory contains the QA testing agent and related test automation for the OpenCode Manager project.

## Files

- **`agent/qa-tester.md`** - OpenCode subagent for autonomous QA testing
- **`commands/qa-test.sh`** - Quick test command for common scenarios
- **`templates/test-report-template.md`** - Professional test report template

## Using the QA Testing Agent

### Method 1: Ask OpenCode Directly (Recommended)

The `qa-tester` agent is automatically available in OpenCode. Simply ask:

```
"Test the application comprehensively and generate a report"
```

or mention the agent explicitly:

```
"@qa-tester run a full test suite on the development server"
```

OpenCode will automatically invoke the QA agent, which will:
1. Run all test protocols systematically
2. Evaluate results against expected behavior
3. Generate a professional test report
4. Provide recommendations for any issues found

### Method 2: Via Quick Test Script

Use the quick test script for common scenarios:

```bash
# Quick health check
.opencode/commands/qa-test.sh health

# Test API endpoints
.opencode/commands/qa-test.sh api http://localhost:5001

# Test authentication
export AUTH_USERNAME=admin
export AUTH_PASSWORD=secret
.opencode/commands/qa-test.sh auth http://localhost:5001

# Test Cloudflare tunnel
.opencode/commands/qa-test.sh tunnel

# Test Docker deployment
.opencode/commands/qa-test.sh docker

# Run E2E tests
.opencode/commands/qa-test.sh e2e http://localhost:5003

# Run full test suite
.opencode/commands/qa-test.sh full
```

### Method 3: Manual Testing

Follow the test protocols in the agent file:

```bash
# Read the agent instructions
cat .opencode/agent/qa-tester.md

# Follow the protocols for your specific test needs
```

## Test Protocols

The QA agent can test:

### 1. Development Server Testing
- Start/stop services
- Verify processes and ports
- Health check validation

### 2. Backend API Testing
- All REST endpoints
- OpenCode proxy
- Database operations
- WebSocket connections

### 3. Authentication Testing
- Basic Auth enabled/disabled
- Valid/invalid credentials
- Authorization headers
- Protected endpoints

### 4. Cloudflare Tunnel Testing
- Tunnel startup and URL generation
- HTTPS accessibility
- Public endpoint testing
- Tunnel stability

### 5. Docker Deployment Testing
- Image build and run
- Container health checks
- Volume persistence
- Multi-service orchestration

### 6. E2E Testing
- Voice features (STT/TTS)
- Talk Mode functionality
- Browser automation tests
- Production readiness checks

### 7. Database Testing
- Schema validation
- Data integrity
- Query performance
- Migration testing

### 8. Git Operations Testing
- Repository operations
- Branch switching
- Diff generation
- Clone and sync

## Test Result Format

The QA agent reports results in this format:

```markdown
## Test Run: [Test Name]
**Date:** 2026-01-07 12:30
**Environment:** local
**Status:** PASS

### Setup
- Command: `pnpm dev`
- Prerequisites: None

### Results
| Test Case | Expected | Actual | Status |
|-----------|----------|--------|--------|
| Health check | 200 OK | 200 OK | ✅ |
| Repos endpoint | Returns array | Returns array | ✅ |
| OpenCode proxy | Forwards request | Forwards request | ✅ |

### Issues Found
None

### Performance Metrics
- Health check: 45ms
- API avg response: 120ms
- Frontend load: 1.2s
- Memory usage: 145 MB

### Recommendations
1. All systems operational
2. Performance within acceptable range
```

## Quick Reference

### Common Test Commands

```bash
# Health check
curl http://localhost:5001/api/health | jq '.'

# Check all services
ps aux | grep -E "(bun|vite|opencode)" | grep -v grep

# Test with auth
curl -u user:pass http://localhost:5001/api/health

# Start tunnel
pnpm start

# Run E2E tests
bun run scripts/run-e2e-tests.ts
```

### Service Ports

- **5001** - Backend API (development)
- **5003** - Backend API (production/Docker)
- **5173** - Frontend dev server (Vite)
- **5551** - OpenCode server
- **5552** - Whisper STT server
- **5553** - Chatterbox TTS server

### Test Files

Backend tests:
```bash
cd backend
bun test
bun test:coverage
```

Frontend tests:
```bash
cd frontend
npm run test
npm run test:coverage
```

E2E tests:
```bash
bun run scripts/test-voice-e2e.ts
bun run scripts/test-talkmode-e2e.ts
bun run scripts/test-talkmode-browser.ts
bun run scripts/run-e2e-tests.ts
```

## Evaluation Criteria

Tests should verify:

- ✅ **Functionality** - All features work as expected
- ✅ **Security** - Auth blocks unauthorized access
- ✅ **Performance** - Response times < 500ms
- ✅ **Reliability** - No crashes or errors
- ✅ **Deployment** - Docker/Azure deploy succeeds
- ✅ **Integration** - OpenCode server connects
- ✅ **Data** - Database operations succeed

## Troubleshooting

### Tests Fail to Start
- Check if services are running: `ps aux | grep bun`
- Verify ports available: `lsof -i :5001 -i :5173`
- Check logs: `tail -f backend.log`

### Auth Tests Fail
- Verify AUTH_USERNAME and AUTH_PASSWORD set
- Check Hono middleware in `backend/src/index.ts`
- Test with curl: `curl -v -u user:pass http://localhost:5001/api/health`

### Tunnel Tests Fail
- Check cloudflared installed: `which cloudflared`
- Verify process: `ps aux | grep cloudflared`
- Review logs: `cat /tmp/tunnel.log`

### Docker Tests Fail
- Check image exists: `docker images | grep opencode-manager`
- Verify container running: `docker ps`
- View logs: `docker logs opencode-manager`

## Contributing

To add new tests:

1. Update `subagents/qa-tester.md` with new protocols
2. Add test cases to `commands/qa-test.sh` if needed
3. Document expected behavior
4. Include evaluation criteria
5. Add troubleshooting steps

## Integration with CI/CD

The QA agent can be integrated into CI/CD pipelines:

```yaml
# .github/workflows/qa-tests.yml
- name: Run QA Tests
  run: |
    # Start services
    docker compose up -d
    
    # Wait for health
    sleep 30
    
    # Run tests
    .opencode/commands/qa-test.sh full http://localhost:5003
    
    # Run E2E
    bun run scripts/run-e2e-tests.ts --url http://localhost:5003
```

## License

Same as the main project (see LICENSE in root).
