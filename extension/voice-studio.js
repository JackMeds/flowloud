/* global chrome, QwenReaderWav, QwenReaderRecording, QwenReaderVoiceNaming, QwenReaderAudioImport, QwenReaderTranscription, QwenReaderVoiceLibrary */
(function installVoiceStudio() {
  'use strict';

  const MIN_SECONDS = 5;
  const MAX_SECONDS = 15;
  const TARGET_RATE = 24000;
  const MAX_IMPORT_FILES = 20;
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  const recordingGate = QwenReaderRecording.createRecordingGate();
  const speechProvider = QwenReaderTranscription.createEdgeSpeechProvider();
  const element = (id) => document.getElementById(id);
  const state = {
    context: null,
    importContext: null,
    stream: null,
    source: null,
    processor: null,
    silence: null,
    chunks: [],
    startedAt: 0,
    timer: null,
    wav: null,
    recordSamples: null,
    recordSampleRate: 0,
    recordDuration: 0,
    recordTranscriptionStatus: '',
    recordTranscriptionController: null,
    recordRefTextRevision: 0,
    previewUrl: null,
    isRecording: false,
    voices: [],
    imports: [],
    importSequence: 0,
    importWorkerPromise: null,
    savingImports: false,
    renamingVoice: '',
    renamePending: false,
    renameError: '',
  };

  const recordButton = element('record-button');
  const recordLabel = element('record-label');
  const recordNote = element('record-note');
  const recordTranscription = element('record-transcription');
  const duration = element('duration');
  const preview = element('preview');
  const saveButton = element('save-button');
  const nameInput = element('voice-name');
  const recordRefText = element('record-ref-text');
  const status = element('status');
  const voiceList = element('voice-list');
  const backendVoiceList = element('backend-voice-list');
  const emptyState = element('empty-state');
  const backendEmpty = element('backend-empty');
  const localCount = element('local-count');
  const fileInput = element('audio-files');
  const dropZone = element('audio-dropzone');
  const importList = element('import-batch-list');
  const importEmpty = element('import-empty');
  const batchCount = element('batch-count');
  const saveAllButton = element('save-all-button');
  const clearImportsButton = element('clear-imports');

  function setStatus(message, kind) {
    status.textContent = message;
    status.className = 'status' + (kind ? ' is-' + kind : '');
    status.title = message;
  }

  function formatDuration(seconds) {
    const rounded = Math.max(0, Math.floor(Number(seconds) || 0));
    return String(Math.floor(rounded / 60)).padStart(2, '0') + ':' + String(rounded % 60).padStart(2, '0');
  }

  function formatSeconds(seconds) {
    const value = Number(seconds) || 0;
    return value > 0 ? value.toFixed(value >= 10 ? 0 : 1) + ' 秒' : '';
  }

  function formatFileSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB';
    return (value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
  }

  function friendlyAudioError(error) {
    const code = error && error.code;
    if (code === 'voice_too_short') return '没有找到至少 5 秒的清晰人声';
    if (code === 'audio_decode_failed') return '浏览器无法解码这个音频格式';
    if (code === 'invalid_audio') return '音频文件无效';
    if (code === 'audio_too_large') return '单个音频不能超过 100 MB';
    if (code === 'speech_recognition_unsupported') return '当前 Edge 环境不支持自动识别，可手动填写台词';
    if (code === 'not-allowed' || code === 'service-not-allowed') return '网页语音识别被浏览器策略阻止，可手动填写台词';
    if (code === 'network') return '台词识别网络暂时不可用，可稍后重试或手动填写';
    return error && error.message ? error.message : '处理失败';
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function message(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response || response.ok === false) {
          const detail = response && response.error;
          const error = new Error(detail && detail.message || '本地服务没有返回有效结果');
          error.code = detail && detail.code;
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }

  function setMode(mode) {
    const recordMode = mode !== 'import';
    element('record-pane').hidden = !recordMode;
    element('import-pane').hidden = recordMode;
    element('record-tab').classList.toggle('is-active', recordMode);
    element('import-tab').classList.toggle('is-active', !recordMode);
    element('record-tab').setAttribute('aria-selected', String(recordMode));
    element('import-tab').setAttribute('aria-selected', String(!recordMode));
    element('record-tab').tabIndex = recordMode ? 0 : -1;
    element('import-tab').tabIndex = recordMode ? -1 : 0;
  }

  function updateDuration() {
    const seconds = (Date.now() - state.startedAt) / 1000;
    duration.textContent = formatDuration(seconds);
    if (seconds < MIN_SECONDS) {
      recordNote.textContent = '至少还需 ' + Math.ceil(MIN_SECONDS - seconds) + ' 秒';
    } else {
      recordNote.textContent = '时长已足够，可以结束录音';
    }
    if (seconds >= MAX_SECONDS) void stopRecording();
  }

  function joinChunks(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
      samples.set(chunk, offset);
      offset += chunk.length;
    });
    return samples;
  }

  function stopTracks() {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    [state.source, state.processor, state.silence].forEach((node) => {
      try { if (node) node.disconnect(); } catch (_) { /* already disconnected */ }
    });
    state.stream = null;
    state.source = null;
    state.processor = null;
    state.silence = null;
  }

  function resetRecorderUi() {
    recordButton.classList.remove('is-recording');
    recordButton.setAttribute('aria-pressed', 'false');
    recordButton.disabled = false;
    recordLabel.textContent = '开始录音';
    state.isRecording = false;
  }

  function abortRecordTranscription() {
    if (state.recordTranscriptionController) state.recordTranscriptionController.abort();
    state.recordTranscriptionController = null;
  }

  function clearRecordedPreview() {
    abortRecordTranscription();
    state.wav = null;
    state.recordSamples = null;
    state.chunks = [];
    state.recordSampleRate = 0;
    state.recordDuration = 0;
    state.recordTranscriptionStatus = '';
    state.recordRefTextRevision = 0;
    saveButton.disabled = true;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    preview.pause();
    preview.removeAttribute('src');
    preview.hidden = true;
    recordRefText.value = '';
    recordTranscription.className = 'transcription-note';
    recordTranscription.textContent = '尚未录制。';
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('此浏览器不支持麦克风录音。', 'error');
      return;
    }
    const token = recordingGate.begin();
    if (token == null) return;
    clearRecordedPreview();
    recordButton.disabled = true;
    recordNote.textContent = '正在请求麦克风权限…';
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!recordingGate.activate(token)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      state.context = state.context || new AudioContext();
      if (state.context.state === 'suspended') await state.context.resume();
      state.stream = stream;
      state.chunks = [];
      state.source = state.context.createMediaStreamSource(stream);
      state.processor = state.context.createScriptProcessor(4096, 1, 1);
      state.silence = state.context.createGain();
      state.silence.gain.value = 0;
      state.processor.onaudioprocess = (event) => {
        state.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      state.source.connect(state.processor);
      state.processor.connect(state.silence);
      state.silence.connect(state.context.destination);
      state.startedAt = Date.now();
      state.timer = window.setInterval(updateDuration, 100);
      state.isRecording = true;
      recordButton.classList.add('is-recording');
      recordButton.disabled = false;
      recordButton.setAttribute('aria-pressed', 'true');
      recordLabel.textContent = '结束录音';
      recordNote.textContent = '至少录制 5 秒';
      duration.textContent = '00:00';
      setStatus('正在录音；15 秒后会自动停止。');
    } catch (error) {
      if (stream && state.stream !== stream) stream.getTracks().forEach((track) => track.stop());
      if (recordingGate.isRecording()) {
        recordingGate.stop();
        stopTracks();
      } else {
        recordingGate.fail(token);
      }
      resetRecorderUi();
      setStatus('无法使用麦克风：' + error.message, 'error');
    }
  }

  async function transcribeRecording(samples, sampleRate, durationSeconds) {
    abortRecordTranscription();
    const controller = new AbortController();
    const refTextRevision = state.recordRefTextRevision;
    state.recordTranscriptionController = controller;
    state.recordTranscriptionStatus = 'processing';
    recordTranscription.className = 'transcription-note is-working';
    recordTranscription.textContent = '正在识别参考台词；识别结果可以手动修改。';
    try {
      const result = await QwenReaderTranscription.transcribeWithRetry(speechProvider, {
        samples,
        sampleRate,
        durationSeconds,
        lang: 'zh-CN',
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const recognizedText = String(result && result.text || '').trim();
      if (state.recordRefTextRevision === refTextRevision) recordRefText.value = recognizedText;
      state.recordTranscriptionStatus = recognizedText ? 'success' : 'empty';
      recordTranscription.className = 'transcription-note';
      recordTranscription.textContent = state.recordRefTextRevision !== refTextRevision
        ? '识别已完成；已保留你手动填写的台词。'
        : recordRefText.value
          ? '台词已自动识别，请核对后保存。'
        : '没有识别到台词，可以手动填写或留空。';
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      state.recordTranscriptionStatus = 'failed';
      recordTranscription.className = 'transcription-note is-error';
      recordTranscription.textContent = friendlyAudioError(error);
    } finally {
      if (state.recordTranscriptionController === controller) {
        state.recordTranscriptionController = null;
      }
    }
  }

  async function stopRecording() {
    if (!recordingGate.isRecording() || !state.isRecording) return;
    recordingGate.stop();
    window.clearInterval(state.timer);
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const samples = joinChunks(state.chunks);
    const sampleRate = state.context.sampleRate;
    stopTracks();
    resetRecorderUi();
    duration.textContent = formatDuration(elapsed);
    try {
      if (elapsed < MIN_SECONDS || samples.length === 0) {
        const tooShort = new Error('voice_too_short');
        tooShort.code = 'voice_too_short';
        throw tooShort;
      }
      const segment = QwenReaderAudioImport.selectReferenceSegment(samples, sampleRate);
      state.wav = QwenReaderWav.encodeMono16(segment.samples, sampleRate, TARGET_RATE);
      state.recordSamples = segment.samples;
      state.recordSampleRate = sampleRate;
      state.recordDuration = segment.durationSeconds;
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = URL.createObjectURL(new Blob([state.wav], { type: 'audio/wav' }));
      preview.src = state.previewUrl;
      preview.hidden = false;
      saveButton.disabled = !nameInput.value.trim();
      recordNote.textContent = '已提取 ' + formatSeconds(segment.durationSeconds) + ' 的稳定人声';
      setStatus('录音已就绪，可核对名称和台词后保存。', 'success');
      void transcribeRecording(segment.samples, sampleRate, segment.durationSeconds);
    } catch (error) {
      state.wav = null;
      saveButton.disabled = true;
      recordNote.textContent = friendlyAudioError(error);
      setStatus('录音不可用：' + friendlyAudioError(error) + '。', 'error');
    }
  }

  async function saveRecordedVoice() {
    const name = QwenReaderVoiceNaming.sanitizeName(nameInput.value);
    if (!nameInput.value.trim()) {
      setStatus('请先输入音色名称。', 'error');
      nameInput.focus();
      return;
    }
    if (!state.wav) {
      setStatus('请先完成一段至少 5 秒的录音。', 'error');
      return;
    }
    if (state.voices.some((voice) => voice.name === name) && !window.confirm('“' + name + '”已存在。确定覆盖这个音色吗？')) return;
    saveButton.disabled = true;
    setStatus('正在保存“' + name + '”…');
    try {
      const profile = QwenReaderVoiceLibrary.createImportedProfile({
        name,
        wavB64: toBase64(state.wav),
        refText: recordRefText.value.trim(),
        sourceFileName: '',
        durationSeconds: state.recordDuration,
        transcriptionStatus: state.recordTranscriptionStatus || 'manual',
        attempts: state.recordTranscriptionStatus ? 1 : 0,
      });
      await message({ type: 'voice:save', profile });
      nameInput.value = '';
      clearRecordedPreview();
      duration.textContent = '00:00';
      recordNote.textContent = '建议在安静环境朗读 5–15 秒，语速自然，不要带背景音乐。';
      setStatus('“' + name + '”已保存到浏览器音色库。', 'success');
      await loadVoices();
    } catch (error) {
      setStatus('保存失败：' + error.message, 'error');
    } finally {
      saveButton.disabled = !state.wav || !nameInput.value.trim();
    }
  }

  function getImportContext() {
    if (!state.importContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('当前浏览器不支持音频解码。');
      state.importContext = new AudioContext();
    }
    return state.importContext;
  }

  function revokeImportPreview(item) {
    if (item && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (item) item.previewUrl = '';
  }

  function releaseImportPayload(item) {
    if (!item) return;
    if (item.transcriptionController) item.transcriptionController.abort();
    item.transcriptionController = null;
    revokeImportPreview(item);
    item.file = null;
    item.wav = null;
    item.wavB64 = '';
    item.samples = null;
  }

  function importsAreProcessing() {
    return Boolean(state.importWorkerPromise) || state.imports.some((item) => (
      item.status === 'queued' || item.status === 'processing' || item.status === 'transcribing'
    ));
  }

  function importStatusText(item) {
    if (item.status === 'queued') return '等待处理';
    if (item.status === 'processing') return '正在解码并选择人声';
    if (item.status === 'transcribing') return '音频已就绪，正在识别台词';
    if (item.status === 'saving') return '正在保存';
    if (item.status === 'saved') return '已保存到音色库';
    if (item.status === 'error') return item.error || '处理失败';
    if (item.saveError) return '上次保存失败：' + item.saveError;
    if (item.transcriptionStatus === 'failed') return '音频已就绪；台词可手动填写';
    return '待确认';
  }

  function updateImportActions() {
    const processing = importsAreProcessing();
    const ready = state.imports.some((item) => item.status === 'ready' && item.wavB64);
    batchCount.textContent = String(state.imports.length);
    importEmpty.hidden = state.imports.length > 0;
    clearImportsButton.disabled = state.imports.length === 0 || state.savingImports;
    saveAllButton.disabled = !ready || state.savingImports || processing;
  }

  function renderImports() {
    importList.textContent = '';
    for (const item of state.imports) {
      const row = document.createElement('li');
      row.className = 'import-item';
      row.dataset.importId = item.id;

      const fileInfo = document.createElement('div');
      fileInfo.className = 'import-file';
      const fileName = document.createElement('strong');
      fileName.textContent = item.sourceFileName;
      fileName.title = item.sourceFileName;
      const fileMeta = document.createElement('span');
      fileMeta.textContent = [formatFileSize(item.file && item.file.size), formatSeconds(item.durationSeconds)]
        .filter(Boolean).join(' · ');
      fileInfo.append(fileName, fileMeta);
      if (item.previewUrl) {
        const audio = document.createElement('audio');
        audio.className = 'import-audio';
        audio.controls = true;
        audio.src = item.previewUrl;
        fileInfo.append(audio);
      }

      const nameField = document.createElement('label');
      nameField.className = 'compact-field';
      nameField.textContent = '音色名称';
      const itemName = document.createElement('input');
      itemName.value = item.name;
      itemName.maxLength = 40;
      itemName.dataset.action = 'import-name';
      itemName.dataset.importId = item.id;
      itemName.disabled = ['saving', 'saved'].includes(item.status);
      nameField.append(itemName);

      const textField = document.createElement('label');
      textField.className = 'compact-field';
      textField.textContent = '参考台词（可修改）';
      const itemText = document.createElement('textarea');
      itemText.rows = 2;
      itemText.value = item.refText || '';
      itemText.placeholder = item.status === 'transcribing' ? '自动识别中…' : '可手动填写或留空';
      itemText.dataset.action = 'import-ref-text';
      itemText.dataset.importId = item.id;
      itemText.disabled = ['saving', 'saved'].includes(item.status);
      textField.append(itemText);

      const actions = document.createElement('div');
      actions.className = 'import-actions';
      const itemStatus = document.createElement('span');
      itemStatus.className = 'import-status';
      if (item.status === 'error' || item.saveError) itemStatus.classList.add('is-error');
      if (item.status === 'saved') itemStatus.classList.add('is-success');
      itemStatus.textContent = importStatusText(item);
      actions.append(itemStatus);
      if (item.status === 'ready' && item.transcriptionStatus === 'failed') {
        const retry = document.createElement('button');
        retry.className = 'text-button';
        retry.type = 'button';
        retry.dataset.action = 'retry-transcription';
        retry.dataset.importId = item.id;
        retry.textContent = '重试识别';
        actions.append(retry);
      }
      if (!['saving', 'saved'].includes(item.status)) {
        const remove = document.createElement('button');
        remove.className = 'text-button danger-button';
        remove.type = 'button';
        remove.dataset.action = 'remove-import';
        remove.dataset.importId = item.id;
        remove.textContent = '移除';
        actions.append(remove);
      }

      row.append(fileInfo, nameField, textField, actions);
      importList.append(row);
    }
    updateImportActions();
  }

  async function transcribeImportItem(item) {
    if (!item || item.cancelled || !item.samples || !item.sampleRate) return;
    if (item.transcriptionController) item.transcriptionController.abort();
    const controller = new AbortController();
    const refTextRevision = item.refTextRevision || 0;
    item.transcriptionController = controller;
    item.status = 'transcribing';
    item.transcriptionStatus = 'processing';
    renderImports();
    try {
      const result = await QwenReaderTranscription.transcribeWithRetry(speechProvider, {
        samples: item.samples,
        sampleRate: item.sampleRate,
        durationSeconds: item.durationSeconds,
        lang: 'zh-CN',
        signal: controller.signal,
      });
      if (controller.signal.aborted || item.cancelled) return;
      const recognizedText = String(result && result.text || '').trim();
      if (item.refTextRevision === refTextRevision) item.refText = recognizedText;
      item.transcriptionStatus = recognizedText ? 'success' : 'empty';
      item.status = 'ready';
      item.error = '';
    } catch (error) {
      if ((error && error.name === 'AbortError') || item.cancelled) return;
      item.transcriptionStatus = 'failed';
      item.status = 'ready';
      item.error = friendlyAudioError(error);
    } finally {
      if (item.transcriptionController === controller) item.transcriptionController = null;
      if (!item.cancelled) renderImports();
    }
  }

  async function processImportItem(item) {
    const file = item.file;
    item.status = 'processing';
    item.error = '';
    item.saveError = '';
    renderImports();
    try {
      if (!file || typeof file.arrayBuffer !== 'function') {
        const error = new Error('文件无效');
        error.code = 'invalid_audio';
        throw error;
      }
      if (file.size > MAX_FILE_BYTES) {
        const error = new Error('单个音频不能超过 100 MB');
        error.code = 'audio_too_large';
        throw error;
      }
      const audioContext = getImportContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      const audioBuffer = await QwenReaderAudioImport.decodeFile(file, audioContext);
      if (item.cancelled) return;
      const processed = QwenReaderAudioImport.processAudioBuffer(audioBuffer);
      if (item.cancelled) return;
      item.wav = processed.wav;
      item.wavB64 = toBase64(processed.wav);
      item.samples = processed.segment.samples;
      item.sampleRate = audioBuffer.sampleRate;
      item.durationSeconds = processed.segment.durationSeconds;
      revokeImportPreview(item);
      item.previewUrl = URL.createObjectURL(new Blob([processed.wav], { type: 'audio/wav' }));
      item.status = 'ready';
      renderImports();
      await transcribeImportItem(item);
    } catch (error) {
      if (item.cancelled) return;
      item.status = 'error';
      item.error = friendlyAudioError(error);
      item.transcriptionStatus = 'failed';
      renderImports();
    } finally {
      if (item.cancelled) releaseImportPayload(item);
    }
  }

  function ensureImportWorker() {
    if (state.importWorkerPromise) return state.importWorkerPromise;
    state.importWorkerPromise = (async () => {
      while (true) {
        const item = state.imports.find((candidate) => candidate.status === 'queued' && !candidate.cancelled);
        if (!item) break;
        await processImportItem(item);
      }
    })().finally(() => {
      state.importWorkerPromise = null;
      renderImports();
    });
    return state.importWorkerPromise;
  }

  async function queueFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setMode('import');
    const room = Math.max(0, MAX_IMPORT_FILES - state.imports.length);
    if (!room) {
      setStatus('一次最多处理 20 个文件，请先清空或保存当前批次。', 'error');
      return;
    }
    const selected = files.slice(0, room);
    const occupiedNames = new Set([
      ...state.voices.map((voice) => voice.name),
      ...state.imports.map((item) => item.name),
    ]);
    const added = [];
    for (const file of selected) {
      const batch = QwenReaderVoiceLibrary.createBatchItem(file, occupiedNames);
      occupiedNames.add(batch.name);
      const item = Object.assign(batch, {
        id: 'import-' + (++state.importSequence),
        status: 'queued',
        error: '',
        refText: '',
        wav: null,
        wavB64: '',
        previewUrl: '',
        samples: null,
        sampleRate: 0,
        durationSeconds: 0,
        transcriptionController: null,
        refTextRevision: 0,
        cancelled: false,
        saveError: '',
      });
      state.imports.push(item);
      added.push(item);
    }
    renderImports();
    if (files.length > selected.length) {
      setStatus('已加入前 ' + selected.length + ' 个文件；单批最多 20 个。');
    } else {
      setStatus('已加入 ' + selected.length + ' 个文件，开始逐个处理。');
    }
    await ensureImportWorker();
    const completed = added.filter((item) => state.imports.includes(item) && !item.cancelled);
    if (!completed.length) return;
    const readyCount = completed.filter((item) => item.status === 'ready').length;
    const failedCount = completed.filter((item) => item.status === 'error').length;
    setStatus(
      '批量处理完成：' + readyCount + ' 个待保存' + (failedCount ? '，' + failedCount + ' 个失败' : '') + '。',
      failedCount ? 'error' : 'success',
    );
  }

  function findImportItem(id) {
    return state.imports.find((item) => item.id === id);
  }

  function removeImport(id) {
    const item = findImportItem(id);
    if (!item) return;
    item.cancelled = true;
    releaseImportPayload(item);
    state.imports = state.imports.filter((candidate) => candidate !== item);
    renderImports();
  }

  function clearImports() {
    for (const item of state.imports) {
      item.cancelled = true;
      releaseImportPayload(item);
    }
    state.imports = [];
    fileInput.value = '';
    renderImports();
    setStatus('已清空导入队列。');
  }

  function validateBatchNames(items) {
    const existing = new Set(state.voices.map((voice) => QwenReaderVoiceNaming.sanitizeName(voice.name)));
    const batch = new Set();
    for (const item of items) {
      const name = QwenReaderVoiceNaming.sanitizeName(item.name);
      item.name = name;
      if (existing.has(name)) throw new Error('音色“' + name + '”已经存在，请先修改名称。');
      if (batch.has(name)) throw new Error('当前批次中有重复名称“' + name + '”。');
      batch.add(name);
    }
  }

  async function saveAllImports() {
    if (state.savingImports) return;
    if (importsAreProcessing()) {
      setStatus('请等待当前批次全部处理完成后再保存。', 'error');
      return;
    }
    const readyItems = state.imports.filter((item) => item.status === 'ready' && item.wavB64);
    if (!readyItems.length) {
      setStatus('没有可保存的音频。', 'error');
      return;
    }
    try {
      validateBatchNames(readyItems);
    } catch (error) {
      setStatus(error.message, 'error');
      renderImports();
      return;
    }
    state.savingImports = true;
    renderImports();
    let saved = 0;
    let failed = 0;
    for (const item of readyItems) {
      item.status = 'saving';
      item.saveError = '';
      renderImports();
      try {
        const profile = QwenReaderVoiceLibrary.createImportedProfile({
          name: item.name,
          wavB64: item.wavB64,
          refText: item.refText,
          sourceFileName: item.sourceFileName,
          durationSeconds: item.durationSeconds,
          transcriptionStatus: item.transcriptionStatus || 'manual',
          attempts: item.transcriptionStatus ? 1 : 0,
        });
        await message({ type: 'voice:save', profile });
        item.status = 'saved';
        releaseImportPayload(item);
        saved += 1;
      } catch (error) {
        item.status = 'ready';
        item.saveError = error.message;
        failed += 1;
      }
      renderImports();
    }
    state.savingImports = false;
    renderImports();
    await loadVoices();
    setStatus(
      '批量保存完成：成功 ' + saved + ' 个' + (failed ? '，失败 ' + failed + ' 个' : '') + '。',
      failed ? 'error' : 'success',
    );
  }

  function voiceMeta(voice) {
    const details = [];
    if (voice.sourceFileName) details.push(voice.sourceFileName);
    if (voice.durationSeconds) details.push(formatSeconds(voice.durationSeconds));
    if (!details.length) details.push(voice.local ? '浏览器保存 · 可编辑' : '由本地 Qwen 服务提供');
    return details.join(' · ');
  }

  function makeTextButton(label, action, voiceName, extraClass) {
    const button = document.createElement('button');
    button.className = 'text-button' + (extraClass ? ' ' + extraClass : '');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.voiceName = voiceName;
    button.textContent = label;
    return button;
  }

  function renderVoiceRow(voice, readOnly) {
    const row = document.createElement('li');
    row.className = 'voice-row';
    row.dataset.voiceName = voice.name;

    if (!readOnly && state.renamingVoice === voice.name) {
      const editor = document.createElement('div');
      editor.className = 'rename-editor';
      const input = document.createElement('input');
      input.value = voice.name;
      input.maxLength = 40;
      input.dataset.role = 'rename-input';
      input.dataset.voiceName = voice.name;
      input.setAttribute('aria-label', '新的音色名称');
      if (state.renameError) input.setAttribute('aria-describedby', 'rename-error');
      const actions = document.createElement('div');
      actions.className = 'rename-actions';
      actions.append(
        makeTextButton('保存', 'rename-confirm', voice.name),
        makeTextButton('取消', 'rename-cancel', voice.name),
      );
      editor.append(input, actions);
      if (state.renameError) {
        const error = document.createElement('p');
        error.id = 'rename-error';
        error.className = 'rename-error';
        error.textContent = state.renameError;
        editor.append(error);
      }
      row.append(editor);
      window.requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return row;
    }

    const info = document.createElement('div');
    info.className = 'voice-info';
    const title = document.createElement('span');
    title.className = 'voice-name';
    title.textContent = voice.name;
    title.title = voice.name;
    const meta = document.createElement('span');
    meta.className = 'voice-meta';
    meta.textContent = voiceMeta(voice);
    info.append(title, meta);
    row.append(info);

    if (!readOnly && voice.local) {
      const actions = document.createElement('div');
      actions.className = 'voice-row-actions';
      const canRename = voice.editable !== false;
      if (canRename) {
        const renameButton = makeTextButton('重命名', 'rename-start', voice.name);
        renameButton.setAttribute('aria-label', '重命名音色“' + voice.name + '”');
        actions.append(renameButton);
      }
      const deleteButton = makeTextButton('删除', 'voice-delete', voice.name, 'danger-button');
      deleteButton.setAttribute('aria-label', '删除音色“' + voice.name + '”');
      actions.append(deleteButton);
      row.append(actions);
    } else {
      const readonly = document.createElement('span');
      readonly.className = 'readonly-label';
      readonly.textContent = '只读';
      row.append(readonly);
    }
    return row;
  }

  function renderVoices() {
    voiceList.textContent = '';
    backendVoiceList.textContent = '';
    const seen = new Set();
    const voices = state.voices.filter((voice) => {
      const name = String(voice && voice.name || '').trim();
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    const localVoices = voices.filter((voice) => voice.local && voice.editable !== false);
    const backendVoices = voices.filter((voice) => !localVoices.includes(voice));
    for (const voice of localVoices) voiceList.append(renderVoiceRow(voice, false));
    for (const voice of backendVoices) backendVoiceList.append(renderVoiceRow(voice, true));
    localCount.textContent = String(localVoices.length);
    emptyState.hidden = localVoices.length > 0;
    backendEmpty.hidden = backendVoices.length > 0;
  }

  async function loadVoices() {
    try {
      const response = await message({ type: 'voice:list' });
      state.voices = response.voices || response.profiles || [];
      renderVoices();
      const localVoices = state.voices.filter((voice) => voice.local && voice.editable !== false);
      const backendVoices = state.voices.length - localVoices.length;
      setStatus('已读取 ' + localVoices.length + ' 个浏览器音色、' + backendVoices + ' 个本地服务音色。', 'success');
    } catch (error) {
      state.voices = [];
      renderVoices();
      setStatus('无法读取音色库：' + error.message + '。请确认本地 Qwen 服务已启动。', 'error');
    }
  }

  function beginRename(name) {
    state.renamingVoice = name;
    state.renameError = '';
    renderVoices();
  }

  function cancelRename() {
    state.renamingVoice = '';
    state.renameError = '';
    renderVoices();
  }

  async function confirmRename(oldName) {
    if (state.renamePending) return;
    const input = voiceList.querySelector('[data-role="rename-input"]');
    if (input && input.dataset.voiceName !== oldName) return;
    const rawName = input && input.value.trim();
    if (!rawName) {
      state.renameError = '名称不能为空。';
      renderVoices();
      return;
    }
    const newName = QwenReaderVoiceNaming.sanitizeName(rawName);
    if (newName === oldName) {
      cancelRename();
      return;
    }
    if (state.voices.some((voice) => voice.name === newName)) {
      state.renameError = '这个名称已经存在。';
      renderVoices();
      return;
    }
    setStatus('正在将“' + oldName + '”重命名为“' + newName + '”…');
    state.renamePending = true;
    try {
      const response = await message({
        type: 'voice:rename',
        oldName: oldName,
        newName: newName,
      });
      state.renamingVoice = '';
      state.renameError = '';
      await loadVoices();
      setStatus(
        response.warning && response.warning.message
          ? '“' + newName + '”已重命名；' + response.warning.message
          : '“' + oldName + '”已重命名为“' + newName + '”。',
        'success',
      );
    } catch (error) {
      state.renameError = error.message;
      renderVoices();
      setStatus('重命名失败：' + error.message, 'error');
    } finally {
      state.renamePending = false;
    }
  }

  async function deleteVoice(name) {
    if (!window.confirm('删除浏览器音色“' + name + '”？此操作也会取消服务端注册。')) return;
    try {
      await message({ type: 'voice:delete', name });
      setStatus('已删除“' + name + '”。', 'success');
      await loadVoices();
    } catch (error) {
      setStatus('删除失败：' + error.message, 'error');
    }
  }

  function handleStudioAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'show-record') setMode('record');
    if (action === 'show-import') setMode('import');
    if (action === 'clear-imports') clearImports();
    if (action === 'save-all') void saveAllImports();
    if (action === 'remove-import') removeImport(button.dataset.importId);
    if (action === 'retry-transcription') {
      const item = findImportItem(button.dataset.importId);
      if (item) void transcribeImportItem(item);
    }
    if (action === 'refresh-voices') void loadVoices();
    if (action === 'rename-start') beginRename(button.dataset.voiceName);
    if (action === 'rename-cancel') cancelRename();
    if (action === 'rename-confirm') void confirmRename(button.dataset.voiceName);
    if (action === 'voice-delete') void deleteVoice(button.dataset.voiceName);
  }

  document.addEventListener('click', handleStudioAction);
  document.querySelector('.source-tabs').addEventListener('keydown', (event) => {
    const tabs = [element('record-tab'), element('import-tab')];
    const currentIndex = tabs.indexOf(event.target);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    setMode(nextIndex === 0 ? 'record' : 'import');
    tabs[nextIndex].focus();
  });
  recordButton.addEventListener('click', () => {
    if (recordingGate.isRecording()) void stopRecording();
    else void startRecording();
  });
  saveButton.addEventListener('click', saveRecordedVoice);
  nameInput.addEventListener('input', () => {
    saveButton.disabled = !state.wav || !nameInput.value.trim();
  });
  recordRefText.addEventListener('input', () => {
    state.recordRefTextRevision += 1;
  });
  fileInput.addEventListener('change', (event) => {
    void queueFiles(event.target.files);
    event.target.value = '';
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
    void queueFiles(event.dataTransfer.files);
  });
  dropZone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    fileInput.click();
  });
  importList.addEventListener('input', (event) => {
    const item = findImportItem(event.target.dataset.importId);
    if (!item) return;
    if (event.target.dataset.action === 'import-name') item.name = event.target.value;
    if (event.target.dataset.action === 'import-ref-text') {
      item.refText = event.target.value;
      item.refTextRevision = (item.refTextRevision || 0) + 1;
    }
  });
  voiceList.addEventListener('keydown', (event) => {
    const input = event.target.closest('[data-role="rename-input"]');
    if (!input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirmRename(input.dataset.voiceName);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  });
  window.addEventListener('beforeunload', () => {
    recordingGate.cancel();
    window.clearInterval(state.timer);
    abortRecordTranscription();
    stopTracks();
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    for (const item of state.imports) {
      if (item.transcriptionController) item.transcriptionController.abort();
      revokeImportPreview(item);
    }
    if (state.context && typeof state.context.close === 'function') void state.context.close();
    if (state.importContext && typeof state.importContext.close === 'function') void state.importContext.close();
  });

  renderImports();
  renderVoices();
  void loadVoices();
}());
