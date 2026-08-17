const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadModules() {
  delete globalThis.QwenReaderText;
  delete globalThis.QwenReaderForumContent;
  delete globalThis.QwenReaderNormalizedDocument;
  delete globalThis.QwenReaderExtractors;
  for (const relativePath of ['shared/text.js', 'shared/forum-content.js', 'shared/generic-thread-detector.js', 'shared/normalized-document.js', 'shared/extractors.js', 'shared/sentence-range.js']) {
    const absolutePath = path.join(__dirname, '..', relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, 'utf8');
    vm.runInThisContext(source, { filename: relativePath });
  }
  return globalThis.QwenReaderExtractors;
}

test('Flarum keeps paragraph boundaries and speaker metadata inside one post', () => {
  const { parseFlarumApi } = loadModules();
  const blocks = parseFlarumApi({
    data: [{
      type: 'posts', id: '48666-1',
      attributes: { number: 1, contentHtml: '<p>First paragraph.</p><p>Second paragraph.</p><p>Agreed</p>' },
      relationships: { user: { data: { type: 'users', id: 'op' } } }
    }],
    included: [{ type: 'users', id: 'op', attributes: { username: 'Owner' } }]
  });

  assert.deepEqual(blocks.map((block) => block.text), ['First paragraph.', 'Second paragraph.', 'Agreed']);
  assert.ok(blocks.every((block) => block.authorId === 'op' && block.authorName === 'Owner' && block.floor === 1 && block.isOp));
  assert.deepEqual(blocks.map((block) => block.sourceLocator), [
    { adapter: 'flarum', containerSelector: '.PostStream-item[data-id="48666-1"] .Post-body', unitIndex: 0, fingerprint: '1qob6lf' },
    { adapter: 'flarum', containerSelector: '.PostStream-item[data-id="48666-1"] .Post-body', unitIndex: 1, fingerprint: 'rjbkmf' },
    { adapter: 'flarum', containerSelector: '.PostStream-item[data-id="48666-1"] .Post-body', unitIndex: 2, fingerprint: '13h5eh1' }
  ]);
});

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

test('parseFlarumApi identifies the original poster and preserves a two-character reply', () => {
  const { parseFlarumApi } = loadModules();
  const segments = parseFlarumApi(readFixture('flarum-api.json'));

  assert.deepEqual(
    segments.map(({ floor, authorId, authorName, isOp, text }) => ({ floor, authorId, authorName, isOp, text })),
    [
      { floor: 1, authorId: 'u1', authorName: '楼主', isOp: true, text: '这是楼主的第一段正文。' },
      { floor: 2, authorId: 'u2', authorName: '阿明', isOp: false, text: '同意' },
      { floor: 3, authorId: 'u3', authorName: '小雨', isOp: false, text: '补充一个不同作者的回复。' }
    ]
  );
});

test('parseFlarumApi removes forum controls and signature text from speech content', () => {
  const { parseFlarumApi } = loadModules();
  const spokenText = parseFlarumApi(readFixture('flarum-api.json')).map((segment) => segment.text).join('\n');

  assert.equal(spokenText.includes('点赞'), false);
  assert.equal(spokenText.includes('举报'), false);
  assert.equal(spokenText.includes('签名档'), false);
});

test('Flarum keeps anonymous posts distinct and only treats the first anonymous post as OP', () => {
  const { parseFlarumApi } = loadModules();
  const segments = parseFlarumApi({
    data: [
      { type: 'posts', id: 'anon-1', attributes: { number: 1, contentHtml: '<p>匿名首帖</p>' } },
      { type: 'posts', id: 'anon-2', attributes: { number: 2, contentHtml: '<p>匿名回复</p>' } }
    ],
    included: []
  });

  assert.equal(segments[0].isOp, true);
  assert.equal(segments[1].isOp, false);
  assert.notEqual(segments[0].authorId, segments[1].authorId);
});

test('forum API extraction removes bare quoted replies without removing the new reply', () => {
  const { parseFlarumApi, parseNodebbTopicPages } = loadModules();
  const flarum = parseFlarumApi({
    data: [{
      type: 'posts', id: '1',
      attributes: { number: 1, contentHtml: '<blockquote>旧内容</blockquote><p>新内容</p>' },
      relationships: { user: { data: { type: 'users', id: 'u1' } } }
    }],
    included: [{ type: 'users', id: 'u1', attributes: { username: 'owner' } }]
  });
  const nodebb = parseNodebbTopicPages([{
    uid: 1,
    posts: [{
      pid: 10, uid: 1, index: 0,
      content: '<blockquote>旧内容</blockquote><p>新内容</p>',
      user: { uid: 1, username: 'owner' }
    }]
  }]);

  assert.equal(flarum[0].text, '新内容');
  assert.equal(nodebb[0].text, '新内容');
});

