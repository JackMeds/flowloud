# Flowloud

## Short description

Read web pages with system voices, Kokoro, local speech services, or your own APIs; extract and translate images and selected PDF pages.

## Description

Flowloud extracts articles, discussions, novels, and general page content while preserving paragraphs and speakers. It also provides a session-only OCR/translation workbench for webpage text, screenshots, images, and selected PDF pages.

- System voices work immediately and are the default
- Opt-in local Kokoro v1.1 Chinese/English browser model
- Loopback-only adapters for Qwen, GPT-SoVITS, CosyVoice, and local OpenAI-compatible speech services
- OpenAI-compatible online TTS; API keys are session-only by default
- Local digital-PDF text extraction and configurable OpenAI Chat/Responses, Ollama, or Flowloud OCR/translation Profiles
- Semantic page guide for landmarks, headings, text, lists, tables, controls, and images
- No telemetry, advertising, or background collection

The page guide never activates controls and is not a screen-reader replacement.

## Permission justification

- `storage`: settings, voices, and model-cache metadata.
- `unlimitedStorage`: user-requested browser models and local voice data.
- `offscreen`: uninterrupted audio after the popup closes.
- `activeTab` and `scripting`: access only the current page after a user gesture.
- Optional hosts: loopback services, Hugging Face downloads, and the exact TTS/OCR/translation API origin configured by the user.
