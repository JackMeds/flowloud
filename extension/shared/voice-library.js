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
  const NON_LOCAL_KINDS = new Set(['builtin', 'alias', 'remote']);

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
      spkB64: text(input.spkB64 || input.spk_b64),
      rvqB64: text(input.rvqB64 || input.rvq_b64),
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

  function isCompleteLocalProfile(profile) {
    if (!profile || typeof profile !== 'object') return false;
    const kind = text(profile.kind).trim().toLowerCase();
    if (
      profile.local === false || profile.remote === true || profile.builtIn || profile.builtin ||
      NON_LOCAL_KINDS.has(kind) || BUILTIN_VOICES.has(profile.name)
    ) {
      return false;
    }
    const hasWav = Boolean(text(profile.wavB64 || profile.wav_b64));
    const hasExtractedVoice = Boolean(
      text(profile.spkB64 || profile.spk_b64) && text(profile.rvqB64 || profile.rvq_b64)
    );
    return hasWav || hasExtractedVoice;
  }

  function planRename(profiles, settings, oldName, newName) {
    const oldValue = text(oldName);
    const newValue = naming.sanitizeName(newName);
    const inputProfiles = Array.isArray(profiles) ? profiles : [];
    const matches = inputProfiles.filter((profile) => profile && profile.name === oldValue);
    if (matches.length !== 1) throw new Error('找不到唯一的待重命名音色。');

    const oldProfile = matches[0];
    if (!isCompleteLocalProfile(oldProfile)) {
      throw new Error('只能重命名资料完整的本地音色。');
    }
    if (inputProfiles.some((profile) => (
      profile && profile !== oldProfile && naming.sanitizeName(profile.name) === newValue
    ))) {
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
