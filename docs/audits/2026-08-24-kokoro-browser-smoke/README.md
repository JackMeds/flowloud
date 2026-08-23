# Kokoro real-browser smoke evidence

Date: 2026-08-24 (Asia/Shanghai)

Browser: Microsoft Edge installed at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

Model: `onnx-community/Kokoro-82M-v1.1-zh-ONNX`

Pinned revision: `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3`

## Results

- WASM full run: PASS. Download verification passed, Edge was closed and relaunched, the browser was switched offline, cache verification passed, and synthesis returned a WAV payload of about 186 KB.
- WebGPU full run: PASS. The cached model initialized on `webgpu` without fallback, survived an offline browser restart, and returned the same WAV payload size.
- Cancellation run: PASS. A clean-profile download emitted progress, accepted cancellation, returned the normalized `cancelled` error, and completed cache cleanup.
- Runtime selection: one ORT 1.26 Asyncify `.mjs`/`.wasm` pair supports the WebGPU build and its WASM execution provider. The unreferenced JSEP, JSPI, standard ORT variants, duplicate Transformers.js runtime, and legacy VITS runtime are not shipped.

## Commands

```powershell
node scripts/browser-model-smoke.mjs --model kokoro-zh --mode full --dtype fp32 --device wasm --keep-cache --timeout-minutes 35
node scripts/browser-model-smoke.mjs --model kokoro-zh --mode full --dtype fp32 --device webgpu --reuse-profile --keep-cache --timeout-minutes 20
node scripts/browser-model-smoke.mjs --model kokoro-zh --mode cancel --dtype fp32 --device wasm --profile .tmp-browser-model-cancel-smoke --timeout-minutes 10
```

The test also exposed and fixed three cold-start issues: an unsupported `chrome-extension:` Cache Storage key, a voice-cache URL mapping mismatch, and a Transformers.js 4.2 tokenizer metadata probe that omitted the pinned revision.
