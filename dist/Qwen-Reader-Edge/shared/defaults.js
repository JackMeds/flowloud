(function attachDefaults(global) {
  'use strict';

  global.QwenReaderDefaults = Object.freeze({
    apiBaseUrl: 'http://127.0.0.1:7811',
    model: 'qwen3-tts-1.7b-base',
    responseFormat: 'wav',
    providerId: 'local-qwen',
    providerVersion: 2,
    providerOptions: Object.freeze({
      baseUrl: 'http://127.0.0.1:7811',
      model: 'qwen3-tts-1.7b-base',
      responseFormat: 'wav',
    }),
    maxChunkChars: 260,
    voiceMode: 'op-exclusive',
    opVoice: '邵思萌',
    replyVoices: ['qwen-clone'],
    clickToRead: false,
    showFloatingPlayer: true,
    readingFocus: 'sentence',
    readingFocusStyle: 'soft-glow',
    wordHighlightStyle: 'edge-dissolve',
    wordHighlightColor: '#6f58bd',
    wordHighlightGlow: 48,
    wordHighlightSpeed: 1,
    orbEdge: 'right',
    orbY: 0.82,
    interactionVersion: 3
  });
})(globalThis);
