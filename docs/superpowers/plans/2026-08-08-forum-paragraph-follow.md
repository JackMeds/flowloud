# Forum Paragraph Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve real paragraph boundaries in forum posts and stop automatic scrolling whenever the user manually browses the page until they explicitly choose “回到当前朗读”.

**Architecture:** Add a focused forum semantic-content module that turns cleaned HTML/DOM into paragraph units with stable locators, then let all forum adapters emit one normalized block per semantic unit. Add a source-locator resolver and a pure follow-state controller; `content/reader.js` composes them to update paragraph highlighting and perform minimal `nearest` scrolling only while follow mode is active.

**Tech Stack:** Manifest V3 JavaScript, browser DOM APIs, existing UMD-style `globalThis.QwenReader*` modules, Node.js built-in test runner, Codex in-app browser harnesses.

## Global Constraints

- Manual scroll never auto-resumes; only an explicit “回到当前朗读” action restores follow mode.
- Forum semantic units are `p`, `h1`–`h6`, and `li`; blockquotes, signatures, controls, reactions, ads, link previews, attachments, image metadata, images, and empty nodes are excluded.
- Two- or three-character replies remain valid; only empty/control-only units are discarded.
- Paragraph splitting must preserve `postId`, `floor`, `authorId`, `authorName`, and `isOp`, so existing author/voice allocation remains unchanged.
- Long TTS chunks from one paragraph share the same `sourceLocator` and must not cause repeated scrolling.
- All listeners and locators remain page-local; no new permissions, network services, or telemetry are introduced.
- Do not modify or stage the unrelated in-progress files `extension/background.js` and `extension/tests/background-offscreen.test.cjs`.
- Specification: `docs/superpowers/specs/2026-08-08-forum-paragraph-follow-design.md`.

---

### Task 1: Forum semantic-content module

**Files:**
- Create: `extension/shared/forum-content.js`
- Create: `extension/tests/forum-content.test.cjs`

**Interfaces:**
- Consumes: `globalThis.QwenReaderText.cleanText(value)` when available; browser `DOMParser`/DOM nodes in production.
- Produces: `globalThis.QwenReaderForumContent` with:
  - `fingerprint(value: string): string`
  - `semanticUnitsFromHtml(html: string, options?: { DOMParserCtor?: Function, removeBlockquotes?: boolean }): SemanticUnit[]`
  - `semanticUnitsFromElement(root: Element, options?: { removeBlockquotes?: boolean }): SemanticUnit[]`
  - `semanticElements(root: Element, options?: { removeBlockquotes?: boolean }): Element[]`
  - `readableElementText(element: Element, options?: object): string`
- `SemanticUnit` is `{ text: string, unitIndex: number, fingerprint: string }`.

- [ ] **Step 1: Write failing semantic-unit tests**

Create `extension/tests/forum-content.test.cjs` that loads `shared/text.js` and the not-yet-created `shared/forum-content.js`, then specifies exact filtering and fallback behavior:

```js
test('forum HTML becomes separate semantic units without images or quotes', () => {
  const content = loadForumContent();
  const units = content.semanticUnitsFromHtml([
    '<blockquote><p>旧引用</p></blockquote>',
    '<p>第一段</p>',
    '<p><img src="x.jpg" alt="image350×318 24.5 KB"></p>',
    '<h2>小标题</h2>',
    '<p>同意</p>',
    '<div class="Post-actions"><button>点赞</button></div>'
  ].join(''), { removeBlockquotes: true });

  assert.deepEqual(units.map((unit) => unit.text), ['第一段', '小标题', '同意']);
  assert.deepEqual(units.map((unit) => unit.unitIndex), [0, 1, 2]);
  assert.equal(new Set(units.map((unit) => unit.fingerprint)).size, 3);
});

test('forum HTML falls back to one block when it has no semantic child tags', () => {
  const content = loadForumContent();
  assert.deepEqual(
    content.semanticUnitsFromHtml('<div>非标准论坛正文</div>').map((unit) => unit.text),
    ['非标准论坛正文']
  );
});
```

Also cover nested list markup without duplicate parent/child speech and a one-character `<p>`.

- [ ] **Step 2: Run the tests and verify RED**

Run from `extension`:

```powershell
node --test tests/forum-content.test.cjs
```

Expected: FAIL because `shared/forum-content.js` and `QwenReaderForumContent` do not exist.

- [ ] **Step 3: Implement the minimal semantic-content API**

