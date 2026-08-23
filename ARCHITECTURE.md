# Flowloud architecture

Flowloud is one product with three runtime boundaries:

1. The MV3 extension owns page extraction, settings, permissions, global playback coordination and release packaging.
2. The WXT/React application owns the popup, settings, voice tools and document/translation workbench UI.
3. Optional loopback or cloud providers own model inference. The extension does not bundle Qwen or OCR weights.

## Source of truth

| Path | Responsibility | Generated? |
|---|---|---|
| `extension/` | Production extension source and files shipped to stores | Mixed: `chunks/`, React HTML, React CSS and `react-ui-build.json` are synchronized build output |
| `extension-wxt/` | React/WXT UI source | No; `.output/` is generated |
| `extension/shared/` | Provider contracts, settings schema and shared document/playback models | No |
| `src/` | Windows loopback gateway | No |
| `scripts/` | Runtime build, UI sync, smoke tests and release gates | No |
| `dist/` | Chrome/Edge unpacked builds, ZIPs and hashes | Yes |

Do not hand-edit synchronized React chunks or HTML in `extension/`. Edit `extension-wxt/`, run its build, then run `node scripts/sync-wxt-ui.cjs`.

## Provider boundaries

`provider-core.js` contains transport-neutral identity, cancellation, timeout, registry and structured-error primitives. TTS remains Provider V4 because audio synthesis, voices, streaming and playback have different contracts from documents.

Document/Language Provider V1 exposes `probe`, `extract`, `translate` and `cancel`. Its stable values are:

- `ProviderManifest`: protocol, domain, capability, auth, input/output and streaming declarations.
- `DocumentArtifact`: stable block IDs, page, text and optional geometry/confidence.
- `TranslationArtifact`: the same block IDs with source, translation, status and warnings.

The workbench only depends on those artifacts. Adding a protocol adapter must not require changes to the workbench, task routing or TTS player.

## Document flow

The popup captures a visible-tab screenshot before opening the workbench. Current-page text is extracted in the source tab. PDF.js extracts digital PDF text locally; selected pages with no text layer are rendered to images and sent sequentially to the selected OCR Profile. Translation is bounded into batches and preserves block IDs. Documents, images and results remain in workbench memory for that tab session.

## Browser model flow

The extension ships one Kokoro runtime and one ONNX Runtime Web WASM pair. Kokoro v1.1 Chinese/English weights and selected voice vectors are downloaded from a fixed Hugging Face revision only after a user gesture and stored in browser Cache Storage. The pipeline is reused, can be disposed, and is recreated with remote access disabled before a download is marked verified. WebGPU failure is exposed with its stage/reason before WASM fallback.

Qwen 0.6B/1.7B and larger models run behind Ollama, vLLM-compatible services or the Flowloud loopback gateway, never inside the extension ZIP.

## Settings and secrets

Schema V6 preserves TTS settings and adds AI Profiles plus workbench defaults. Public settings contain no secret fields. API keys are stored in `chrome.storage.session` by default and only move to local storage after the corresponding “remember” choice. The background process requests only the selected provider's exact origin; remote HTTP is rejected and loopback HTTP is allowed.
