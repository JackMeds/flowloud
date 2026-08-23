# Document workbench real-browser smoke evidence

Date: 2026-08-24 (Asia/Shanghai)

Browser: Microsoft Edge, unpacked Manifest V3 extension

Network: local loopback fixture only; no cloud API or user document was used.

## Results

- Visible inputs: PASS — current page, pasted text, visible-area screenshot, image upload, and PDF upload.
- Visible workflows: PASS — OCR only, translation only, and OCR followed by translation.
- Pasted text: PASS — two source blocks were translated, rendered in paired columns, edited, and retried as one block.
- Cancellation: PASS — an in-flight delayed translation exposed the cancel control and returned to an idle UI.
- Image OCR: PASS — a real PNG file-selection event reached the OpenAI Chat-compatible loopback adapter and rendered the structured OCR block.
- Digital PDF: PASS — PDF.js loaded its packaged Worker, extracted a one-page text layer locally, displayed the page selector, and processed the selected page without OCR upload.
- Screenshot seed: PASS — opening the workbench through the background entry captured the active page and showed the in-session preview.
- Current page: PASS — the seeded source tab was extracted into document blocks without starting playback.
- React settings and Popup: PASS — the OCR/translation settings tab is visible; protected Provider credential inputs and the four Popup tabs rendered from release assets.

The smoke test exposed and fixed a release-sync omission where the hashed `pdf.worker-*.mjs` asset existed in WXT output but was not copied into `extension/`. The release gate now requires that Worker in `react-ui-build.json`.

The native action-popup event was not exposed by this Playwright/Edge combination, so the test used the same packaged Popup as a direct extension page for layout checks. Toolbar anchoring and close-on-blur remain manual store-submission checks.
