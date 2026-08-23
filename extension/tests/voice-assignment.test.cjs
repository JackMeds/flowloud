const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadVoiceAssignment() {
  delete globalThis.QwenReaderVoiceAssignment;
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'voice-assignment.js'),
    'utf8'
  );
  vm.runInThisContext(source, { filename: 'voice-assignment.js' });
  return globalThis.QwenReaderVoiceAssignment;
}

const thread = [
  { id: '1', floor: 1, authorId: 'op', authorName: '楼主', isOp: true, text: '开场。' },
  { id: '2', floor: 2, authorId: 'ming', authorName: '阿明', isOp: false, text: '第一条。' },
  { id: '3', floor: 3, authorId: 'yu', authorName: '小雨', isOp: false, text: '第二条。' },
  { id: '4', floor: 4, authorId: 'ming', authorName: '阿明', isOp: false, text: '第三条。' },
  { id: '5', floor: 5, authorId: 'op', authorName: '楼主', isOp: true, text: '总结。' }
];

test('everyone-one uses the explicitly selected narrator voice for every role by default', () => {
  const { assignVoices } = loadVoiceAssignment();
  const result = assignVoices(thread, {
    opVoice: '系统中文音色',
    replyVoices: ['不应自动使用的机械音'],
    mode: 'everyone-one',
    allowSingleVoice: true,
  });
  assert.deepEqual(result.map((segment) => segment.voice), [
    '系统中文音色', '系统中文音色', '系统中文音色', '系统中文音色', '系统中文音色',
  ]);
});

test('new multi-role strategies have explicit and stable semantics', () => {
  const { assignVoices } = loadVoiceAssignment();
  const options = { opVoice: 'A', replyVoices: ['B', 'C'], allowSingleVoice: true };
  assert.deepEqual(assignVoices(thread, { ...options, mode: 'op-plus-one' }).map((item) => item.voice), ['A', 'B', 'B', 'B', 'A']);
  assert.deepEqual(assignVoices(thread, { ...options, mode: 'op-stable-random' }).map((item) => item.voice), ['A', 'B', 'C', 'B', 'A']);
  assert.deepEqual(assignVoices(thread, { ...options, mode: 'op-round-robin' }).map((item) => item.voice), ['A', 'B', 'C', 'B', 'A']);
});

test('op-exclusive reserves voice A for the original poster at every floor', () => {
  const { assignVoices } = loadVoiceAssignment();
  const result = assignVoices(thread, {
    opVoice: 'A',
    replyVoices: ['B', 'C'],
    mode: 'op-exclusive'
  });

  assert.deepEqual(result.map((segment) => segment.voice), ['A', 'B', 'C', 'B', 'A']);
  assert.equal(result.filter((segment) => !segment.isOp).some((segment) => segment.voice === 'A'), false);
  assert.equal(thread.every((segment) => Object.hasOwn(segment, 'voice')), false);
});

test('stable-author gives the same reply author the same non-OP voice', () => {
  const { assignVoices } = loadVoiceAssignment();
  const result = assignVoices(thread, {
    opVoice: 'A',
    replyVoices: ['B', 'C'],
    mode: 'stable-author'
  });

  assert.deepEqual(result.map((segment) => segment.voice), ['A', 'B', 'C', 'B', 'A']);
});

test('round-robin alternates every non-OP floor regardless of author', () => {
  const { assignVoices } = loadVoiceAssignment();
  const result = assignVoices(thread, {
    opVoice: 'A',
    replyVoices: ['B', 'C'],
    mode: 'round-robin'
  });

  assert.deepEqual(result.map((segment) => segment.voice), ['A', 'B', 'C', 'B', 'A']);
});

