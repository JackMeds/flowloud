# Contributing to Flowloud

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and [Provider protocols](docs/providers.md). Keep business code dependent on capability contracts, not vendor names.

## Normal workflow

```powershell
cd extension-wxt
pnpm install
pnpm typecheck
pnpm build
cd ..
node scripts/sync-wxt-ui.cjs
node --test extension/tests/*.test.cjs
node scripts/release-gate.cjs
```

The complete Chrome/Edge release is produced by `scripts/package-release.ps1`. It rebuilds the Kokoro runtime, type-checks, builds both browsers, runs tests and the store gate, then creates ZIP/SHA256 artifacts. A ZIP larger than 12 MB fails packaging.

## Adding models and providers

- Browser models require an immutable revision, a local loader with no remote code, offline cache verification, cancellation and a release-size decision. The initial supported browser model is intentionally only Kokoro v1.1 Chinese/English.
- Qwen and other large models belong behind a service adapter. Model ID, quantization and reference audio are configuration, never compiled paths.
- Add a manifest and adapter, then register it. Do not add vendor conditionals to the workbench.
- Normalize every failure to a stable code and preserve request IDs. Never silently switch a cloud provider.
- Never log or export keys, full request/response bodies, page text, images or reference audio.

See [Adding a provider](docs/adding-provider.md) for the contract checklist.

## Generated files

Do not review or edit `extension/chunks/`, synchronized React HTML/CSS, WXT `.output/`, `dist/`, `.tmp-*` or runtime bundles as source. Regenerate them from their owning source. Keep tests focused on changed contracts instead of repeating broad repository reviews.
