# Qwen Reader Content Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Edge extension into a cross-site, author-aware reader with automatic non-playing scans and an MV3-safe local Qwen request path.

**Architecture:** Forum-specific adapters and Mozilla Readability produce one normalized document schema before voice assignment. A route/session controller invalidates stale queues and drives explicit scan UI. Long local API operations move from the service worker to an offscreen extension document while the existing player and Qwen gateway contract remain intact.

**Tech Stack:** Manifest V3, plain JavaScript UMD modules, Node `node:test`, Mozilla Readability (Apache-2.0), Edge offscreen documents, local OpenAI-compatible Qwen3-TTS API.

## Global Constraints

- Keep `http://127.0.0.1:7811` and model alias `qwen3-tts-1.7b-base` unchanged.
- Scan automatically but never synthesize or play automatically.
- OP voice remains exclusive to the topic starter across all of that author's posts.
- Forum adapters preserve every non-empty short reply and run before Readability.
- All extension JavaScript and third-party code is local; no remote scripts or `eval()`.
- Existing floating orb, page panel, voice recording, idle GPU unload, and per-request voice switching remain available.
- Work in the current user-authorized workspace without creating a Git commit from the pre-existing untracked tree; record progress with tests and the plan checklist.

---

### Task 1: Normalized content model and forum adapter registry

**Files:**
- Create: `extension/shared/content-model.js`
- Create: `extension/shared/content-cleaner.js`
- Create: `extension/shared/adapters/flarum.js`
- Create: `extension/shared/adapters/discourse.js`
- Create: `extension/shared/adapters/nodebb.js`
- Create: `extension/shared/adapters/xenforo.js`
- Create: `extension/shared/adapters/registry.js`
- Modify: `extension/shared/extractors.js`
- Create: `extension/tests/content-model.test.cjs`
- Replace/extend: `extension/tests/extractors.test.cjs`
- Create: `extension/tests/fixtures/discourse-topic.json`
- Create: `extension/tests/fixtures/nodebb-topic.json`

**Interfaces:**
- Produces `QwenReaderContentModel.createDocument(input)`, `createBlock(input)`, and `pageKey(location)`.
- Each adapter exposes `{ id, canHandle(context), extract(context) }` and returns a normalized document or `null`.
- `QwenReaderExtractors.extractPage(document, fetchFn, options)` returns `NormalizedDocument`, never a bare array.

- [ ] **Step 1: Write failing normalized-model and adapter tests**

Tests must assert literal normalized output for: canonical page keys without hashes; Flarum DOM authors without `data-user-id`; all posts by the first author marked `isOp`; Discourse missing-post batching; NodeBB author/floor mapping; XenForo control removal; and preservation of “顶”/“同意”.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/content-model.test.cjs tests/extractors.test.cjs`

Expected: failure because the model and adapters do not exist and current `extractPage` returns an array.

- [ ] **Step 3: Implement the model, cleaner and adapters**

Use this adapter context contract:

```js
{
  document,
  location: document.location,
  fetch: fetchFn,
  signal: options && options.signal
}
```

All API requests use `credentials: 'same-origin'` and the supplied abort signal. Determine OP by the stable author key of the earliest post, not merely by floor one.

- [ ] **Step 4: Implement registry routing and compatibility exports**

Selection remains first. Registry order is Discourse, Flarum, NodeBB, XenForo, Readability (added in Task 2), then generic. Keep legacy named exports used by existing tests while moving their implementation behind adapters.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/content-model.test.cjs tests/extractors.test.cjs`

Then: `node --test tests/*.test.cjs`

Expected: all pass with the reader integration tests still pending until Task 3.

### Task 2: Mozilla Readability and robust article fallback

**Files:**
- Add: `extension/vendor/Readability.js` from the official pinned Mozilla release
- Create: `extension/vendor/README.md`
- Create: `extension/THIRD_PARTY_NOTICES.md`
- Create: `extension/shared/adapters/readability.js`
- Create or modify: `extension/shared/adapters/generic.js`
- Modify: `extension/manifest.json`
- Modify: `package-extension.ps1`
- Extend: `extension/tests/extractors.test.cjs`
- Extend: `extension/tests/browser/extractor-harness.html`