test('extractFlarum fetches a discussion page and returns posts in floor order', async () => {
  const { extractFlarum } = loadModules();
  const payload = readFixture('flarum-api.json');
  const requestedUrls = [];
  const document = {
    location: { origin: 'https://bbs.viva-la-vita.org', pathname: '/d/23351' },
    querySelectorAll: () => []
  };

  const segments = await extractFlarum(document, async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  assert.match(requestedUrls[0], /filter%5Bdiscussion%5D=23351/);
  assert.deepEqual(segments.map((segment) => segment.floor), [1, 2, 3]);
});

test('Flarum adapter preserves a subdirectory base and follows same-origin pagination', async () => {
  const { extractDocument } = loadModules();
  const requested = [];
  const firstPage = {
    data: [{
      type: 'posts', id: '1',
      attributes: { number: 1, contentHtml: '<p>楼主首帖</p>' },
      relationships: { user: { data: { type: 'users', id: 'u1' } } }
    }],
    included: [{ type: 'users', id: 'u1', attributes: { username: '楼主' } }],
    links: { next: '/community/api/posts?page[offset]=50' }
  };
  const secondPage = {
    data: [{
      type: 'posts', id: '2',
      attributes: { number: 2, contentHtml: '<p>楼主续帖</p>' },
      relationships: { user: { data: { type: 'users', id: 'u1' } } }
    }],
    included: []
  };
  const document = makeLocationDocument('https://forum.example/community/d/123-topic');

  const result = await extractDocument(document, {
    fetchFn: async (url) => {
      requested.push(String(url));
      return jsonResponse(requested.length === 1 ? firstPage : secondPage, String(url));
    }
  });

  assert.match(requested[0], /^https:\/\/forum\.example\/community\/api\/posts\?/u);
  assert.equal(requested[1], 'https://forum.example/community/api/posts?page[offset]=50');
  assert.deepEqual(result.blocks.map(({ text, isOp }) => ({ text, isOp })), [
    { text: '楼主首帖', isOp: true },
    { text: '楼主续帖', isOp: true }
  ]);
});

test('Flarum DOM fallback derives stable authors without data-user-id and marks every OP post', () => {
  const { extractFlarumDom } = loadModules();
  const document = makeFlarumDocument([
    { id: '11', floor: 1, author: '楼主', href: '/u/owner', text: '开场' },
    { id: '12', floor: 2, author: '甲', href: '/u/a', text: '同意' },
    { id: '13', floor: 3, author: '楼主', href: '/u/owner', text: '再次补充' }
  ]);

  const segments = extractFlarumDom(document);

  assert.deepEqual(segments.map(({ authorId, isOp, text }) => ({ authorId, isOp, text })), [
    { authorId: 'profile:/u/owner', isOp: true, text: '开场' },
    { authorId: 'profile:/u/a', isOp: false, text: '同意' },
    { authorId: 'profile:/u/owner', isOp: true, text: '再次补充' }
  ]);
});

test('Discourse adapter fetches missing post ids in a subdirectory and marks later OP replies', async () => {
  const { extractDocument } = loadModules();
  const initial = readFixture('discourse-topic-initial.json');
  const missing = readFixture('discourse-topic-missing.json');
  const requested = [];
  const document = makeLocationDocument('https://forum.example/community/t/a-topic/42/3', {
    '#data-discourse-setup': { getAttribute: (name) => name === 'data-base-uri' ? '/community' : null }
  });

  const result = await extractDocument(document, {
    fetchFn: async (url, init) => {
      requested.push({ url: String(url), init });
      return jsonResponse(requested.length === 1 ? initial : missing, String(url));
    }
  });

  assert.equal(result.adapterId, 'discourse');
  assert.deepEqual(result.blocks.map(({ floor, text, isOp }) => ({ floor, text, isOp })), [
    { floor: 1, text: '楼主正文', isOp: true },
    { floor: 2, text: '顶', isOp: false },
    { floor: 3, text: '同意', isOp: false },
    { floor: 4, text: '楼主再次补充', isOp: true }
  ]);
  assert.equal(requested[0].url, 'https://forum.example/community/t/42.json');
  assert.match(requested[1].url, /^https:\/\/forum\.example\/community\/t\/42\/posts\.json\?/u);
  assert.match(requested[1].url, /post_ids%5B%5D=102/u);
  assert.match(requested[1].url, /post_ids%5B%5D=104/u);
  assert.equal(requested[1].init.credentials, 'same-origin');
});

test('Discourse numeric topic URLs do not mistake the post-number suffix for the topic id', async () => {
  const { extractDocument } = loadModules();
  const requested = [];
  const initial = readFixture('discourse-topic-initial.json');
  initial.post_stream.stream = [101, 103];
  const document = makeLocationDocument('https://forum.example/community/t/42/3');

  await extractDocument(document, {
    fetchFn: async (url) => {
      requested.push(String(url));
      return jsonResponse(initial, String(url));
    }
  });

  assert.equal(requested[0], 'https://forum.example/community/t/42.json');
});

test('pageIdentity keeps Discourse and Flarum floor navigation inside the same discussion', () => {
  const { pageIdentity } = loadModules();

  assert.equal(
    pageIdentity(makeLocationDocument('https://forum.example/community/t/a-topic/42/3')),
    pageIdentity(makeLocationDocument('https://forum.example/community/t/a-topic/42/99'))
  );
  assert.notEqual(
    pageIdentity(makeLocationDocument('https://forum.example/community/t/a-topic/42/3')),
    pageIdentity(makeLocationDocument('https://forum.example/community/t/another-topic/43/3'))
  );
  assert.equal(
    pageIdentity(makeLocationDocument('https://forum.example/community/d/23351-topic/4')),
    pageIdentity(makeLocationDocument('https://forum.example/community/d/23351-topic/18'))
  );
  assert.notEqual(
    pageIdentity(makeLocationDocument('https://forum.example/community/d/23351-topic/4')),
    pageIdentity(makeLocationDocument('https://forum.example/community/d/23352-topic/4'))
  );
});

test('pageIdentity preserves ordinary path, query and hash-router navigation', () => {
  const { pageIdentity } = loadModules();

  assert.notEqual(
    pageIdentity(makeLocationDocument('https://article.example/chapter/1?mode=full')),
    pageIdentity(makeLocationDocument('https://article.example/chapter/2?mode=full'))
  );
  assert.notEqual(
    pageIdentity(makeLocationDocument('https://article.example/chapter/1?mode=full')),
    pageIdentity(makeLocationDocument('https://article.example/chapter/1?mode=compact'))
  );
  assert.notEqual(
    pageIdentity(makeLocationDocument('https://spa.example/#/topic/1')),
    pageIdentity(makeLocationDocument('https://spa.example/#/topic/2'))
  );
});

test('NodeBB adapter follows pagination under a subdirectory and deduplicates posts', async () => {
  const { extractDocument } = loadModules();
  const first = readFixture('nodebb-topic-page-1.json');
  const second = readFixture('nodebb-topic-page-2.json');
  const requested = [];
  const document = makeLocationDocument('https://forum.example/community/topic/44/story');

  const result = await extractDocument(document, {
    fetchFn: async (url) => {
      requested.push(String(url));
      return jsonResponse(requested.length === 1 ? first : second, String(url));
    }
  });

  assert.equal(result.adapterId, 'nodebb');
  assert.deepEqual(result.blocks.map(({ floor, text, isOp }) => ({ floor, text, isOp })), [
    { floor: 1, text: 'NodeBB 楼主正文', isOp: true },
    { floor: 2, text: '同意', isOp: false },
    { floor: 3, text: '楼主第二次发言', isOp: true }
  ]);
  assert.equal(requested[0], 'https://forum.example/community/api/topic/44/story');
  assert.equal(requested[1], 'https://forum.example/community/api/topic/44/story?page=2');
});

test('NodeBB entered on page two still starts from the canonical topic API and fetches every page once', async () => {
  const { extractDocument } = loadModules();
  const first = readFixture('nodebb-topic-page-1.json');
  const second = readFixture('nodebb-topic-page-2.json');
  const requested = [];
  const document = makeLocationDocument('https://forum.example/community/topic/44/story/2');

  const result = await extractDocument(document, {
    fetchFn: async (url) => {
      requested.push(String(url));
      return jsonResponse(requested.length === 1 ? first : second, String(url));
    }
  });

  assert.deepEqual(requested, [
    'https://forum.example/community/api/topic/44/story',
    'https://forum.example/community/api/topic/44/story?page=2'
  ]);
  assert.deepEqual(result.blocks.map((item) => item.floor), [1, 2, 3]);
  assert.equal(result.complete, true);
});

test('Discourse anonymous posts remain distinct while the first readable post is OP', () => {
  const { parseDiscourseTopic } = loadModules();
  const segments = parseDiscourseTopic({
    post_stream: {
      posts: [
        { id: 1, post_number: 1, cooked: '<p>匿名首帖</p>', post_type: 1 },
        { id: 2, post_number: 2, cooked: '<p>匿名回复</p>', post_type: 1 }
      ]
    }
  }, []);

  assert.equal(segments[0].isOp, true);
  assert.equal(segments[1].isOp, false);
  assert.notEqual(segments[0].authorId, segments[1].authorId);
});

test('NodeBB reports the first API page before background pagination completes', async () => {
  const { extractDocument } = loadModules();
  const first = readFixture('nodebb-topic-page-1.json');
  const second = readFixture('nodebb-topic-page-2.json');
  const progress = [];
  const document = makeLocationDocument('https://forum.example/community/topic/44/story');
  const result = await extractDocument(document, {
    onProgress: async (partial, meta) => {
      progress.push({ count: partial.blocks.length, phase: meta.phase, complete: partial.complete });
    },
    fetchFn: async (url) => jsonResponse(String(url).includes('page=2') ? second : first, String(url))
  });

  assert.equal(result.complete, true);
  assert.equal(progress[0].phase, 'initial');
  assert.ok(progress[0].count > 0);
  assert.ok(progress.at(-1).count <= result.blocks.length);
  assert.ok(progress.length >= 2);
});

test('Discourse keeps paragraph boundaries and speaker metadata inside one post', () => {
  const { parseDiscourseTopic } = loadModules();
  const blocks = parseDiscourseTopic({
    post_stream: {
      posts: [{
        id: 91,
        user_id: 7,
        username: 'Owner',
        post_number: 4,
        post_type: 1,
        cooked: '<p>Opening thought.</p><p>Supporting detail.</p>'
      }]
    }
  }, []);

  assert.deepEqual(blocks.map((block) => block.text), ['Opening thought.', 'Supporting detail.']);
  assert.ok(blocks.every((block) => block.authorId === '7' && block.authorName === 'Owner' && block.floor === 4 && block.isOp));
  assert.deepEqual(blocks.map((block) => block.sourceLocator), [
    { adapter: 'discourse', containerSelector: 'article[data-post-id="91"] .cooked, article#post_91 .cooked', unitIndex: 0, fingerprint: '1rlycf8' },
    { adapter: 'discourse', containerSelector: 'article[data-post-id="91"] .cooked, article#post_91 .cooked', unitIndex: 1, fingerprint: 'jywbul' }
  ]);
});

test('Flarum live DOM emoji extraction stays aligned through playback splitting and first-sentence ranges', () => {
  const { extractFlarumDom } = loadModules();
  const firstSentence = '这几天摸乳头怎么没有感觉了😭😭，感受不到快感了，我这几天开发的也不频繁啊。';
  const continuation = '今天下午午睡起来碰乳头不管是轻点，上下拨还是揉，捏，提拉都没什么快感，好难过。突然很好奇大家看片的时候会不会代入自己。';
  const marker = '\uFFF0';
  const paragraph = {
    closest: () => null,
    querySelectorAll: () => [],
    cloneNode() {
      let projected = `这几天摸乳头怎么没有感觉了${marker}${marker}，感受不到快感了，我这几天开发的也不频繁啊。${continuation}`;
      const images = [0, 1].map(() => ({
        tagName: 'IMG',
        getAttribute(name) {
          return name === 'class' ? 'emoji' : name === 'alt' ? '😭' : null;
        },
        replaceWith(value) {
          projected = projected.replace(marker, value);
        }
      }));
      return {
        get textContent() { return projected.replaceAll(marker, ''); },
        querySelectorAll(selector) { return selector === 'img' ? images : []; }
      };
    }
  };
  const body = {
    querySelectorAll(selector) {
      return selector === 'p,h1,h2,h3,h4,h5,h6,li' ? [paragraph] : [];
    }
  };
  const post = {
    id: 'post-80611',
    getAttribute(name) {
      return name === 'data-id' ? '80611' : name === 'data-number' ? '165' : null;
    },
    querySelector(selector) {
      if (selector.includes('.Post-body')) return body;
      if (selector.includes('.PostUser-name')) return { textContent: 'Sweetui', getAttribute: () => '/u/sweetui' };
      if (selector.includes('a[href*="/u/"]')) return { getAttribute: () => '/u/sweetui' };
      return null;
    }
  };
  const document = {
    location: makeLocation('https://bbs.viva-la-vita.org/d/10627/165'),
    querySelectorAll(selector) {
      return selector.includes('PostStream-item') || selector === '.Post' ? [post] : [];
    }
  };

  const blocks = extractFlarumDom(document);
  const normalized = globalThis.QwenReaderDocument.createDocument({
    url: document.location,
    adapterId: 'flarum',
    blocks
  });
  const segments = globalThis.QwenReaderDocument.toPlaybackSegments(normalized, 260);

  assert.equal(blocks[0].text, firstSentence + continuation);
  assert.equal(segments[0].text, firstSentence);

  function domText(value) {
    return { nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] };
  }
  function domElement(tagName, children = [], attributes = {}) {
    return {
      nodeType: 1,
      nodeName: tagName.toUpperCase(),
      tagName: tagName.toUpperCase(),
      childNodes: children,
      getAttribute(name) { return attributes[name] || null; }
    };
  }
  const opening = domText('这几天摸乳头怎么没有感觉了');
  const ending = domText(`，感受不到快感了，我这几天开发的也不频繁啊。${continuation}`);
  const rangeRoot = domElement('p', [
    opening,
    domElement('img', [], { class: 'emoji', alt: '😭' }),
    domElement('img', [], { class: 'emoji', alt: '😭' }),
    ending
  ]);
  const index = globalThis.QwenReaderSentenceRange.buildTextIndex(rangeRoot);
  const firstMatch = globalThis.QwenReaderSentenceRange.findSegment(index, segments[0].text, 0);
  const secondMatch = globalThis.QwenReaderSentenceRange.findSegment(index, segments[1].text, firstMatch.nextOffset);

  assert.ok(firstMatch);
  assert.ok(secondMatch);
  assert.equal(firstMatch.startContainer, opening);
  assert.equal(firstMatch.endContainer, ending);
  assert.ok(secondMatch.normalizedStart >= firstMatch.normalizedEnd);
});