Create a UMD-style module following the existing shared modules:

```js
(function attachForumContent(global) {
  'use strict';

  const SEMANTIC_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li';
  const REMOVABLE_SELECTOR = [
    'blockquote', 'script', 'style', 'noscript', 'template', 'svg', 'figure',
    '.Post-actions', '.Post-controls', '.signature', '.reactions', '.onebox',
    '.link-preview', '.attachment', '.image-metadata', '.file-info',
    '[role="toolbar"]', '[aria-hidden="true"]'
  ].join(',');

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function toUnits(texts) {
    return texts.filter(Boolean).map((text, unitIndex) => ({
      text,
      unitIndex,
      fingerprint: fingerprint(text)
    }));
  }

  global.QwenReaderForumContent = Object.freeze({
    fingerprint,
    semanticUnitsFromHtml,
    semanticUnitsFromElement,
    semanticElements,
    readableElementText
  });
})(globalThis);
```

`semanticElements(root)` must return the original live descendant elements so the reader can highlight them. It filters out candidates inside removable ancestors and excludes nested semantic parents when their descendant semantic elements already represent the same content. `readableElementText(element)` clones only that individual candidate before removing forbidden descendants and reading `textContent`; it never returns a cloned element. For parsed HTML, the parser-owned document is already disposable. For Node tests without `DOMParser`, implement a non-executing string fallback that removes forbidden containers, extracts `p/h1-h6/li` contents, strips tags/entities, and falls back to one cleaned block only when no semantic tag yields text. Never read `img.alt`, filenames, dimensions, or URLs.

- [ ] **Step 4: Run Task 1 tests and all existing extractor tests**

```powershell
node --test tests/forum-content.test.cjs tests/extractors.test.cjs
```

Expected: all tests PASS with no warnings or unhandled errors.

- [ ] **Step 5: Commit Task 1**

```powershell
git add extension/shared/forum-content.js extension/tests/forum-content.test.cjs
git commit -m "feat: extract forum semantic paragraphs"
```

---

### Task 2: Emit paragraph blocks from every forum adapter

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/shared/extractors.js:171-218,259-284,380-444,544-595,683-731`
- Modify: `extension/shared/normalized-document.js:38-52,84-100`
- Modify: `extension/tests/extractors.test.cjs`
- Modify: `extension/tests/normalized-document.test.cjs`
- Modify: `extension/tests/browser/extractor-harness.html`

**Interfaces:**
- Consumes: `QwenReaderForumContent.semanticUnitsFromHtml`, `semanticUnitsFromElement`, and `fingerprint` from Task 1.
- Produces: one normalized block per forum semantic unit with a structured locator:

```js
sourceLocator: {
  adapter: 'flarum',
  containerSelector: '.PostStream-item[data-id="123"] .Post-body',
  unitIndex: 4,
  fingerprint: 'abc123'
}
```

- `NormalizedDocument.createBlock()` and `toPlaybackSegments()` preserve a defensive copy of this object.

- [ ] **Step 1: Add failing Flarum paragraph and metadata tests**

Extend `extractors.test.cjs`:

```js
test('Flarum keeps paragraph boundaries and speaker metadata inside one post', () => {
  const { parseFlarumApi } = loadModules();
  const blocks = parseFlarumApi({
    data: [{
      type: 'posts', id: '48666-1',
      attributes: { number: 1, contentHtml: '<p>第一段</p><p>第二段</p><p>同意</p>' },
      relationships: { user: { data: { type: 'users', id: 'op' } } }
    }],
    included: [{ type: 'users', id: 'op', attributes: { username: '楼主' } }]
  });

  assert.deepEqual(blocks.map((block) => block.text), ['第一段', '第二段', '同意']);
  assert.ok(blocks.every((block) => block.authorId === 'op' && block.floor === 1 && block.isOp));
  assert.deepEqual(blocks.map((block) => block.sourceLocator.unitIndex), [0, 1, 2]);
  assert.equal(new Set(blocks.map((block) => block.sourceLocator.fingerprint)).size, 3);
});
```

Add equivalent multi-paragraph assertions for Discourse and NodeBB API payloads and XenForo/Flarum DOM fallback in `extractor-harness.html`. Preserve the existing short-reply, quote-removal, anonymous-author, pagination, and OP tests.

- [ ] **Step 2: Add a failing locator propagation test**

Extend `normalized-document.test.cjs` so `toPlaybackSegments(document, 5)` creates multiple audio chunks from one long paragraph and asserts:

```js
assert.deepEqual(chunks[0].sourceLocator, locator);
assert.deepEqual(chunks[1].sourceLocator, locator);
assert.notEqual(chunks[0].sourceLocator, locator);
assert.notEqual(chunks[0].sourceLocator, chunks[1].sourceLocator);
```

The last two assertions require defensive copies and prevent one playback item from mutating another.

- [ ] **Step 3: Run the focused tests and verify RED**

```powershell
node --test tests/extractors.test.cjs tests/normalized-document.test.cjs
```

Expected: FAIL because forum adapters still emit one block per post and `createBlock()` drops `sourceLocator`.

- [ ] **Step 4: Load the semantic-content module before extractors**

Add `shared/forum-content.js` immediately after `shared/text.js` in `manifest.json`. Update every Node/browser test loader that evaluates `extractors.js` to load `forum-content.js` first.

- [ ] **Step 5: Expand forum posts into semantic blocks**

Add one shared helper inside `extractors.js`:

```js
function expandForumPost(meta, contentSource, options) {
  const units = contentSource && typeof contentSource === 'object'
    ? ForumContent.semanticUnitsFromElement(contentSource, options)
    : ForumContent.semanticUnitsFromHtml(contentSource, options);
  return units.map((unit) => block(Object.assign({}, meta, {
    id: `${meta.id}:unit:${unit.unitIndex}`,
    text: unit.text,
    sourceLocator: {
      adapter: meta.adapter,
      containerSelector: meta.containerSelector,
      unitIndex: unit.unitIndex,
      fingerprint: unit.fingerprint
    }
  })));
}
```

Change Flarum, Discourse, NodeBB, and XenForo mappings from `map(block)` to `flatMap(expandForumPost)`. API and DOM fallbacks must use the same content container selector and semantic filtering. Keep `sourceSelector` as a post-level fallback, and use content-specific `containerSelector` values:

- Flarum: `.PostStream-item[data-id="<id>"] .Post-body`
- Discourse: `article[data-post-id="<id>"] .cooked, article#post_<id> .cooked`
- NodeBB: `[component="post"][data-pid="<id>"] [component="post/content"]`
- XenForo: `.message--post[data-content="post-<id>"] .message-body .bbWrapper, #js-post-<id> .message-body .bbWrapper`

