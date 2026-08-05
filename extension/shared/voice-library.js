(function voiceLibraryModule(root, factory) {
  const naming = root.QwenReaderVoiceNaming || (typeof require === 'function'
    ? require('./voice-naming.js') : null);
  const api = factory(naming);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QwenReaderVoiceLibrary = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeVoiceLibrary(naming) {
  'use strict';

  if (!naming) throw new Error('缺少音色命名模块。');

  const BUILTIN_VOICES = new Set(['邵思萌', 'qwen-clone']);

  function text(value) {
    return String(value || '');
  }

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeProfile(profile) {
    const input = profile && typeof profile === 'object' ? profile : {};
    const transcription = input.transcription && typeof input.transcription === 'object'
      ? input.transcription : {};
    return {
      name: naming.sanitizeName(input.name),
      wavB64: text(input.wavB64 || input.wav_b64),
      mimeType: text(input.mimeType) || 'audio/wav',
      sampleRate: number(input.sampleRate, 24000),
      refText: text(input.refText || input.ref_text),
      sourceFileName: text(input.sourceFileName),
      durationSeconds: number(input.durationSeconds, 0),
      createdAt: text(input.createdAt),
      updatedAt: text(input.updatedAt),
      transcription: {
        provider: text(transcription.provider) || 'edge-web-speech',
        status: text(transcription.status),
        attempts: number(transcription.attempts, 0),
      },
    };
  }

  function createImportedProfile(input) {
    const source = input && typeof input === 'object' ? input : {};
    const timestamp = text(source.createdAt || source.updatedAt) || new Date().toISOString();
    return normalizeProfile({
      name: source.name,
      wavB64: source.wavB64,
      mimeType: 'audio/wav',
      sampleRate: 24000,
      refText: source.refText,
      sourceFileName: source.sourceFileName,
      durationSeconds: source.durationSeconds,
      createdAt: source.createdAt || timestamp,
      updatedAt: source.updatedAt || timestamp,
      transcription: {
        provider: 'edge-web-speech',
        status: source.transcriptionStatus,
        attempts: source.attempts || 0,
      },
    });
  }

  function isBuiltIn(profile) {
    return Boolean(profile && (profile.builtIn || profile.builtin || BUILTIN_VOICES.has(profile.name)));
  }

  function planRename(profiles, settings, oldName, newName) {
    const oldValue = text(oldName);
    const newValue = naming.sanitizeName(newName);
    const inputProfiles = Array.isArray(profiles) ? profiles : [];
    const matches = inputProfiles.filter((profile) => profile && profile.name === oldValue);
    if (matches.length !== 1) throw new Error('找不到唯一的待重命名音色。');

    const oldProfile = matches[0];
    if (isBuiltIn(oldProfile)) throw new Error('内置音色不能重命名。');
    if (!text(oldProfile.wavB64 || oldProfile.wav_b64)) {
      throw new Error('音色资料不完整，缺少参考 WAV。');
    }
    if (inputProfiles.some((profile) => profile && profile.name === newValue && profile !== oldProfile)) {
      throw new Error('音色名称已存在。');
    }

    const normalizedOld = normalizeProfile(oldProfile);
    const newProfile = Object.assign({}, normalizedOld, {
      name: newValue,
      updatedAt: new Date().toISOString(),
    });
    const nextProfiles = inputProfiles.map((profile) => profile === oldProfile
      ? newProfile : Object.assign({}, profile));
    const inputSettings = settings && typeof settings === 'object' ? settings : {};
    const nextSettings = Object.assign({}, inputSettings, {
      opVoice: inputSettings.opVoice === oldValue ? newValue : inputSettings.opVoice,
      replyVoices: Array.isArray(inputSettings.replyVoices)
        ? inputSettings.replyVoices.map((voice) => voice === oldValue ? newValue : voice)
        : inputSettings.replyVoices,
    });

    return { oldProfile: normalizedOld, newProfile, profiles: nextProfiles, settings: nextSettings };
  }

  function createBatchItem(file, occupiedNames) {
    const source = file && typeof file === 'object' ? file : {};
    return {
      file,
      name: naming.allocateUniqueName(naming.fileStem(source.name), occupiedNames),
      sourceFileName: text(source.name),
      transcriptionStatus: 'pending',
      attempts: 0,
    };
  }

  return Object.freeze({ normalizeProfile, createImportedProfile, planRename, createBatchItem });
}));
