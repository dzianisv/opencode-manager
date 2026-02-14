---
name: qa-webapp
description: QA test the opencode-manager webapp end-to-end using Playwright MCP (playwriter). Use when you need to verify sessions, settings, voice, or any UI workflow works correctly.
metadata:
  author: opencode-manager
  version: "1.0"
---

QA test the opencode-manager webapp using the Playwright MCP (`playwriter_execute` tool).

## Prerequisites

- The webapp must be running (locally or via Cloudflare tunnel)
- The Playwright MCP (`playwriter_execute`) tool must be available
- If using basic auth, embed credentials in the URL: `https://user:pass@host`

## Quick Smoke Test (2 minutes)

### 1. Open the App

```js
state.myPage = await context.newPage();
await state.myPage.goto('https://USER:PASS@YOUR-URL', { waitUntil: 'domcontentloaded' });
await waitForPageLoad({ page: state.myPage, timeout: 5000 });
```

### 2. Verify Home Page Loads

```js
await accessibilitySnapshot({ page: state.myPage, showDiffSinceLastCall: false })
```

Expected: heading "Recent Sessions", "Repositories" section, session list with IDs and statuses.

### 3. Click Into a Session

Find a session in the snapshot output and click on its ID text:

```js
const sessionLink = state.myPage.locator('text=SESSION_ID_HERE');
await sessionLink.click();
await state.myPage.waitForLoadState('domcontentloaded');
await new Promise(r => setTimeout(r, 2000));
```

Verify navigation: URL should contain `/repos/N/sessions/ses_...`.

### 4. Send a Message

```js
const textbox = state.myPage.locator('role=textbox[name="Send a message..."]');
await textbox.click();
await textbox.fill('What files are in this directory?');
const sendBtn = state.myPage.locator('role=button[name="Send"]');
await sendBtn.click();
```

### 5. Verify Model Responds

Wait and check for activity:

```js
await new Promise(r => setTimeout(r, 10000));
await accessibilitySnapshot({ page: state.myPage, search: /Stop|Send/i })
```

- If "Stop" button is visible: model is actively processing (success)
- If "Send" button is visible: model finished, look for tool call results in the snapshot
- Look for tool call buttons like `"glob (completed)"`, `"Read ... 0.01s"`, etc.

## Full E2E Test Workflows

### Test: Session Prompt and Response

1. Open home page
2. Click on an existing session (or create new one)
3. Type a prompt and click Send
4. Wait for model to start processing (Stop button appears)
5. Optionally answer any `question` tool calls (select option + click Submit)
6. Wait for model to finish (Send button reappears)
7. Verify response content in the accessibility snapshot

### Test: Settings Dialog

Settings is a dialog, not a route. Open it from within a session view:

```js
// Must be inside a session view first
const settingsBtn = state.myPage.locator('role=button[name="Settings"]');
await settingsBtn.click();
await new Promise(r => setTimeout(r, 1000));
await accessibilitySnapshot({ page: state.myPage, showDiffSinceLastCall: false })
```

### Test: Providers Connected

```js
// Inside Settings dialog, click the Providers tab
const providersTab = state.myPage.locator('role=tab[name="Providers"]');
// Use native click - Radix UI tabs don't respond to evaluate-based clicks
await providersTab.click();
await new Promise(r => setTimeout(r, 1000));
await accessibilitySnapshot({ page: state.myPage, search: /Connected|Not Connected/i })
```

Verify providers show "Connected" status (Anthropic, GitHub Copilot, OpenAI, etc.).

### Test: Voice Settings

```js
// Inside Settings dialog, click the Voice tab
const voiceTab = state.myPage.locator('role=tab[name="Voice"]');
await voiceTab.click();
await new Promise(r => setTimeout(r, 1000));
await accessibilitySnapshot({ page: state.myPage, showDiffSinceLastCall: false })
```

Look for STT/TTS provider selectors and Test buttons.

### Test: Answer a Question Tool Call

When the model asks a question (multiple choice), a form appears at the bottom:

```js
// Select the recommended option
const option = state.myPage.locator('role=button[name*="Recommended"]');
await option.click();
// Submit the answer
const submitBtn = state.myPage.locator('role=button[name="Submit"]');
await submitBtn.click();
```

### Test: Navigate Back to Home

```js
// Click the back button (first unnamed button in header)
const backBtn = state.myPage.locator('role=button').first();
await backBtn.click();
await new Promise(r => setTimeout(r, 1000));
// Verify home page
await accessibilitySnapshot({ page: state.myPage, search: /Recent Sessions|Repositories/i })
```

## Key Patterns and Gotchas

### Page Management

Always create your own page in `state` to avoid interference:

```js
if (!state.myPage || state.myPage.isClosed()) {
  state.myPage = await context.newPage();
}
```

### SPA Navigation

Direct URL navigation to session pages may time out. Always navigate via the SPA by clicking from the home page.

### Radix UI Components

Radix UI tabs and dialogs require native Playwright `.click()` — `page.evaluate(() => el.click())` does NOT trigger React/Radix event handlers.

### Checking State After Actions

Always verify with a snapshot after any click or navigation:

```js
await accessibilitySnapshot({ page: state.myPage, showDiffSinceLastCall: true })
```

For complex visual layouts, use screenshots:

```js
await screenshotWithAccessibilityLabels({ page: state.myPage })
```

### Waiting for Model Processing

The model can take 30-120 seconds for complex tasks. Poll periodically:

```js
// Check every 15 seconds
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 15000));
  const snap = await accessibilitySnapshot({ page: state.myPage, search: /Stop|Send/i });
  if (snap && snap.includes('role=button[name="Send"]')) {
    console.log('Model finished');
    break;
  }
  console.log(`Still processing... (${(i+1)*15}s)`);
}
```

### Basic Auth in URLs

Embed credentials directly in the URL for tunnel/deployed environments:

```
https://admin:password@your-tunnel-url.trycloudflare.com
```

## Verification Checklist

After testing, confirm:

- [ ] Home page loads with session list and repository list
- [ ] Clicking a session navigates to the session view
- [ ] Prompt input accepts text and Send button works
- [ ] Model processes the prompt (tool calls appear, Stop button visible)
- [ ] Model completes and response is visible
- [ ] Settings dialog opens from session view
- [ ] Providers tab shows connected providers
- [ ] Voice tab shows STT/TTS configuration
- [ ] Navigation back to home works
