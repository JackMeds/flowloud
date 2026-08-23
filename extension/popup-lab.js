(function popupLab() {
  'use strict';

  const labReadingText = '复杂的作者配音不该挤在一个瞬时小窗里。朗读时这段文字会跟随当前词高亮并自动移动。';
  let labCursor = 0;
  const labWords = ['复杂', '的作者', '配音', '不该挤在', '一个瞬时小窗里', '。', '朗读时', '这段文字', '会跟随', '当前词', '高亮', '并自动移动', '。'].map((text) => {
    const sourceStart = labReadingText.indexOf(text, labCursor);
    const sourceEnd = sourceStart + text.length;
    labCursor = sourceEnd;
    return { text, sourceStart, sourceEnd };
  });
  const base = {
    title: '如何让浏览器朗读真正融入阅读？',
    sourceLabel: 'V2EX · 当前主题',
    speed: '1.0',
    settings: { clickToRead: false, showFloatingPlayer: true, preset: 'op-exclusive', activeProviderId: 'browser-system', playbackRate: 1 },
    authors: [
      { id: 'op', name: '楼主', voice: '邵思萌', count: 8, isOp: true },
      { id: 'a1', name: 'Mina', voice: '清朗', count: 4 },
      { id: 'a2', name: '远山', voice: '温和', count: 2 },
      { id: 'a3', name: 'Terry', voice: '清朗', count: 1 }
    ],
    snapshot: {
      index: 2,
      segmentCount: 4,
      rate: '1.2',
      current: { authorName: '远山', text: labReadingText, speechText: labReadingText, words: labWords, wordIndex: 4, wordCount: labWords.length }
    }
  };
  const states = [
    ['播放中 · B 的主状态', { snapshot: Object.assign({}, base.snapshot, { status: 'playing' }) }],
    ['暂停后重开 · 持续状态', { snapshot: Object.assign({}, base.snapshot, { status: 'paused', index: 1 }) }],
    ['识别完成 · C 的入口', { snapshot: Object.assign({}, base.snapshot, { status: 'ready', index: 0 }) }]
  ];
  const root = document.getElementById('popup-lab-root');
  const shell = document.querySelector('.qr-lab-shell');
  const editorRoot = document.getElementById('page-voices-lab-root');
  const editorCard = editorRoot && editorRoot.closest('.qr-lab-editor-card');
  const editorStatus = document.getElementById('page-voices-lab-status');
  const savedVoices = { op: '邵思萌', a1: '', a2: '温和', a3: '' };
  let activeSourceCard = null;

  function sourceLabel(card) {
    return card && card.querySelector('h2') && card.querySelector('h2').textContent || 'Popup';
  }

  function setEditorStatus(message, state) {
    if (!editorStatus) return;
    editorStatus.textContent = message;
    editorStatus.dataset.state = state || 'idle';
  }

  function readSelections() {
    const selections = {};
    if (!editorRoot) return selections;
    editorRoot.querySelectorAll('select[data-author-id]').forEach((select) => {
      selections[select.dataset.authorId] = select.value;
    });
    return selections;
  }

  function restoreSelections(selections) {
    if (!editorRoot) return;
    editorRoot.querySelectorAll('select[data-author-id]').forEach((select) => {
      select.value = selections[select.dataset.authorId] || '';
    });
  }

  function updateSourceSummary(card, selections) {
    if (!card) return;
    const chips = Array.from(card.querySelectorAll('.qr-voice-summary .qr-voice-chip'));
    base.authors.slice(0, 3).forEach((author, index) => {
      if (!chips[index]) return;
      chips[index].textContent = `${author.name} · ${selections[author.id] || author.voice || '默认'}`;
    });
  }

  function openEditor(card) {
    activeSourceCard = card || null;
    if (editorCard) {
      editorCard.classList.add('is-open');
      editorCard.dataset.state = 'open';
      editorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setEditorStatus(`已由「${sourceLabel(activeSourceCard)}」中的“调整本页配音”打开。修改后可点击“应用到本页”或“取消”。`, 'open');
    const firstSelect = editorRoot && editorRoot.querySelector('select[data-author-id]');
    if (firstSelect) firstSelect.focus({ preventScroll: true });
  }

  function cancelEditor() {
    restoreSelections(savedVoices);
    if (editorCard) editorCard.dataset.state = 'cancelled';
    setEditorStatus('已取消修改，保留上次已应用的音色。', 'cancelled');
  }

  function saveEditor() {
    const selections = readSelections();
    Object.keys(savedVoices).forEach((authorId) => {
      savedVoices[authorId] = selections[authorId] || '';
    });
    updateSourceSummary(activeSourceCard, selections);
    if (editorCard) editorCard.dataset.state = 'saved';
    setEditorStatus(`已应用到本页预览（来源：${sourceLabel(activeSourceCard)}）。`, 'saved');
  }

  states.forEach(([label, changes]) => {
    const card = document.createElement('article');
    card.className = 'qr-lab-card';
    const heading = document.createElement('h2');
    heading.textContent = label;
    const mount = document.createElement('div');
    mount.className = 'qr-popup-root';
    card.append(heading, mount);
    root.append(card);
    globalThis.QwenPopupView.mountPopup(mount, Object.assign({}, base, changes));
  });

  globalThis.QwenPopupView.mountPageVoices(
    editorRoot,
    {
      title: base.title,
      authors: base.authors.map((author) => Object.assign({}, author, { effectiveVoice: author.voice })),
      voices: ['邵思萌', '清朗', '温和', '低沉旁白'],
      authorVoices: Object.assign({}, savedVoices),
      compact: true
    }
  );

  if (shell) {
    shell.addEventListener('qwen-popup-command', (event) => {
      const action = event.detail && event.detail.action;
      const target = event.target;
      const sourceCard = target && typeof target.closest === 'function' ? target.closest('.qr-lab-card') : null;
      const isEditorEvent = Boolean(editorCard && target && editorCard.contains(target));
      if (action === 'open-page-editor' && sourceCard) return openEditor(sourceCard);
      if (isEditorEvent && action === 'cancel-page-voices') return cancelEditor();
      if (isEditorEvent && action === 'save-page-voices') return saveEditor();
    });
  }
})();
