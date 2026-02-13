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
