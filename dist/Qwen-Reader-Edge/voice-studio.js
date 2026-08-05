(function () {
  'use strict';

  const MIN_SECONDS = 5;
  const MAX_SECONDS = 15;
  const TARGET_RATE = 24000;
  const state = { context: null, stream: null, source: null, processor: null, silence: null, chunks: [], startedAt: 0, timer: null, wav: null, previewUrl: null, isRecording: false, voices: [] };
  const recordingGate = QwenReaderRecording.createRecordingGate();
  const element = (id) => document.getElementById(id);
  const recordButton = element('record-button');
  const recordLabel = element('record-label');
  const recordNote = element('record-note');
  const duration = element('duration');
  const preview = element('preview');
  const saveButton = element('save-button');
  const nameInput = element('voice-name');
  const status = element('status');
  const voiceList = element('voice-list');
  const emptyState = element('empty-state');

  function setStatus(message, kind) {
    status.textContent = message;
    status.className = 'status' + (kind ? ' is-' + kind : '');
  }

  function formatDuration(seconds) {
    const rounded = Math.max(0, Math.floor(seconds));
    return String(Math.floor(rounded / 60)).padStart(2, '0') + ':' + String(rounded % 60).padStart(2, '0');
  }

  function updateDuration() {
    const seconds = (Date.now() - state.startedAt) / 1000;
    duration.textContent = formatDuration(seconds);
    recordNote.textContent = seconds < MIN_SECONDS ? '至少还需 ' + Math.ceil(MIN_SECONDS - seconds) + ' 秒' : '录制清晰自然的一句话即可';
    if (seconds >= MAX_SECONDS) stopRecording();
  }

  function joinChunks(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    chunks.forEach((chunk) => { samples.set(chunk, offset); offset += chunk.length; });
    return samples;
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
        const error = chrome.runtime.lastError;
        if (error) { reject(new Error(error.message)); return; }
        if (!response || response.ok === false) { reject(new Error(response && response.error && response.error.message || '本地服务没有返回有效结果')); return; }
        resolve(response);
      });
    });
  }

  function stopTracks() {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    [state.source, state.processor, state.silence].forEach((node) => { if (node) node.disconnect(); });
    state.stream = state.source = state.processor = state.silence = null;
  }

  function resetRecorderUi() {
    recordButton.classList.remove('is-recording');
    recordButton.setAttribute('aria-pressed', 'false');
    recordLabel.textContent = '开始录音';
    state.isRecording = false;
  }

  function clearRecordedPreview() {
    state.wav = null;
    saveButton.disabled = true;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    preview.pause();
    preview.removeAttribute('src');
    preview.hidden = true;
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
      state.processor.onaudioprocess = (event) => state.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
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
      recordButton.disabled = false;
      setStatus('无法使用麦克风：' + error.message, 'error');
    }
  }

  function stopRecording() {
    if (!recordingGate.isRecording() || !state.isRecording) return;
    recordingGate.stop();
    window.clearInterval(state.timer);
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const samples = joinChunks(state.chunks);
    const sampleRate = state.context.sampleRate;
    stopTracks();
    resetRecorderUi();
    duration.textContent = formatDuration(elapsed);
    if (elapsed < MIN_SECONDS || samples.length === 0) {
      state.wav = null;
      saveButton.disabled = true;
      recordNote.textContent = '录音少于 5 秒，未保存';
      setStatus('录音至少需要 5 秒，请重新录制。', 'error');
      return;
    }
    state.wav = QwenReaderWav.encodeMono16(samples, sampleRate, TARGET_RATE);
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(new Blob([state.wav], { type: 'audio/wav' }));
    preview.src = state.previewUrl;
    preview.hidden = false;
    saveButton.disabled = !nameInput.value.trim();
    recordNote.textContent = '已生成 24 kHz 单声道 WAV';
    setStatus('录音已就绪。填写名称后即可保存并注册。', 'success');
  }

  function renderVoices() {
    voiceList.textContent = '';
    emptyState.hidden = state.voices.length > 0;
    state.voices.forEach((voice) => {
      const row = document.createElement('li');
      row.className = 'voice-row';
      const info = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'voice-name';
      title.textContent = voice.name;
      const meta = document.createElement('span');
      meta.className = 'voice-meta';
      meta.textContent = voice.local
        ? '浏览器本地保存 · 已可用于朗读'
        : '后端内置或网关恢复音色';
      info.append(title, meta);
      row.append(info);
      if (voice.local) {
        const remove = document.createElement('button');
        remove.className = 'delete-button';
        remove.type = 'button';
        remove.textContent = '删除';
        remove.addEventListener('click', () => deleteVoice(voice.name));
        row.append(remove);
      }
      voiceList.append(row);
    });
  }

  async function loadVoices() {
    try {
      const response = await message({ type: 'voice:list' });
      state.voices = response.voices || response.profiles || [];
      renderVoices();
      setStatus(state.voices.length ? '已读取 ' + state.voices.length + ' 个本地音色。' : '还没有本地录制的音色。');
    } catch (error) {
      setStatus('无法读取音色库：' + error.message + '。请确认本地 Qwen 服务已启动。', 'error');
    }
  }

  async function saveVoice() {
    const name = nameInput.value.trim();
    if (!name) { setStatus('请先输入音色名称。', 'error'); return; }
    if (!state.wav) { setStatus('请先录制至少 5 秒的音频。', 'error'); return; }
    if (state.voices.some((voice) => voice.name === name) && !window.confirm('“' + name + '”已存在。确定覆盖原有音色吗？')) return;
    saveButton.disabled = true;
    setStatus('正在保存并注册到本地 Qwen 服务…');
    try {
      await message({ type: 'voice:save', profile: { name: name, wavB64: toBase64(state.wav), mimeType: 'audio/wav', sampleRate: TARGET_RATE } });
      nameInput.value = '';
      clearRecordedPreview();
      setStatus('“' + name + '”已保存并注册成功。', 'success');
      await loadVoices();
    } catch (error) {
      setStatus('保存失败：' + error.message + '。请确认 `127.0.0.1:7811` 可用。', 'error');
    } finally {
      saveButton.disabled = !state.wav || !nameInput.value.trim();
    }
  }

  async function deleteVoice(name) {
    if (!window.confirm('删除本地音色“' + name + '”？此操作会同时取消本地保存和服务端注册。')) return;
    try {
      await message({ type: 'voice:delete', name: name });
      setStatus('已删除“' + name + '”。', 'success');
      await loadVoices();
    } catch (error) {
      setStatus('删除失败：' + error.message, 'error');
    }
  }

  recordButton.addEventListener('click', () => recordingGate.isRecording() ? stopRecording() : startRecording());
  saveButton.addEventListener('click', saveVoice);
  nameInput.addEventListener('input', () => { saveButton.disabled = !state.wav || !nameInput.value.trim(); });
  element('refresh-button').addEventListener('click', loadVoices);
  window.addEventListener('beforeunload', () => { recordingGate.cancel(); if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); stopTracks(); });
  loadVoices();
}());