test('chunked text from one forum post never changes voice mid-post', () => {
  const { assignVoices } = loadVoiceAssignment();
  const segments = [
    { id: 'p2:0', postId: 'p2', sourceKey: 'discourse:p2', authorId: 'u2', isOp: false, text: '第一句' },
    { id: 'p2:1', postId: 'p2', sourceKey: 'discourse:p2', authorId: 'u2', isOp: false, text: '第二句' },
    { id: 'p3:0', postId: 'p3', sourceKey: 'discourse:p3', authorId: 'u3', isOp: false, text: '第三句' }
  ];

  for (const mode of ['op-exclusive', 'round-robin']) {
    const assigned = assignVoices(segments, {
      mode,
      opVoice: 'A',
      replyVoices: ['B', 'C']
    });
    assert.deepEqual(assigned.map((item) => item.voice), ['B', 'B', 'C']);
  }
});

test('op-exclusive keeps a contiguous reply author while round-robin follows floors', () => {
  const { assignVoices } = loadVoiceAssignment();
  const segments = [
    { id: 'p2', postId: 'p2', authorId: 'u2', isOp: false, text: '一' },
    { id: 'p3', postId: 'p3', authorId: 'u2', isOp: false, text: '二' },
    { id: 'p4', postId: 'p4', authorId: 'u3', isOp: false, text: '三' }
  ];
  const options = { opVoice: 'A', replyVoices: ['B', 'C'] };

  assert.deepEqual(
    assignVoices(segments, { ...options, mode: 'op-exclusive' }).map((item) => item.voice),
    ['B', 'B', 'C']
  );
  assert.deepEqual(
    assignVoices(segments, { ...options, mode: 'round-robin' }).map((item) => item.voice),
    ['B', 'C', 'B']
  );
});

test('single-author article and selection blocks use the narrator voice instead of alternating replies', () => {
  const { assignVoices } = loadVoiceAssignment();
  const segments = [
    { id: 'article:1', type: 'article', text: '文章第一段' },
    { id: 'article:2', type: 'article', text: '文章第二段' },
    { id: 'selection:1', type: 'selection', text: '选中文字' }
  ];

  const assigned = assignVoices(segments, {
    mode: 'round-robin',
    opVoice: '旁白',
    replyVoices: ['B', 'C']
  });

  assert.deepEqual(assigned.map((item) => item.voice), ['旁白', '旁白', '旁白']);
});

test('author keys are stable across chunks and normalized page-context inputs', () => {
  const { authorKey, normalizeAuthorVoices } = loadVoiceAssignment();
  assert.equal(authorKey({ authorId: 'user-7', id: 'post-1:0' }), 'id:user-7');
  assert.equal(authorKey({ authorId: 'user-7', id: 'post-1:1' }), 'id:user-7');
  assert.equal(authorKey({ authorName: '  Alice   Smith ' }), 'name:alice smith');
  assert.equal(authorKey({ type: 'article' }), 'document:article');
  assert.deepEqual(normalizeAuthorVoices({
    'name:Alice   Smith': '角色音色',
    'user-7': '用户音色',
    '': '忽略'
  }), {
    'name:alice smith': '角色音色',
    'id:user-7': '用户音色'
  });
});

test('page author voice overrides take priority over OP and reply assignment rules', () => {
  const { assignVoices } = loadVoiceAssignment();
  const assigned = assignVoices(thread, {
    mode: 'round-robin',
    opVoice: 'A',
    replyVoices: ['B', 'C'],
    authorVoices: {
      'id:op': '旁白',
      'id:yu': '角色小雨'
    }
  });

  assert.deepEqual(assigned.map((segment) => segment.voice), [
    '旁白', 'B', '角色小雨', 'B', '旁白'
  ]);
  assert.equal(thread.some((segment) => Object.hasOwn(segment, 'voice')), false);
});

test('assignVoices rejects an empty reply voice pool with a Chinese error', () => {
  const { assignVoices } = loadVoiceAssignment();

  assert.throws(
    () => assignVoices(thread, { opVoice: 'A', replyVoices: [], mode: 'op-exclusive' }),
    /回复音色池不能为空/u
  );
});

test('system Provider may intentionally use the browser default voice for every author', () => {
  const { assignVoices } = loadVoiceAssignment();
  const assigned = assignVoices(thread, {
    opVoice: '', replyVoices: [], mode: 'op-exclusive', allowSingleVoice: true,
  });
  assert.deepEqual(assigned.map((segment) => segment.voice), ['', '', '', '', '']);
});
