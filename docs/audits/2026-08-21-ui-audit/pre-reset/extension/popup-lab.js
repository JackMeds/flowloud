(function popupLab() {
  'use strict';
  const base = {
    title: '如何让浏览器朗读真正融入阅读？',
    sourceLabel: 'V2EX · 当前主题',
    speed: '1.0',
    settings: { clickToRead: false, preset: 'op-exclusive' },
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
      current: { authorName: '远山', text: '复杂的作者配音不该挤在一个瞬时小窗里。' }
    }
  };
  const states = [
    ['播放中 · B 的主状态', { snapshot: Object.assign({}, base.snapshot, { status: 'playing' }) }],
    ['暂停后重开 · 持续状态', { snapshot: Object.assign({}, base.snapshot, { status: 'paused', index: 1 }) }],
    ['识别完成 · C 的入口', { snapshot: Object.assign({}, base.snapshot, { status: 'ready', index: 0 }) }]
  ];
  const root = document.getElementById('popup-lab-root');
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
    document.getElementById('page-voices-lab-root'),
    {
      title: base.title,
      authors: base.authors.map((author) => Object.assign({}, author, { effectiveVoice: author.voice })),
      voices: ['邵思萌', '清朗', '温和', '低沉旁白'],
      authorVoices: { op: '邵思萌', a2: '温和' },
      compact: true
    }
  );
})();