test('Discourse removes image attachment metadata and bare URLs but keeps descriptive link text', () => {
  const { parseDiscourseTopic } = loadModules();
  const segments = parseDiscourseTopic({
    post_stream: {
      posts: [{
        id: 31,
        user_id: 7,
        username: 'owner',
        post_number: 1,
        post_type: 1,
        cooked: [
          '<div class="lightbox-wrapper">',
          '<a class="lightbox" href="https://cdn.example/full.png">',
          '<img src="https://cdn.example/thumb.png" alt="image" width="350" height="318">',
          '<div class="meta"><span class="filename">image</span><span class="informations">350×318 24.5 KB</span></div>',
          '</a></div>',
          '<aside class="onebox"><a href="https://example.com/card">网页预览标题</a><p>网页预览摘要</p></aside>',
          '<p><a class="attachment" href="https://example.com/file.pdf">资料.pdf (2 MB)</a></p>',
          '<p>感觉我的建议已经很中肯了</p>',
          '<p><a href="https://example.com/raw">https://example.com/raw</a></p>',
          '<p><a href="https://example.com/guide">补充说明</a></p>'
        ].join('')
      }]
    }
  }, []);

  assert.equal(segments.map((segment) => segment.text).join(' '), '感觉我的建议已经很中肯了 补充说明');
});

