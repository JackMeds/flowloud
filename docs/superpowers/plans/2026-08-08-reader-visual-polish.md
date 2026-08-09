# Reader Visual Polish Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the approved circular generated-logo control, aurora highlight, centered follow behavior, and flash-free UI bootstrap.

**Architecture:** Keep the existing closed Shadow DOM and playback state machine. Add a stylesheet readiness gate at host bootstrap, update only the presentation layer and follow scroll option, and package generated PNG assets through the existing Manifest V3 build.

**Tech Stack:** Manifest V3, vanilla JavaScript/CSS, Node test runner, Python Pillow for image resizing.

---

### Task 1: Add failing regressions

**Files:**
- Create: `extension/tests/reader-visual-contract.test.cjs`
- Modify: `extension/tests/browser/ui-harness.html`

1. Assert stylesheet readiness hides the host before load and reveals it after load.
2. Assert automatic following uses `block: "center"` while manual-scroll suppression remains effective.
3. Assert the orb markup uses an image and CSS is 40px circular.
4. Run focused tests and observe the expected failures.

### Task 2: Add panel width and page click-to-read

**Files:**
- Modify: `extension/content/reader.js`
- Modify: `extension/content/reader.css`
- Modify: `extension/tests/reader-visual-contract.test.cjs`
- Modify: `extension/tests/browser/ui-harness.html`

1. Persist a clamped 300–640px panel width and expose both a range control and drag handle.
2. Add a persisted page-click reading toggle.
3. Resolve clicked content nodes back to the first matching queue segment and seek it.
4. Ignore links, buttons, form controls, editable content, and extension UI.

### Task 3: Implement visual and bootstrap changes

**Files:**
- Modify: `extension/content/reader.js`
- Modify: `extension/content/reader.css`
- Modify: `extension/manifest.json`
- Create: `extension/assets/qwen-reader-{16,32,48,128,512}.png`

1. Gate host visibility on stylesheet load and remove it on stylesheet failure.
2. Switch follow scrolling to centered alignment.
3. Replace the letter mark with the generated image asset.
4. Replace outline highlighting with aurora underline and subtle text glow.
5. Resize/restyle the floating button as a 40px circle.
6. Add extension icon declarations and packaged assets.

### Task 4: Verify and deploy

1. Run focused tests, then the complete Node test suite.
2. Run the in-app browser UI/extractor harness.
3. Package the extension and verify required files.
4. Copy only scoped changed files/assets into the currently loaded Edge extension directory and verify hashes.
5. Review the final diff and commit only scoped source, tests, specs, plan, and assets.