- [ ] **Step 6: Preserve structured locators through normalization and chunking**

Add a `normalizeSourceLocator()` helper in `normalized-document.js` that accepts only strings/numbers for `adapter`, `containerSelector`, `unitIndex`, and `fingerprint`, returns `null` for invalid input, and returns a new object for every call. `createBlock()` stores it; `toPlaybackSegments()` calls `createBlock()` for each chunk, creating independent locator copies.

- [ ] **Step 7: Run focused and full Node tests**

```powershell
node --test tests/forum-content.test.cjs tests/extractors.test.cjs tests/normalized-document.test.cjs tests/voice-assignment.test.cjs
npm test
```

Expected: both commands PASS. Existing voice-assignment tests prove that paragraph expansion does not leak the OP voice to replies or change an author within a post.

- [ ] **Step 8: Commit Task 2**

```powershell
git add extension/manifest.json extension/shared/extractors.js extension/shared/normalized-document.js extension/tests/extractors.test.cjs extension/tests/normalized-document.test.cjs extension/tests/browser/extractor-harness.html
git commit -m "fix: preserve forum paragraph boundaries"
```

---

### Task 3: Resolve paragraph locators back to live DOM nodes

**Files:**
- Create: `extension/shared/source-locator.js`
- Create: `extension/tests/source-locator.test.cjs`
- Modify: `extension/manifest.json`

**Interfaces:**
- Consumes: `QwenReaderForumContent.semanticElements`, `readableElementText`, and `fingerprint`.
- Produces: `globalThis.QwenReaderSourceLocator.resolve(document, block): Element | null`.
- Resolution priority: fingerprint match nearest to `unitIndex`, then exact `unitIndex`, then `sourceSelector`, then `null`.

- [ ] **Step 1: Write failing resolver tests with real behavior-oriented stubs**

Create `source-locator.test.cjs` with a fake document/container whose semantic nodes expose distinguishable text. Specify:

```js
test('resolver prefers a fingerprint match after DOM order changes', () => {
  const target = node('目标段落');
  const document = fakeDocument([node('插入段落'), node('第一段'), target]);
  const resolved = locator.resolve(document, {
    sourceSelector: '.post',
    sourceLocator: {
      adapter: 'flarum', containerSelector: '.post .Post-body',
      unitIndex: 1, fingerprint: forumContent.fingerprint('目标段落')
    }
  });
  assert.equal(resolved, target);
});
```

Also test duplicate fingerprints choose the candidate closest to `unitIndex`, index fallback, post-level fallback, and missing-container `null`.

- [ ] **Step 2: Run the resolver test and verify RED**

```powershell
node --test tests/source-locator.test.cjs
```

Expected: FAIL because `shared/source-locator.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Create the module:

```js
function resolve(document, block) {
  const source = block || {};
  const locator = source.sourceLocator;
  if (locator && locator.containerSelector) {
    const container = safeQuery(document, locator.containerSelector);
    if (container) {
      const nodes = ForumContent.semanticElements(container, { removeBlockquotes: true });
      const matches = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => ForumContent.fingerprint(
          ForumContent.readableElementText(node, { removeBlockquotes: true })
        ) === locator.fingerprint);
      if (matches.length) {
        matches.sort((a, b) => Math.abs(a.index - locator.unitIndex) - Math.abs(b.index - locator.unitIndex));
        return matches[0].node;
      }
      if (nodes[locator.unitIndex]) return nodes[locator.unitIndex];
    }
  }
  return safeQuery(document, source.sourceSelector);
}
```

All selector errors return `null`; the resolver never throws into playback.

- [ ] **Step 4: Load the resolver before `content/reader.js` and run tests**

Add `shared/source-locator.js` after `shared/extractors.js` in `manifest.json`.

```powershell
node --test tests/forum-content.test.cjs tests/source-locator.test.cjs tests/extractors.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add extension/shared/source-locator.js extension/tests/source-locator.test.cjs extension/manifest.json
git commit -m "feat: resolve forum paragraph locators"
```

---

### Task 4: Pure follow-state controller

**Files:**
- Create: `extension/shared/follow-controller.js`
- Create: `extension/tests/follow-controller.test.cjs`
- Modify: `extension/manifest.json`

**Interfaces:**
- Produces `globalThis.QwenReaderFollow` with:
  - `createController(): { mode, markManual(), resume(), reset(), canFollow() }`
  - `isScrollIntent(event, context): boolean`
  - `isWithinSafeViewport(rect, viewportHeight): boolean`
- `mode` is exactly `'following'` or `'manual'`.
- `context` is `{ host?: Element, viewportWidth: number, scrollbarThreshold?: number }`.

- [ ] **Step 1: Write failing state and intent tests**

Create `follow-controller.test.cjs`:

```js
test('manual mode never resumes without an explicit action', () => {
  const follow = loadFollow().createController();
  follow.markManual();
  assert.equal(follow.mode, 'manual');
  assert.equal(follow.canFollow(), false);
  follow.reset();
  assert.equal(follow.mode, 'following');
});

test('wheel touch paging keys and scrollbar pointer are manual scroll intent', () => {
  const api = loadFollow();
  assert.equal(api.isScrollIntent({ type: 'wheel', composedPath: () => [] }, context), true);
  assert.equal(api.isScrollIntent({ type: 'touchmove', composedPath: () => [] }, context), true);
  assert.equal(api.isScrollIntent({ type: 'keydown', key: 'PageDown', target: plainTarget }, context), true);
  assert.equal(api.isScrollIntent({ type: 'pointerdown', clientX: 995, composedPath: () => [] }, { viewportWidth: 1000 }), true);
});
```

Also assert inputs/contenteditable elements and events whose composed path includes the extension host do not disable following. Test safe viewport boundaries at 15% and 85% of viewport height.

- [ ] **Step 2: Run the test and verify RED**

```powershell
node --test tests/follow-controller.test.cjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal pure controller**

Use a closure-backed mode and an explicit paging-key set:

```js
const PAGING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function createController() {
  let mode = 'following';
  return {
    get mode() { return mode; },
    markManual() { mode = 'manual'; },
    resume() { mode = 'following'; },
    reset() { mode = 'following'; },
    canFollow() { return mode === 'following'; }
  };
}
```

`isScrollIntent()` ignores extension-panel paths and editable controls. Pointer intent is true only inside the rightmost `scrollbarThreshold` pixels, defaulting to 24. `isWithinSafeViewport()` requires the target to intersect the vertical band from 15% to 85% of the viewport.

- [ ] **Step 4: Load the controller before the reader and run tests**