test('NodeBB guest uid zero uses names instead of merging every guest into the OP', () => {
  const { parseNodebbTopicPages } = loadModules();
  const segments = parseNodebbTopicPages([{
    uid: 0,
    posts: [
      { pid: 1, uid: 0, index: 0, content: '<p>首帖</p>', user: { uid: 0, username: 'guest-a' } },
      { pid: 2, uid: 0, index: 1, content: '<p>回复</p>', user: { uid: 0, username: 'guest-b' } }
    ]
  }]);

  assert.equal(segments[0].isOp, true);
  assert.equal(segments[1].isOp, false);
  assert.equal(segments[0].authorId, 'name:guest-a');
  assert.equal(segments[1].authorId, 'name:guest-b');
});

test('NodeBB keeps paragraph boundaries and speaker metadata inside one post', () => {
  const { parseNodebbTopicPages } = loadModules();
  const blocks = parseNodebbTopicPages([{
    uid: 12,
    posts: [{
      pid: 501,
      uid: 12,
      index: 0,
      content: '<p>NodeBB first.</p><p>NodeBB second.</p>',
      user: { uid: 12, username: 'Owner' }
    }]
  }]);

  assert.deepEqual(blocks.map((block) => block.text), ['NodeBB first.', 'NodeBB second.']);
  assert.ok(blocks.every((block) => block.authorId === '12' && block.authorName === 'Owner' && block.floor === 1 && block.isOp));
  assert.deepEqual(blocks.map((block) => block.sourceLocator), [
    { adapter: 'nodebb', containerSelector: '[component="post"][data-pid="501"] [component="post/content"]', unitIndex: 0, fingerprint: '1wcxwvb' },
    { adapter: 'nodebb', containerSelector: '[component="post"][data-pid="501"] [component="post/content"]', unitIndex: 1, fingerprint: 'sx67nn' }
  ]);
});