**Interfaces:**
- `readabilityAdapter.extract(context)` consumes global `Readability` and returns normalized article blocks.
- `genericAdapter` remains the last automatic fallback and marks source elements for highlighting.

- [ ] **Step 1: Add failing article tests**

Cover: Readability takes precedence over the generic scorer on an article page; nested buttons/aria-hidden controls never appear; a failed Readability parse falls through to generic; paragraph source markers map back to original DOM.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/extractors.test.cjs`

Expected: failure because no Readability adapter or robust generic cleaning exists.

- [ ] **Step 3: Vendor the official library and implement the adapter**

Parse a cloned document with `charThreshold: 200`. Never run Readability for a page already claimed by a forum adapter. Split the returned content by headings, paragraphs, list items and blockquotes; use text fingerprints to mark matching original elements.

- [ ] **Step 4: Harden the generic fallback**

Clone each readable block, remove interactive/hidden/control descendants, then read text. Do not use a positive length threshold beyond non-empty text for already selected blocks.

- [ ] **Step 5: Update local packaging and licenses**

Load `vendor/Readability.js` before adapter scripts. Include the pinned source and notices in `dist`; keep CSP remote-script checks effective.

- [ ] **Step 6: Run unit and browser-harness tests**

Run: `node --test tests/*.test.cjs`

Expected: all Node tests pass; browser harness reports PASS when opened in a browser.

### Task 3: Automatic scan lifecycle, explicit refresh UI and SPA invalidation

**Files:**
- Create: `extension/shared/page-session.js`
- Modify: `extension/shared/player-state.js`
- Modify: `extension/content/reader.js`
- Modify: `extension/content/reader.css`
- Create: `extension/tests/page-session.test.cjs`
- Extend: `extension/tests/player-state.test.cjs`
- Extend: `extension/tests/browser/ui-harness.html`

**Interfaces:**
- `QwenReaderPageSession.createRouteWatcher(options)` emits `{pageKey, reason}`.
- Player action `PAGE_INVALIDATE` clears the queue and transient playback metadata.
- Reader keeps `lastScannedPageKey`, `scanGeneration`, `scanAbortController`, `documentMeta`, `pendingRescan`.

- [ ] **Step 1: Add failing route/state/UI tests**

Cover: hash-only floor navigation keeps the same page key; topic path changes invalidate; stale scan generations are ignored; initial scan builds a queue without sending `tts:synthesize`; scan button label changes from “读取本页” to “重新读取”; saved default preset is applied without a user click.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/page-session.test.cjs tests/player-state.test.cjs`

Expected: failure because route watcher/state actions do not exist.

- [ ] **Step 3: Implement route watcher and generation-safe scanning**

Watch `pushState`, `replaceState`, `popstate`, `hashchange`, a 500 ms URL fallback, and debounced child-list mutations. On a new page key: cancel synthesis and scanning, stop audio, clear highlight and queue, then auto-scan without playback.

- [ ] **Step 4: Separate scan, assignment and playback UI**

Add a content status card and one explicit `data-action="scan-page"` button. Presets reassign only existing blocks. `togglePlayback()` calls `ensureCurrentDocument()` before playback but never depends on changing a preset.

- [ ] **Step 5: Reject invalid reply-voice settings before persistence**

If the proposed reply pool is empty, restore the previous checked state, show a Chinese actionable message, and do not call `saveSettings()`.

- [ ] **Step 6: Improve source highlighting**

Resolve `sourceSelector`/marked DOM nodes first, then use platform-specific post IDs/floors and text fingerprints as fallbacks.

- [ ] **Step 7: Run unit and UI harness tests**

Run: `node --test tests/*.test.cjs`

Expected: all tests pass; UI harness verifies automatic scan without TTS and manual re-scan.

### Task 4: MV3 offscreen Qwen runtime and resilient prefetch

**Files:**
- Create: `extension/offscreen.html`
- Create: `extension/offscreen.js`
- Create: `extension/shared/backend-router.js`
- Modify: `extension/background.js`
- Modify: `extension/shared/api-client.js`
- Modify: `extension/content/reader.js`
- Modify: `extension/voice-studio.js`
- Modify: `extension/manifest.json`
- Create: `extension/tests/backend-router.test.cjs`
- Extend: `extension/tests/api-client.test.cjs`
- Extend: `extension/tests/player-state.test.cjs`

**Interfaces:**
- Background handles `tts:prepare`, ensures one offscreen document, and continues to handle fast `tts:status`, toolbar and studio-opening operations.
- Backend operations use `{target: 'qwen-offscreen', type, ...}` and are answered only by offscreen.
- `backend-router.createBackendRouter({api, storage, timeoutMs})` handles synthesize, cancel, voices, save and delete.

- [ ] **Step 1: Add failing offscreen/router tests**

Cover: one offscreen document for concurrent prepare calls; synthesis bytes returned after an artificial delay without background owning the fetch; cancellation aborts the matching session; 60-second product timeout returns a Chinese envelope; backend PID change forces all local profiles, including same-name profiles, to re-register.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/backend-router.test.cjs tests/api-client.test.cjs`

Expected: failure because the backend router/offscreen host does not exist and same-name profiles are skipped.

- [ ] **Step 3: Move long backend operations to offscreen**

Use the offscreen `BLOBS` reason and convert binary WAV into a message-safe base64 envelope there. The service worker must not await `/v1/audio/speech`.

- [ ] **Step 4: Make local voice synchronization backend-generation aware**

After a backend-loading voices request, read `/health.backendPid`. On a new positive PID, re-register every saved browser profile once, even if the name already exists. Reuse missing-name behavior when no PID is exposed.

- [ ] **Step 5: Route reader and voice studio through offscreen**

Both callers prepare the document first. Preserve all reader-facing error envelopes and cancellation semantics.

- [ ] **Step 6: Fix prefetch retry behavior**

Cache rejected prefetch promises as failures, not `null`. When a taken prefetch rejects, retry the same segment once through a fresh foreground session before showing an error.

- [ ] **Step 7: Update permissions and tests**

Add `offscreen`; remove `tabs`; add offscreen files to packaging. Run `node --test tests/*.test.cjs` and require zero failures.

### Task 5: Documentation, packaging and end-to-end verification

**Files:**
- Modify: `extension/README.md`
- Modify: `extension/tests/browser/extractor-harness.html`
- Modify: `extension/tests/browser/ui-harness.html`
- Modify: `package-extension.ps1`
- Modify: `dist/Qwen-Reader-Edge/**` through the packaging script

**Interfaces:**
- Final unpacked extension remains `dist/Qwen-Reader-Edge`.

- [ ] **Step 1: Update usage documentation**

Document automatic recognition versus playback, adapter coverage, manual re-read, unknown-site fallback, local-only behavior, multiple voices and model wake delay.

- [ ] **Step 2: Run syntax, unit and packaging verification**

Run every production `.js` through `node --check`, run `node --test tests/*.test.cjs`, then run `package-extension.ps1`. All commands must exit zero.

- [ ] **Step 3: Verify packaged manifest and files**

Confirm MV3, `offscreen`, local host permission, local Readability asset, adapter scripts, no remote scripts/eval, and no tests copied into dist.

- [ ] **Step 4: Run browser harnesses in the Codex in-app browser**

Verify article controls are filtered, four forum fixture families normalize correctly, automatic scan occurs without audio, re-read works, and the panel remains usable.

- [ ] **Step 5: Exercise the real local endpoint**

With the user's existing gateway, synthesize at least two short segments with different registered voices and verify valid non-empty WAV results while the backend PID remains unchanged.

- [ ] **Step 6: Reload the unpacked Edge extension or provide the exact reload handoff**

If the in-app browser cannot manage `edge://extensions`, verify the built package and tell the user only the unavoidable reload click; do not claim a live Edge reload occurred.

- [ ] **Step 7: Final requirement review**

Re-read the approved design, map every acceptance item to fresh evidence, and report any unsupported real-world platform variant explicitly rather than calling it complete.
