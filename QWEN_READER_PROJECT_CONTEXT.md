# Flowloud project context

This file is a short orientation aid. The authoritative design is [ARCHITECTURE.md](ARCHITECTURE.md); setup and checks are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Current product

Flowloud 0.10 adds a visible OCR/translation workbench next to webpage TTS. It accepts current-page text, pasted text, the visible-tab screenshot, images and selected PDF pages. Digital PDF text is local; scanned pages use a selected OCR Profile. Results are session-only, editable, block-aligned and reusable by the existing TTS path.

## Source ownership

- `extension/` is the production/store source.
- `extension-wxt/` owns React UI source.
- `scripts/sync-wxt-ui.cjs` copies WXT output into `extension/`; synchronized chunks and HTML are generated.
- `src/` is the optional Windows loopback gateway.
- `dist/` and `.tmp-*` are generated and must not be treated as source.

## Contracts

- TTS: Provider V4 in `extension/shared/provider-v4.js`.
- Shared provider primitives: `extension/shared/provider-core.js`.
- OCR/translation: Document/Language Provider V1 in `extension/shared/document-provider-v1.js`.
- Settings: Schema V6 in `extension/shared/settings-schema.js`.
- Workbench UI: `extension-wxt/components/DocumentWorkbench.tsx`.

The browser model is only pinned Kokoro v1.1 Chinese/English. It has preset voices, not voice cloning. Weights are on-demand cache data, not ZIP contents. Qwen and other large models run behind local services; their model ID, quantization and reference audio are configurable.

## Non-negotiable boundaries

- No document history database or OpenAI Files upload.
- No bundled OCR weights or Qwen weights.
- No silent provider fallback.
- No keys, page text, images, reference audio or full model responses in logs/diagnostics.
- Remote APIs require HTTPS; HTTP is only for loopback.
- Add adapters through manifests/contracts, not vendor branches in UI code.

## Release

Version is `0.10.0-alpha.1`; Chromium manifest version is `0.10.0.1`. Run `scripts/package-release.ps1`. Both store ZIPs must be at most 12 MB and include SHA-256 files.