Add `shared/follow-controller.js` after `shared/source-locator.js` in `manifest.json`.

```powershell
node --test tests/follow-controller.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add extension/shared/follow-controller.js extension/tests/follow-controller.test.cjs extension/manifest.json
git commit -m "feat: model user-controlled reading follow"
```

---

### Task 5: Integrate paragraph highlighting and explicit follow recovery

**Files:**
- Modify: `extension/content/reader.js:1-17,85-120,120-160,360-460,783-864,889-958`
- Modify: `extension/content/reader.css`
- Modify: `extension/tests/browser/ui-harness.html`

**Interfaces:**
- Consumes: `QwenReaderSourceLocator.resolve(document, segment)` and `QwenReaderFollow` from Tasks 3–4.
- Produces: paragraph-level highlighting, minimal `nearest` scrolling, a manual follow state, and a `[data-action="resume-follow"]` button labelled “回到当前朗读”.

- [ ] **Step 1: Extend the browser harness with a failing follow contract**

Add two paragraph nodes and two playback segments with distinct `sourceLocator` values. Stub each paragraph’s `scrollIntoView` to record calls, then assert the full interaction:

```js
await click('[data-action="play-toggle"]');
assert.equal(firstParagraph.classList.contains('qwen-reader-speaking'), true);
assert.deepEqual(scrollCalls[0], { behavior: 'smooth', block: 'nearest' });

window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
await click('[data-action="next"]');
assert.equal(secondParagraph.classList.contains('qwen-reader-speaking'), true);
assert.equal(scrollCalls.length, 1);
assert.ok(root.querySelector('[data-action="resume-follow"]'));

await click('[data-action="resume-follow"]');
assert.equal(scrollCalls.length, 2);
assert.equal(root.querySelector('[data-action="resume-follow"]'), null);
```

Add a second case where the next paragraph’s rectangle is inside the safe viewport and verify no scrolling occurs. Add a long-paragraph case with two TTS chunks sharing one locator and verify the second chunk does not scroll again.

- [ ] **Step 2: Run the UI harness and verify RED**

Serve the worktree on loopback and open `extension/tests/browser/ui-harness.html` in the Codex in-app browser.

Expected: harness reports FAIL because scrolling is still forced with `block: 'center'`, wheel intent is ignored, and the recovery button does not exist.

- [ ] **Step 3: Bind manual scroll intent without observing generic `scroll` events**

In `reader.js`, instantiate one controller and attach capture listeners for `wheel`, `touchmove`, `keydown`, and `pointerdown`. Use `QwenReaderFollow.isScrollIntent(event, { host, viewportWidth: document.documentElement.clientWidth })`. Do not listen to generic `scroll`; this avoids mistaking the extension’s own smooth scroll for user input.

When intent is detected:

```js
followController.markManual();
renderNow();
```

The handler does not pause audio and does not clear highlighting.

- [ ] **Step 4: Resolve and highlight only the current source paragraph**

Replace the direct selector-first lookup in `highlightCurrent()` with `SourceLocator.resolve(document, segment)`, retaining existing generic/readability fallbacks for non-forum content. Keep the existing highlight when the resolved element is unchanged so multiple chunks from one paragraph do not flash.

Before scrolling, require all of:

```js
followController.canFollow()
&& !Follow.isWithinSafeViewport(element.getBoundingClientRect(), window.innerHeight)
&& currentLocatorKey !== lastScrolledLocatorKey
```

Call only:

```js
element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
```

Record a locator key composed from adapter, container selector, unit index, and fingerprint.

- [ ] **Step 5: Add explicit resume and reset semantics**

Handle `data-action="resume-follow"` by calling `followController.resume()`, clearing `lastScrolledLocatorKey`, invoking `highlightCurrent({ forceFollow: true })`, and rerendering the current view.

Reset to `following` only when `scanCurrentPage()` starts a new non-dynamic queue or when `handleLocationChange()` invalidates the page. Pause/resume and dynamic reply merges retain the current mode.

- [ ] **Step 6: Render and style the recovery button**

In `renderNow()`, display this only when a current queue exists, status is `playing`, `paused`, or `loading`, and mode is `manual`:

```html
<button class="qr-follow-button" type="button" data-action="resume-follow" aria-label="回到当前朗读">
  回到当前朗读
</button>
```

Style it as a compact secondary pill adjacent to the progress/controls area. It must remain inside the existing Shadow DOM panel, never cover page text, and use existing focus-visible tokens.

