<!-- jackmeds-brand:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/hero-dark.svg">
  <img src="assets/brand/hero-light.svg" alt="Flowloud / 流声 — Read the web. Listen your way." width="1200">
</picture>
<!-- jackmeds-brand:end -->

# Flowloud / 流声

Listen to long pages, and find your place in every sentence.

Flowloud is an Edge and Chrome extension for web reading, OCR and translation. Start with system speech, then choose a browser model, local service or your own cloud API when you need it.

[Quick start](#quick-start) · [Alpha distribution](docs/install.md) · [Full reference (中文)](docs/usage-reference.zh-CN.md) · [中文](README.md)

## In use

![Flowloud's actual document workspace: locally parsed fictional text blocks](assets/brand/product-proof.png)

The screenshot shows real local parsing of fictional example text, without online OCR, translation or speech generation. [Capture provenance](docs/brand-proof.md).

The current sentence, toolbar controls and page location stay connected. Reading continues when the popup closes; closing the source tab stops that page's task.

## What it does

- **Read articles and conversations.** Extract ordinary pages and Discourse, Flarum and NodeBB threads; assign voices to the original poster, narrator and reply authors.
- **Keep your place.** Sentence and word highlighting, previous/next controls and return-to-text navigation respect manual scrolling.
- **Choose where speech runs.** System speech is the default. Kokoro in the browser, loopback-only local services, OpenAI-compatible TTS and native Doubao TTS are optional.
- **Work with documents.** Open webpages, pasted text, images and selected PDF pages. Extract digital PDF text locally; use configured profiles for OCR and translation.
- **Navigate without taking over.** Explore headings and page regions with keyboard, reduced-motion and high-contrast support. The guide does not click controls or submit forms for you.

## Quick start

The current version is `0.10.0-alpha.1`. Store distribution is limited to registered testers; see the [installation notes (中文)](docs/install.md). To load the source build:

```bash
git clone https://github.com/JackMeds/flowloud.git
cd flowloud
```

1. Open `edge://extensions/` or `chrome://extensions/` and enable Developer mode.
2. Choose **Load unpacked** and select the repository's **`extension/`** directory, the canonical runtime and release source.
3. Refresh an article or forum page, open Flowloud from the toolbar and wait for detected paragraphs.
4. Keep system speech selected and start reading. Use previous/next or `Alt+O` to pause and resume.

The default speech path needs no API key, model download or local gateway. Windows users can also run `.\package-extension.ps1` in PowerShell and load `dist\Flowloud-Edge`. Do not load `extension-wxt/` as the complete extension.

## Privacy and limitations

Page content is parsed on the device. Opening a page does not start playback or download models. Choosing online TTS sends the selected text to your authorized HTTPS service. Image, screenshot and scanned-PDF OCR requires a vision-capable profile and upload confirmation; translation sends only the selected text blocks. Credentials are session-only by default, with an explicit option to remember them locally.

Windows and Edge are the main validated environment; Chrome has a separate packaging and testing workflow. Browser-internal pages, extension stores and restricted pages cannot run content scripts. Browser Kokoro uses preset voices without voice cloning. OCR model weights are not bundled. The page guide is reading assistance, not a replacement for a system screen reader.

[Privacy policy](docs/privacy.md) · [Delete data](docs/data-deletion.md) · [Provider capabilities and data flow](docs/providers.md) — detailed documents are currently in Chinese.

## Development and documentation

The [full reference](docs/usage-reference.zh-CN.md) retains voice settings, gateway commands, streaming endpoints and source layout. See [frontend migration](docs/frontend-migration.md), [browser testing](docs/automated-browser-testing.md), [adding providers](docs/adding-provider.md) and [release notes](docs/release-notes-0.10.0-alpha.1.md).

For isolated UI previews, use Node.js 22+ and pnpm:

```bash
cd extension-wxt
pnpm install
pnpm storybook
```

Storybook previews UI states. Follow the browser testing guide for full-runtime verification with the `extension/` directory and an isolated Chromium profile.

The extension carries an [MIT license](extension/LICENSE). Third-party code and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [Readability license](extension/vendor/readability/LICENSE.md).
