# Flowloud

## Short description

Read web pages with system voices, browser models, local Qwen, or your own online TTS, plus a read-only semantic page guide.

## Description

Flowloud extracts articles, discussions, novels, and general page content while preserving paragraphs and speakers. It provides sentence and word highlighting during playback.

- System voices work immediately and are the default
- Opt-in local VITS and Kokoro browser models
- Optional Windows local Qwen backend with voice cloning
- OpenAI-compatible online TTS; API keys are session-only by default
- Semantic page guide for landmarks, headings, text, lists, tables, controls, and images
- No telemetry, advertising, or background collection

The page guide never activates controls and is not a screen-reader replacement.

## Permission justification

- `storage`: settings, voices, and model-cache metadata.
- `unlimitedStorage`: user-requested browser models and local voice data.
- `offscreen`: uninterrupted audio after the popup closes.
- `activeTab` and `scripting`: access only the current page after a user gesture.
- Optional hosts: local Qwen, Hugging Face downloads, and the user's configured online TTS origin.
