# QA Testing System - Quick Start Guide

Get started with the OpenCode Manager QA testing system in minutes.

## What You Get

1. **QA Testing Agent** (`.opencode/agent/qa-tester.md`)
   - OpenCode subagent for autonomous testing
   - Comprehensive test protocols
   - Professional report generation
   - Actionable recommendations

2. **Quick Test Command** (`.opencode/commands/qa-test.sh`)
   - Fast health checks
   - API endpoint testing
   - Auth validation
   - Tunnel and Docker tests

3. **Test Report Template** (`.opencode/templates/test-report-template.md`)
   - Professional format
   - Pre-structured sections
   - Ready for stakeholders

## Quick Start

### Method 1: Ask OpenCode (Easiest)

Simply ask OpenCode to test the application:

```
"Test the application and generate a comprehensive report"
```

Or mention the QA agent directly:

```
"@qa-tester run a full test suite on the development server"
```

The QA agent will:
- ✅ Run all tests automatically
- ✅ Evaluate results
- ✅ Generate professional report
- ✅ Provide recommendations

### Method 2: Quick Command-Line Tests

#### A. Run a Quick Health Check

```bash
# From project root
.opencode/commands/qa-test.sh health

# Expected output:
# 🧪 OpenCode Manager QA Test Suite
# ==================================
# Test Type: health
# Target URL: http://localhost:5001
#
# Running health checks...
#
# 1. Backend Health
# ✅ Backend responding
#
# 2. OpenCode Server
# ✅ OpenCode server healthy
#
# 3. Database
# ✅ Database exists
#
# ✅ Tests completed
```

#### B. Test All API Endpoints

```bash
.opencode/commands/qa-test.sh api http://localhost:5001

# This will test:
# - /api/health
# - /api/repos
# - /api/settings/opencode-configs
```

#### C. Test Authentication

```bash
# First, set credentials
export AUTH_USERNAME=testuser
export AUTH_PASSWORD=testpass123

# Start backend with auth
bun backend/src/index.ts &

# Run auth tests
.opencode/commands/qa-test.sh auth http://localhost:5001

# Expected output:
# Testing without credentials...
# ✅ Correctly rejected (401)
#
# Testing with credentials...
# ✅ Correctly authenticated (200)
```

### 4. Test Cloudflare Tunnel

```bash
.opencode/commands/qa-test.sh tunnel

# This will:
# 1. Start tunnel with pnpm start
# 2. Wait for URL generation
# 3. Test public accessibility
# 4. Clean up
```

### 5. Test Docker Deployment

```bash
# First, build and run
./scripts/run-local-docker.sh

# Then test
.opencode/commands/qa-test.sh docker

# Expected output:
# Testing Docker deployment...
#
# Checking Docker image...
# ✅ Docker image exists
#
# Checking running containers...
# ✅ Container running
#
# Testing container health...
# ✅ Container healthy
```

### 6. Run Full Test Suite

```bash
.opencode/commands/qa-test.sh full

# This runs:
# - health
# - api
# - auth (if AUTH_USERNAME set)
# - docker
```

### 7. Run E2E Tests

```bash
# Start services first
./scripts/run-local-docker.sh

# Then run E2E
bun run scripts/run-e2e-tests.ts --url http://localhost:5003

# Or use the command
.opencode/commands/qa-test.sh e2e http://localhost:5003
```

## Using the QA Agent in OpenCode

### Method 1: Ask OpenCode to Test

Just ask in natural language:

```
You: "Test the application health and API endpoints"

OpenCode will:
1. Read .opencode/subagents/qa-tester.md
2. Follow the test protocols
3. Run appropriate commands
4. Report results
```

### Method 2: Use Task Tool with Specific Instructions

In your OpenCode prompt:

```
Please test the OpenCode Manager application following the QA protocols in 
.opencode/subagents/qa-tester.md

Focus on:
1. Backend health checks
2. API endpoint validation
3. Authentication (with AUTH_USERNAME=test, AUTH_PASSWORD=pass123)
4. Report results using the template in .opencode/templates/test-report-template.md

Target URL: http://localhost:5001
```

### Method 3: Run Specific Test Protocols

```
Please run the "Authentication Testing" protocol from .opencode/subagents/qa-tester.md

Test credentials:
- Username: admin
- Password: mysecretpass

Report any failures with:
1. Expected behavior
2. Actual behavior
3. HTTP status codes
4. Logs/errors
```

## Test Scenarios

### Scenario 1: Pre-Deployment Validation

Before deploying to production:

```bash
# 1. Start services
pnpm dev

# 2. Run health check
.opencode/commands/qa-test.sh health

# 3. Test API
.opencode/commands/qa-test.sh api

# 4. Test with auth (set in .env)
export AUTH_USERNAME=admin AUTH_PASSWORD=yourpass
.opencode/commands/qa-test.sh auth

# 5. Test Docker build
docker compose up -d
.opencode/commands/qa-test.sh docker

# 6. Run E2E
bun run scripts/run-e2e-tests.ts

# All pass? Ready to deploy!
```