test('NodeBB reports a pagination limit instead of claiming a capped topic is complete', async () => {
  const { extractDocument } = loadModules();
  const document = makeLocationDocument('https://forum.example/topic/44/story');
  let calls = 0;

  const result = await extractDocument(document, {
    fetchFn: async (url) => {
      calls += 1;
      return jsonResponse({
        title: '超长主题',
        pagination: { pageCount: 101 },
        posts: calls === 1 ? [{
          pid: 1,
          uid: 7,
          index: 0,
          content: '<p>第一页</p>',
          user: { uid: 7, username: 'owner' }
        }] : []
      }, String(url));
    }
  });

  assert.equal(calls, 100);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ['nodebb-pagination-limit']);
});

test('NodeBB fetches long topics with bounded parallelism', async () => {
  const { extractDocument } = loadModules();
  const document = makeLocationDocument('https://forum.example/topic/88/long-topic');
  let active = 0;
  let peak = 0;

  const result = await extractDocument(document, {
    fetchFn: async (url) => {
      const page = Number(new URL(String(url)).searchParams.get('page') || 1);
      if (page > 1) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      }
      return jsonResponse({
        title: '并发长主题',
        pagination: { pageCount: 9 },
        posts: [{
          pid: page,
          uid: page,
          index: page - 1,
          content: `<p>第 ${page} 页</p>`,
          user: { uid: page, username: `user-${page}` }
        }]
      }, String(url));
    }
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.blocks.map((block) => block.floor), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(peak > 1, `expected parallel page requests, saw ${peak}`);
  assert.ok(peak <= 6, `expected at most 6 parallel page requests, saw ${peak}`);
});

test('XenForo DOM adapter removes quotes, controls and signatures from current-page speech', async () => {
  const { extractDocument } = loadModules();
  const document = makeXenForoDocument();

  const result = await extractDocument(document, {});

  assert.equal(result.adapterId, 'xenforo');
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ['xenforo-current-page-only']);
  assert.deepEqual(result.blocks.map(({ floor, text }) => ({ floor, text })), [
    { floor: 1, text: '真正正文' },
    { floor: 2, text: '回复正文' }
  ]);
});

