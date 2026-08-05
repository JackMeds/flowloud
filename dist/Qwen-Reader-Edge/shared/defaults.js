(function attachDefaults(global) {
  'use strict';

  global.QwenReaderDefaults = Object.freeze({
    apiBaseUrl: 'http://127.0.0.1:7811',
    model: 'qwen3-tts-1.7b-base',
    responseFormat: 'wav',
    maxChunkChars: 260,
    voiceMode: 'op-exclusive',
    opVoice: '邵思萌',
    replyVoices: ['qwen-clone']
  });
})(globalThis);