- [ ] **Step 7: Run Node tests and the UI browser harness**

```powershell
npm test
```

Then reload `extension/tests/browser/ui-harness.html` in the Codex in-app browser.

Expected: all Node tests PASS and the browser harness reports PASS for paragraph highlighting, manual-scroll suppression, explicit recovery, in-viewport suppression, and same-paragraph chunk deduplication.

- [ ] **Step 8: Commit Task 5**

```powershell
git add extension/content/reader.js extension/content/reader.css extension/tests/browser/ui-harness.html
git commit -m "fix: respect manual scrolling during playback"
```

---

### Task 6: Full regression, real-page structure proof, and packaging

**Files:**
- Modify only if an acceptance failure requires a focused correction: files already listed in Tasks 1–5 and their matching tests.
- Verify: `extension/tests/browser/extractor-harness.html`
- Verify: `extension/tests/browser/ui-harness.html`
- Verify: `package-extension.ps1`
- Verify: `https://bbs.viva-la-vita.org/d/48666`

**Interfaces:**
- Consumes: completed paragraph extraction, locators, follow controller, and reader integration.
- Produces: a packaged extension and fresh evidence for every acceptance requirement.

- [ ] **Step 1: Validate JavaScript syntax**

From `extension`, run:

```powershell
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Expected: exit code 0 and no syntax errors.

- [ ] **Step 2: Run the complete automated suite**

```powershell
npm test
```

Expected: exit code 0, zero failed tests, zero cancelled tests, and zero unhandled rejections.

- [ ] **Step 3: Run both browser harnesses in the Codex in-app browser**

Serve the worktree through a loopback static server and open:

- `extension/tests/browser/extractor-harness.html`
- `extension/tests/browser/ui-harness.html`

Expected: both pages report PASS. Finalize the harness tabs after recording their results.

- [ ] **Step 4: Verify the exact module against the real Flarum page**

Open `https://bbs.viva-la-vita.org/d/48666` in the Codex in-app browser. Inject the built `shared/text.js` and `shared/forum-content.js` source into the page’s isolated test context, then run:

```js
QwenReaderForumContent
  .semanticUnitsFromElement(document.querySelector('.PostStream-item[data-number="1"] .Post-body'), {
    removeBlockquotes: true
  })
  .length
```

Expected: exactly `28`. Confirm every returned unit has non-empty text and a unique sequential `unitIndex`. Do not print or persist the full page text.

- [ ] **Step 5: Verify manual-scroll behavior with the structural real-page fixture**

Use the browser harness populated with 28 paragraph nodes matching the real page structure. Start playback, dispatch wheel intent, advance at least three segments, and verify `scrollIntoView` does not increase until “回到当前朗读” is clicked. Confirm the OP voice remains identical across all 28 segments.

- [ ] **Step 6: Package the extension**

From the worktree root, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\package-extension.ps1
```

Expected: exit code 0 and a new package containing `shared/forum-content.js`, `shared/source-locator.js`, `shared/follow-controller.js`, updated manifest, reader files, and no test-only files.

- [ ] **Step 7: Review diff scope and commit any acceptance-only correction**

```powershell
git status --short
git diff --check
git diff --stat 2f3661b..HEAD
```

Expected: the unrelated dirty `background.js` and `background-offscreen.test.cjs` remain unstaged and unchanged by this plan. If Task 6 required a correction, stage only its production file and matching regression test, rerun Steps 1–6, then commit:

```powershell
git commit -m "test: verify forum paragraph follow regression"
```

If no correction was required, do not create an empty commit.

## Acceptance Checklist

- `48666` OP structure produces 28 semantic paragraph units.
- Current paragraph, not the entire post, receives `qwen-reader-speaking`.
- Image names, dimensions, attachment metadata, quotes, controls, and empty image-only paragraphs are absent from speech text.
- OP metadata and voice remain stable across every OP paragraph; reply authors never receive the OP voice.
- Already visible paragraphs do not scroll; offscreen paragraphs scroll with `block: 'nearest'` only once per source paragraph.
- Wheel, touch, paging keys, and scrollbar drag enter `manual` mode.
- Playback and highlighting continue in `manual`; page movement remains zero across subsequent segments.
- Only “回到当前朗读” restores following and performs one immediate return scroll.
- New pages/new queues reset following; pause/resume and dynamic merges do not.
- All Node tests, browser harnesses, syntax checks, and packaging pass with fresh evidence.