test('XenForo keeps paragraph boundaries and speaker metadata inside one post', () => {
  const { extractXenForo } = loadModules();
  const document = makeXenForoDocument([
    makeXenForoPost('9001', 'Owner', '#1', ['First XenForo paragraph.', 'Second XenForo paragraph.'])
  ]);

  const blocks = extractXenForo(document);

  assert.deepEqual(blocks.map((block) => block.text), ['First XenForo paragraph.', 'Second XenForo paragraph.']);
  assert.ok(blocks.every((block) => block.authorName === 'Owner' && block.floor === 1 && block.isOp));
  assert.deepEqual(blocks.map((block) => block.sourceLocator), [
    { adapter: 'xenforo', containerSelector: '.message--post[data-content="post-9001"] .message-body .bbWrapper, #js-post-9001 .message-body .bbWrapper', unitIndex: 0, fingerprint: '9a6va2' },
    { adapter: 'xenforo', containerSelector: '.message--post[data-content="post-9001"] .message-body .bbWrapper, #js-post-9001 .message-body .bbWrapper', unitIndex: 1, fingerprint: 'lsa0t2' }
  ]);
});

test('mirror card forum keeps br paragraphs, author identity, and a shared source container', async () => {
  const { extractDocument } = loadModules();
  const content = { innerHTML: 'First line<br>Second line<br>短' };
  const author = {
    textContent: 'Alice',
    getAttribute(name) { return name === 'href' ? '/author/40475' : ''; }
  };
  const subtitle = { textContent: 'Re: Thread title' };
  const post = {
    id: 'p280414',
    querySelector(selector) {
      if (selector === '.card-body') return content;
      if (selector.includes('.ui-link')) return author;
      if (selector.includes('.text-muted')) return subtitle;
      return null;
    }
  };
  const document = {
    title: 'Thread',
    location: makeLocation('https://mirror.chromaso.net/thread/29141/2'),
    querySelectorAll(selector) {
      if (selector === '.mm-post .card-body') return [content];
      if (selector === '.mm-post') return [post];
      return [];
    }
  };

  const result = await extractDocument(document, {});

  assert.equal(result.adapterId, 'mirror-card');
  assert.deepEqual(result.blocks.map(({ text, authorId, authorName, isOp }) => ({ text, authorId, authorName, isOp })), [
    { text: 'First line', authorId: '40475', authorName: 'Alice', isOp: false },
    { text: 'Second line', authorId: '40475', authorName: 'Alice', isOp: false },
    { text: '短', authorId: '40475', authorName: 'Alice', isOp: false }
  ]);
  assert.deepEqual(result.blocks.map((item) => item.sourceLocator.unitIndex), [0, 1, 2]);
  assert.ok(result.blocks.every((item) => item.sourceSelector === '[id="p280414"] .card-body'));
});

test('Readability receives a cloned document and wins over the generic fallback', async () => {
  const { extractDocument } = loadModules();
  const original = makeGenericDocument(['通用回退不应被使用']);
  original.location = makeLocation('https://article.example/story');
  const clone = { marker: 'clone' };
  original.cloneNode = () => clone;
  let receivedDocument;
  class FakeReadability {
    constructor(document) {
      receivedDocument = document;
    }

    parse() {
      return { title: '文章标题', textContent: '第一段\n\n第二段' };
    }
  }

  const result = await extractDocument(original, { ReadabilityCtor: FakeReadability });

  assert.equal(receivedDocument, clone);
  assert.equal(result.adapterId, 'readability');
  assert.equal(result.title, '文章标题');
  assert.deepEqual(result.blocks.map((block) => block.text), ['第一段', '第二段']);
});

test('Readability preserves br-only visual paragraphs for range mapping', async () => {
  const { extractDocument } = loadModules();
  const original = makeGenericDocument(['fallback']);
  original.location = makeLocation('https://mirror.example/thread/42/2');
  original.cloneNode = () => ({ marker: 'clone' });
  class BreakReadability {
    parse() {
      return {
        title: 'Thread',
        content: '<div class="card-body">First line<br>Second line<br><br>短</div>',
        textContent: 'First line Second line 短'
      };
    }
  }

  const result = await extractDocument(original, { ReadabilityCtor: BreakReadability });

  assert.equal(result.adapterId, 'readability');
  assert.deepEqual(result.blocks.map((block) => block.text), ['First line', 'Second line', '短']);
});

test('a null Readability result falls through to the generic extractor', async () => {
  const { extractDocument } = loadModules();
  const document = makeGenericDocument(['通用正文']);
  document.location = makeLocation('https://article.example/story');
  document.cloneNode = () => ({ marker: 'clone' });
  class NullReadability {
    parse() {
      return null;
    }
  }

  const result = await extractDocument(document, { ReadabilityCtor: NullReadability });

  assert.equal(result.adapterId, 'generic');
  assert.deepEqual(result.blocks.map((block) => block.text), ['通用正文']);
});

