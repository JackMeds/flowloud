(function attachDefaults(global) {
  'use strict';

  global.QwenReaderDefaults = Object.freeze({
    apiBaseUrl: 'http://127.0.0.1:7811',
    model: 'qwen3-tts-1.7b-base',
    responseFormat: 'wav',
    providerId: 'browser-system',
    providerVersion: 3,
    activeProviderId: 'browser-system',
    playbackRate: 1,
    readingMode: 'content',
    providerOptions: Object.freeze({
      baseUrl: 'http://127.0.0.1:7811',
      model: 'qwen3-tts-1.7b-base',
      responseFormat: 'wav',
    }),
    maxChunkChars: 260,
    // The safest first-run experience is one explicitly selected voice for
    // every speaker. Multi-voice strategies remain opt-in.
    voiceMode: 'everyone-one',
    opVoice: '邵思萌',
    replyVoices: ['qwen-clone'],
    clickToRead: false,
    showFloatingPlayer: true,
    readingFocus: 'sentence',
    readingFocusStyle: 'paper-wash',
    wordHighlightStyle: 'edge-dissolve',
    wordHighlightColor: '#2563eb',
    wordHighlightGlow: 48,
    wordHighlightSpeed: 1,
    orbEdge: 'right',
    orbY: 0.82,
    interactionVersion: 3
  });
})(globalThis);