### Scenario 2: Post-Deployment Verification

After deploying to Azure:

```bash
# Get tunnel URL from deployment
bun run scripts/deploy.ts --status

# Test the deployed instance
TUNNEL_URL="https://your-tunnel.trycloudflare.com"

# Test health
curl "$TUNNEL_URL/api/health"

# Test with auth
curl -u admin:password "$TUNNEL_URL/api/health"

# Test repos endpoint
curl -u admin:password "$TUNNEL_URL/api/repos"
```

### Scenario 3: Regression Testing

After code changes:

```bash
# 1. Run unit tests
cd backend && bun test
cd frontend && npm run test

# 2. Run integration tests
.opencode/commands/qa-test.sh full

# 3. Run E2E tests
bun run scripts/run-e2e-tests.ts

# 4. Generate report
# Use template: .opencode/templates/test-report-template.md
```

### Scenario 4: Performance Testing

Check if performance is acceptable:

```bash
# Test response times
for i in {1..10}; do
  curl -w "@curl-format.txt" -o /dev/null -s http://localhost:5001/api/health
done

# curl-format.txt:
# time_total: %{time_total}s\n
```

## Interpreting Results

### ✅ Success Indicators

- HTTP 200 responses
- JSON responses valid
- Services responding
- No error logs
- Performance within targets

### ❌ Failure Indicators

- HTTP 500 errors
- Timeout errors
- Services not responding
- Error logs present
- Performance degraded

### ⚠️ Warning Indicators

- HTTP 401/403 (check if expected)
- Slow response times
- Deprecated warnings
- Missing optional features

## Common Issues

### Issue: "Backend not responding"

```bash
# Check if running
ps aux | grep bun

# Check port
lsof -i :5001

# Check logs
cat backend.log

# Restart
pnpm dev:backend
```

### Issue: "401 Unauthorized"

```bash
# Check if auth enabled
grep AUTH_USERNAME .env

# Verify credentials
echo $AUTH_USERNAME
echo $AUTH_PASSWORD

# Test with curl verbose
curl -v -u $AUTH_USERNAME:$AUTH_PASSWORD http://localhost:5001/api/health
```

### Issue: "Tunnel URL not generated"

```bash
# Check cloudflared installed
which cloudflared

# Check process
ps aux | grep cloudflared

# Check logs
cat /tmp/tunnel.log

# Try manual start
cloudflared tunnel --url http://127.0.0.1:5001
```

### Issue: "Docker container exits"

```bash
# Check logs
docker logs opencode-manager

# Check volumes
docker volume ls

# Try interactive
docker run -it ghcr.io/dzianisv/opencode-manager sh

# Check health
docker inspect opencode-manager | jq '.[0].State.Health'
```

## Advanced Usage

### Custom Test Scripts

Create your own test script using the QA agent as reference:

```bash
#!/bin/bash
# custom-test.sh

# Source the QA protocols
QA_GUIDE=".opencode/subagents/qa-tester.md"

# Your custom test logic
echo "Running custom tests..."

# Test specific feature
curl http://localhost:5001/api/your-endpoint

# Evaluate results
if [ $? -eq 0 ]; then
  echo "✅ Custom test passed"
else
  echo "❌ Custom test failed"
fi
```

### CI/CD Integration

Add to your `.github/workflows/test.yml`:

```yaml
- name: Run QA Tests
  run: |
    # Start services
    docker compose up -d
    sleep 30
    
    # Run tests
    .opencode/commands/qa-test.sh full http://localhost:5003
    
    # Run E2E
    bun run scripts/run-e2e-tests.ts --url http://localhost:5003
    
    # Generate report
    # (Use template and upload as artifact)
```

### Automated Reporting

Generate test reports automatically:

```bash
# Run tests with tee to capture output
.opencode/commands/qa-test.sh full | tee test-output.txt

# Copy template
cp .opencode/templates/test-report-template.md test-report.md

# Fill in results (manual or scripted)
# Upload to PR or issue tracker
```

## Next Steps

1. **Explore the QA Agent**
   - Read: `.opencode/subagents/qa-tester.md`
   - Understand all test protocols
   - Learn evaluation criteria

2. **Run Your First Test**
   - Start with health check
   - Progress to full suite
   - Generate a test report

3. **Integrate into Workflow**
   - Add to CI/CD pipeline
   - Run before deployments
   - Schedule regular runs

4. **Customize for Your Needs**
   - Modify test scripts
   - Add custom protocols
   - Create team standards

## Resources

- **QA Agent:** `.opencode/subagents/qa-tester.md`
- **Test Command:** `.opencode/commands/qa-test.sh`
- **Report Template:** `.opencode/templates/test-report-template.md`
- **E2E Tests:** `scripts/test-*.ts`
- **Main README:** `README.md`

## Support

If you encounter issues:

1. Check the QA agent troubleshooting section
2. Review test logs
3. Check service status
4. Ask OpenCode for help with specific error messages

Happy Testing! 🧪