test('a forum-shaped URL with no forum posts falls back to Readability instead of returning an empty queue', async () => {
  const { extractDocument } = loadModules();
  const document = makeGenericDocument(['通用正文不应优先']);
  document.location = makeLocation('https://article.example/t/story/42');
  document.cloneNode = () => ({ marker: 'clone' });
  class FakeReadability {
    parse() {
      return { title: '实际长文章', textContent: '伪论坛路径下的真实正文' };
    }
  }

  const result = await extractDocument(document, {
    ReadabilityCtor: FakeReadability,
    fetchFn: async () => new Response('{}', { status: 404 })
  });

  assert.equal(result.adapterId, 'readability');
  assert.deepEqual(result.blocks.map((block) => block.text), ['伪论坛路径下的真实正文']);
  assert.ok(result.warnings.includes('discourse-empty-fallback'));
});

test('page scanning ignores an incidental text selection while explicit selection mode uses it', async () => {
  const { extractDocument } = loadModules();
  const document = makeGenericDocument(['页面正文']);
  document.location = makeLocation('https://article.example/selection-mode');
  document.getSelection = () => ({
    isCollapsed: false,
    toString: () => '偶然选中的文字'
  });

  const page = await extractDocument(document, { mode: 'page' });
  const selection = await extractDocument(document, { mode: 'selection' });

  assert.equal(page.adapterId, 'generic');
  assert.deepEqual(page.blocks.map((item) => item.text), ['页面正文']);
  assert.equal(selection.adapterId, 'selection');
  assert.deepEqual(selection.blocks.map((item) => item.text), ['偶然选中的文字']);
});

test('extractPage remains array-compatible while exposing normalized metadata', async () => {
  const { extractPage } = loadModules();
  const document = makeGenericDocument(['兼容旧播放器']);
  document.location = makeLocation('https://article.example/compatibility');

  const segments = await extractPage(document, {});

  assert.equal(Array.isArray(segments), true);
  assert.deepEqual(segments.map((segment) => segment.text), ['兼容旧播放器']);
  assert.equal(segments.documentMeta.adapterId, 'generic');
});

test('forum adapters rethrow AbortError instead of silently using a partial DOM fallback', async () => {
  const { extractDocument } = loadModules();
  const document = makeLocationDocument('https://forum.example/community/t/topic/42');
  const abortError = new Error('cancelled');
  abortError.name = 'AbortError';

  await assert.rejects(
    extractDocument(document, { fetchFn: async () => { throw abortError; } }),
    (error) => error === abortError
  );
});

test('extractGeneric chooses readable article blocks instead of navigation controls', () => {
  const { extractGeneric } = loadModules();
  const fixture = readFixture('generic-page.json');
  const article = makeCandidate('ARTICLE', fixture.articleBlocks, 1);
  const navigation = makeCandidate('NAV', fixture.navigationBlocks, 8);
  const document = { querySelectorAll: () => [navigation, article] };

  const segments = extractGeneric(document);

  assert.deepEqual(segments.map((segment) => segment.text), fixture.articleBlocks);
});

test('extractGeneric splits a br-only content container into visual paragraphs', () => {
  const { extractGeneric } = loadModules();
  const candidate = {
    tagName: 'DIV',
    innerHTML: 'First line<br>Second line<br>短',
    textContent: 'First line Second line 短',
    hidden: false,
    getAttribute: () => null,
    closest: () => null,
    cloneNode() {
      return { textContent: this.textContent, querySelectorAll: () => [] };
    },
    querySelectorAll(selector) {
      if (selector.includes('a')) return [];
      return [];
    }
  };
  const document = { querySelectorAll: () => [candidate] };

  const segments = extractGeneric(document);

  assert.deepEqual(segments.map((segment) => segment.text), ['First line', 'Second line', '短']);
});

function makeCandidate(tagName, blocks, linkCount) {
  const blockNodes = blocks.map((text) => ({
    tagName: 'P',
    textContent: text,
    hidden: false,
    getAttribute: () => null,
    closest: () => null
  }));
  return {
    tagName,
    textContent: blocks.join(' '),
    hidden: false,
    getAttribute: () => null,
    querySelectorAll(selector) {
      return selector.includes('a') ? Array.from({ length: linkCount }, () => ({})) : blockNodes;
    }
  };
}

function makeLocation(href) {
  const url = new URL(href);
  return {
    href: url.href,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    hostname: url.hostname
  };
}

function makeLocationDocument(href, selectors = {}) {
  return {
    location: makeLocation(href),
    title: '测试主题',
    documentElement: { id: '' },
    getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    querySelector(selector) {
      return selectors[selector] || null;
    },
    querySelectorAll: () => []
  };
}

function jsonResponse(payload, url) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => 'application/json' },
    json: async () => payload
  };
}

