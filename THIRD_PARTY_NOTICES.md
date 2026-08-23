# Third-party notices

The release bundles code or runtime assets from these projects. Their license files are copied into `extension/vendor/` by the runtime build where applicable.

| Component | Version | License |
|---|---:|---|
| @uzen/kokoro-js | 1.2.4 | Apache-2.0 |
| @huggingface/transformers | 4.2.0 | Apache-2.0 |
| onnxruntime-web | 1.26.0 development build pinned by dependency lock | MIT |
| phonemizer | resolved by lockfile | MIT |
| pinyin-pro | resolved by lockfile | MIT |
| pdfjs-dist | 6.2.108 | Apache-2.0 |
| React / React DOM | lockfile versions | MIT |
| React Aria Components | lockfile version | Apache-2.0 |

Model weights are not bundled. Kokoro model licensing and the immutable model revision are shown before download. Local Qwen model files are separately downloaded and verified from their configured repository.