function makeFlarumDocument(posts) {
  const nodes = posts.map((post) => {
    const body = makeRemovableBody(post.text, []);
    const author = { textContent: post.author, getAttribute: () => post.href };
    return {
      id: `post-${post.id}`,
      getAttribute(name) {
        if (name === 'data-id') return post.id;
        if (name === 'data-number') return String(post.floor);
        return null;
      },
      querySelector(selector) {
        if (selector.includes('.Post-body')) return body;
        if (selector.includes('.PostUser-name')) return author;
        if (selector.includes('a[href*="/u/"]')) return author;
        return null;
      }
    };
  });
  return {
    location: makeLocation('https://forum.example/community/d/123-topic'),
    querySelectorAll(selector) {
      return selector.includes('PostStream-item') || selector === '.Post' ? nodes : [];
    }
  };
}

function makeRemovableBody(text, removableTexts) {
  const readableText = removableTexts.reduce((current, value) => current.replace(value, ''), text).trim();
  const semantic = makeSemanticBody([readableText]);
  return {
    textContent: text,
    querySelectorAll(selector) {
      if (selector === 'p,h1,h2,h3,h4,h5,h6,li') return semantic.querySelectorAll(selector);
      return [];
    },
    cloneNode() {
      const removed = new Set();
      return {
        querySelectorAll() {
          return removableTexts.map((value) => ({ remove: () => removed.add(value) }));
        },
        get textContent() {
          return readableText;
        }
      };
    }
  };
}

function makeXenForoDocument(posts = [
    makeXenForoPost('9001', '楼主', '#1', '真正正文 引用旧文 点赞 签名档', ['引用旧文', '点赞', '签名档']),
    makeXenForoPost('9002', '回复者', '#2', '回复正文 操作按钮', ['操作按钮'])
  ]) {
  return {
    location: makeLocation('https://xen.example/threads/topic.22/'),
    title: 'XenForo 主题',
    documentElement: {
      id: 'XF',
      getAttribute(name) {
        if (name === 'data-template') return 'thread_view';
        if (name === 'data-content-key') return 'thread-22';
        return null;
      }
    },
    getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector.includes('.message--post') ? posts : [];
    }
  };
}

function makeXenForoPost(id, author, floor, content, removable) {
  const body = Array.isArray(content)
    ? makeSemanticBody(content)
    : makeRemovableBody(content, removable || []);
  return {
    id: `js-post-${id}`,
    getAttribute(name) {
      if (name === 'data-content') return `post-${id}`;
      if (name === 'data-author') return author;
      return null;
    },
    querySelector(selector) {
      if (selector.includes('.bbWrapper') || selector === '.message-body') return body;
      if (selector.startsWith('.message-attribution-main')) return { textContent: '2026年7月31日 10:42' };
      if (selector.includes('message-attribution-opposite') || selector.includes('message-attribution-gadget')) {
        return { textContent: floor };
      }
      return null;
    }
  };
}

function makeSemanticBody(paragraphs) {
  const elements = paragraphs.map((textContent) => ({
    textContent,
    closest: () => null,
    querySelectorAll: () => [],
    cloneNode() {
      return { textContent, querySelectorAll: () => [] };
    }
  }));
  return {
    textContent: paragraphs.join(' '),
    querySelectorAll(selector) {
      return selector === 'p,h1,h2,h3,h4,h5,h6,li' ? elements : [];
    },
    cloneNode() {
      return { textContent: paragraphs.join(' '), querySelectorAll: () => [] };
    }
  };
}

function makeGenericDocument(blocks) {
  const article = makeCandidate('ARTICLE', blocks, 0);
  return {
    title: '普通文章',
    documentElement: { id: '', getAttribute: () => null },
    getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector.includes('article') ? [article] : [];
    }
  };
}

test('candidate evaluator records deterministic quality metrics and penalizes duplicate blocks', () => {
  const { evaluateCandidate } = loadModules();
  const diverse = evaluateCandidate({
    adapterId: 'generic',
    blocks: [
      { text: '第一段包含足够长的正文，用来验证候选质量评分。' },
      { text: '第二段提供不同的信息，因此应该获得较高的内容多样性。' }
    ]
  });
  const duplicated = evaluateCandidate({
    adapterId: 'generic',
    blocks: [
      { text: '完全重复的正文片段。' },
      { text: '完全重复的正文片段。' },
      { text: '完全重复的正文片段。' }
    ]
  });

  assert.equal(diverse.metrics.blockCount, 2);
  assert.equal(diverse.metrics.uniqueRatio, 1);
  assert.ok(diverse.score > duplicated.score);
});

test('candidate chooser prefers Readability on an exact quality tie', () => {
  const { chooseCandidate } = loadModules();
  const readability = { id: 'readability', score: 60, document: { adapterId: 'readability' } };
  const generic = { id: 'generic', score: 60, document: { adapterId: 'generic' } };

  assert.equal(chooseCandidate([generic, readability]), readability);
});
