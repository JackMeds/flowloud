(function attachExtractors(global) {
  'use strict';

  const text = global.QwenReaderText;
  const model = global.QwenReaderNormalizedDocument;
  const ForumContent = global.QwenReaderForumContent;
  const GenericThreadDetector = global.QwenReaderGenericThreadDetector;
  const MAX_PAGES = 100;
  const MAX_POSTS = 5000;
  const REMOVABLE_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'button', 'nav', 'aside', 'footer',
    '[hidden]', '[aria-hidden="true"]', '[role="button"]',
    '.Post-controls', '.Post-actions', '.Post-signature', '.Post-meta',
    '.message-signature', '.message-attribution-opposite', '.message-footer',
    '.bbCodeBlock--quote', '.quote', '.signature', '.reactionsBar',
    '.item-like', '.item-reply', '.Button', '.dropdown', '.badge',
    '.toolbar', '.advertisement', '.ads',
    '.lightbox-wrapper', '.onebox', '.link-preview', '.attachment',
    '.image-metadata', '.file-info'
  ].join(', ');
  const GENERIC_CONTROL_PATTERN = /^(?:点赞|回复|编辑|举报|分享|收藏|登录|注册|首页|上一页|下一页)$/u;

  function requireModel() {
    if (!model) throw new Error('QwenReaderNormalizedDocument must load before extractors.js');
    return model;
  }

  function clean(value) {
    return text && typeof text.cleanText === 'function'
      ? text.cleanText(value)
      : String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
  }

  function getLocationUrl(document) {
    const location = document && document.location;
    if (!location) return new URL('https://invalid.local/');
    if (location.href) return new URL(String(location.href));
    return new URL(
      `${String(location.origin || 'https://invalid.local')}${String(location.pathname || '/')}${String(location.search || '')}${String(location.hash || '')}`
    );
  }

  function isAbortError(error) {
    return Boolean(error && error.name === 'AbortError');
  }

  function authorKey(id, name) {
    let stableId = String(id == null ? '' : id).trim();
    if (/^\d+$/u.test(stableId) && Number(stableId) <= 0) stableId = '';
    if (stableId) return stableId;
    const stableName = clean(name).toLocaleLowerCase();
    return stableName ? `name:${stableName}` : '';
  }

  function forumAuthor(id, name, anonymousId) {
    const displayName = clean(name) || '匿名用户';
    const nameForIdentity = displayName === '匿名用户' ? '' : displayName;
    const key = authorKey(id, nameForIdentity);
    return {
      id: key || `anonymous:${String(anonymousId || 'unknown')}`,
      name: displayName,
      stable: Boolean(key)
    };
  }

  function block(input) {
    return requireModel().createBlock(Object.assign({ type: 'forum-post' }, input));
  }

  function expandForumPost(meta, contentSource, options) {
    if (!ForumContent) throw new Error('QwenReaderForumContent must load before extractors.js');
    const units = contentSource && typeof contentSource === 'object'
      ? ForumContent.semanticUnitsFromElement(contentSource, options)
      : ForumContent.semanticUnitsFromHtml(contentSource, options);
    return units.map((unit) => block(Object.assign({}, meta, {
      id: `${meta.id}:unit:${unit.unitIndex}`,
      text: unit.text,
      sourceLocator: {
        adapter: meta.adapter,
        containerSelector: meta.containerSelector,
        unitIndex: unit.unitIndex,
        fingerprint: unit.fingerprint
      }
    })));
  }

  function documentResult(document, input) {
    const location = document && document.location;
    return requireModel().createDocument(Object.assign({
      url: location && (location.href || `${location.origin || ''}${location.pathname || ''}${location.search || ''}${location.hash || ''}`),
      title: document && document.title
    }, input));
  }

  function makeSameOriginUrl(value, baseValue, expectedOrigin) {
    const url = new URL(String(value), String(baseValue));
    if (url.origin !== expectedOrigin) throw new Error('Refusing cross-origin forum API URL');
    return url;
  }

  async function fetchJson(fetchFn, url, context) {
    if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable');
    const expectedOrigin = context.origin;
    const requestUrl = makeSameOriginUrl(url, context.baseUrl, expectedOrigin);
    const response = await fetchFn(requestUrl.toString(), {
      credentials: 'same-origin',
      signal: context.signal
    });
    if (!response || !response.ok) {
      throw new Error(`Forum API request failed${response ? ` (${response.status})` : ''}`);
    }
    const payload = await response.json();
    return {
      payload,
      url: response.url || requestUrl.toString()
    };
  }

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&nbsp;/giu, ' ')
      .replace(/&amp;/giu, '&')
      .replace(/&lt;/giu, '<')
      .replace(/&gt;/giu, '>')
      .replace(/&quot;/giu, '"')
      .replace(/&#39;|&apos;/giu, "'");
  }

  function htmlToReadableText(html, DOMParserCtor, options) {
    const settings = options || {};
    const Parser = DOMParserCtor || global.DOMParser;
    if (typeof Parser === 'function') {
      try {
        const parsed = new Parser().parseFromString(String(html || ''), 'text/html');
        const body = parsed && parsed.body;
        if (body) return clean(elementReadableText(body, settings));
      } catch (_) {
        // Fall back to a non-executing string conversion in minimal test hosts.
      }
    }

    let source = String(html || '');
    if (settings.removeBlockquotes) {
      source = source.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote\s*>/giu, ' ');
    }
    source = source.replace(
      /<(blockquote|aside|footer|nav|button|div|a|figure)[^>]*(?:class|role)=["'][^"']*(?:quote|signature|controls?|actions?|reactions?|toolbar|button|badge|dropdown|advertisement|ads|lightbox|onebox|link-preview|attachment|image-metadata|file-info)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/giu,
      ' '
    );
    source = source.replace(/<(?:script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg)\s*>/giu, ' ');
    source = source.replace(/<br\s*\/?>/giu, '\n');
    source = source.replace(/<\/(?:p|div|li|blockquote|h[1-6]|section|article)\s*>/giu, '\n');
    source = source.replace(/<[^>]+>/gu, ' ');
    return clean(decodeEntities(source));
  }

  function cloneReadableBody(body, options) {
    if (!body || typeof body.cloneNode !== 'function') return body;
    const clone = body.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      const selector = options && options.removeBlockquotes
        ? `${REMOVABLE_SELECTOR}, blockquote`
        : REMOVABLE_SELECTOR;
      Array.from(clone.querySelectorAll(selector)).forEach((element) => {
        if (element && typeof element.remove === 'function') element.remove();
      });
    }
    return clone;
  }

  function elementReadableText(element, options) {
    const readable = cloneReadableBody(element, options);
    return clean(readable && readable.textContent);
  }

  function postNumber(post) {
    const value = Number(post && post.attributes && post.attributes.number);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  }

  function getPostAuthorId(post) {
    const relationship = post && post.relationships && post.relationships.user;
    return relationship && relationship.data && relationship.data.id != null
      ? String(relationship.data.id)
      : '';
  }

  function parseFlarumApi(payload, options) {
    const source = payload || {};
    const userNames = new Map(
      (Array.isArray(source.included) ? source.included : [])
        .filter((record) => record && record.type === 'users')
        .map((record) => [
          String(record.id),
          clean((record.attributes || {}).displayName || (record.attributes || {}).username)
        ])
    );
    const uniquePosts = new Map();
    for (const post of Array.isArray(source.data) ? source.data : []) {
      if (post && post.type === 'posts' && !uniquePosts.has(String(post.id))) {
        uniquePosts.set(String(post.id), post);
      }
    }
    const posts = Array.from(uniquePosts.values()).sort((left, right) => postNumber(left) - postNumber(right));
    const firstPost = posts.find((post) => htmlToReadableText(
      (post.attributes || {}).contentHtml || '',
      options && options.DOMParserCtor,
      { removeBlockquotes: true }
    ));
    const firstPostId = firstPost ? String(firstPost.id) : '';
    const firstAuthorId = firstPost ? getPostAuthorId(firstPost) : '';
    const opAuthor = firstPost
      ? forumAuthor(firstAuthorId, userNames.get(firstAuthorId), firstPostId)
      : null;

    return posts.flatMap((post) => {
      const id = String(post.id);
      const rawAuthorId = getPostAuthorId(post);
      const author = forumAuthor(rawAuthorId, userNames.get(rawAuthorId), `flarum:${id}`);
      const sourceSelector = `.PostStream-item[data-id="${cssString(id)}"]`;
      return expandForumPost({
        id: `flarum:post:${id}`,
        adapter: 'flarum',
        containerSelector: `${sourceSelector} .Post-body`,
        postId: id,
        floor: postNumber(post),
        authorId: author.id,
        authorName: author.name,
        isOp: id === firstPostId || Boolean(opAuthor && opAuthor.stable && author.stable && author.id === opAuthor.id),
        sourceKey: `flarum:${id}`,
        sourceSelector
      }, (post.attributes || {}).contentHtml || '', Object.assign({}, options, { removeBlockquotes: true }));
    });
  }

  function cssString(value) {
    return String(value).replace(/["\\]/gu, '\\$&');
  }

  function flarumRoute(document) {
    const url = getLocationUrl(document);
    const match = url.pathname.match(/^(.*?)\/d\/(\d+)(?:-[^/]*)?(?:\/.*)?$/u);
    return match ? { url, basePath: match[1], discussionId: match[2] } : null;
  }

  function makeFlarumPostsUrl(origin, discussionId, basePath) {
    const path = `${basePath || ''}/api/posts`.replace(/\/{2,}/gu, '/');
    const url = new URL(path.startsWith('/') ? path : `/${path}`, origin);
    url.searchParams.set('filter[discussion]', discussionId);
    url.searchParams.set('sort', 'number');
    url.searchParams.set('page[limit]', '50');
    url.searchParams.set('page[offset]', '0');
    url.searchParams.set('include', 'user');
    return url.toString();
  }

  function getDomAuthor(post, index) {
    if (!post) return { id: `anonymous:${index}`, name: '匿名用户' };
    const directId = typeof post.getAttribute === 'function' ? post.getAttribute('data-user-id') : '';
    const nameNode = typeof post.querySelector === 'function'
      ? post.querySelector('.PostUser-name, .PostUser')
      : null;
    const authorName = clean(nameNode && nameNode.textContent) || '匿名用户';
    if (directId) return { id: String(directId), name: authorName };
    const profile = typeof post.querySelector === 'function'
      ? post.querySelector('.PostUser-name[href], a.PostUser-name[href], .PostUser a[href*="/u/"], a[href*="/u/"]')
      : null;
    const href = profile && typeof profile.getAttribute === 'function' ? profile.getAttribute('href') : '';
    if (href) return { id: `profile:${href}`, name: authorName };
    if (authorName !== '匿名用户') return { id: authorKey('', authorName), name: authorName };
    return { id: `anonymous:${index}`, name: authorName };
  }

  function extractFlarumDom(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    let posts = Array.from(document.querySelectorAll(
      '.DiscussionPage .PostStream .PostStream-item[data-id][data-number], .PostStream-item[data-id][data-number]'
    ));
    if (!posts.length) posts = Array.from(document.querySelectorAll('.Post'));
    const normalized = posts.map((post, index) => {
      const body = typeof post.querySelector === 'function' ? post.querySelector('.Post-body') : null;
      const author = getDomAuthor(post, index);
      const postId = String((post.getAttribute && post.getAttribute('data-id')) || post.id || index + 1).replace(/^post-/u, '');
      const floor = Number(post.getAttribute && post.getAttribute('data-number')) || index + 1;
      return { post, body, author, postId, floor };
    });
    const first = normalized.find((item) => elementReadableText(item.body, { removeBlockquotes: true }));
    const opKey = first && first.author.id;
    return normalized.flatMap((item) => {
      const sourceSelector = `.PostStream-item[data-id="${cssString(item.postId)}"]`;
      return expandForumPost({
      id: `flarum:post:${item.postId}`,
      adapter: 'flarum',
      containerSelector: `${sourceSelector} .Post-body`,
      postId: item.postId,
      floor: item.floor,
      authorId: item.author.id,
      authorName: item.author.name,
      isOp: Boolean(opKey) && item.author.id === opKey,
      sourceKey: `flarum:${item.postId}`,
      sourceSelector
      }, item.body, { removeBlockquotes: true });
    });
  }

  async function extractFlarumDocument(document, options) {
    const route = flarumRoute(document);
    const fetchFn = options && options.fetchFn;
    if (!route || typeof fetchFn !== 'function') {
      return documentResult(document, {
        adapterId: 'flarum',
        blocks: extractFlarumDom(document),
        complete: false,
        warnings: ['flarum-current-dom-only']
      });
    }
    const combined = { data: [], included: [] };
    let nextUrl = makeFlarumPostsUrl(route.url.origin, route.discussionId, route.basePath);
    const visited = new Set();
    let fetchedPages = 0;
    try {
      while (nextUrl && fetchedPages < MAX_PAGES && combined.data.length < MAX_POSTS) {
        if (visited.has(nextUrl)) throw new Error('Flarum pagination loop');
        visited.add(nextUrl);
        const response = await fetchJson(fetchFn, nextUrl, {
          origin: route.url.origin,
          baseUrl: nextUrl,
          signal: options.signal
        });
        fetchedPages += 1;
        combined.data.push(...(Array.isArray(response.payload.data) ? response.payload.data : []));
        combined.included.push(...(Array.isArray(response.payload.included) ? response.payload.included : []));
        const link = response.payload.links && response.payload.links.next;
        nextUrl = link
          ? makeSameOriginUrl(link, response.url, route.url.origin).toString()
          : '';
      }
      const blocks = parseFlarumApi(combined, options);
      return documentResult(document, {
        adapterId: 'flarum',
        blocks,
        complete: !nextUrl,
        warnings: nextUrl ? ['flarum-pagination-limit'] : [],
        stats: { fetchedPages, extractedPosts: blocks.length }
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (combined.data.length) {
        const blocks = parseFlarumApi(combined, options);
        return documentResult(document, {
          adapterId: 'flarum',
          blocks,
          complete: false,
          warnings: ['flarum-api-partial'],
          stats: { fetchedPages, extractedPosts: blocks.length }
        });
      }
      return documentResult(document, {
        adapterId: 'flarum',
        blocks: extractFlarumDom(document),
        complete: false,
        warnings: ['flarum-api-unavailable']
      });
    }
  }

  async function extractFlarum(document, fetchFn) {
    return (await extractFlarumDocument(document, { fetchFn })).blocks;
  }

  function discourseRoute(document) {
    const url = getLocationUrl(document);
    const markerIndex = url.pathname.lastIndexOf('/t/');
    if (markerIndex < 0) return null;
    const routeParts = url.pathname.slice(markerIndex + 3).split('/').filter(Boolean);
    const topicIndex = /^\d+$/u.test(routeParts[0] || '') ? 0 : 1;
    if (!/^\d+$/u.test(routeParts[topicIndex] || '')) return null;
    const topicId = routeParts[topicIndex];
    let basePath = url.pathname.slice(0, markerIndex);
    const setup = document && typeof document.querySelector === 'function'
      ? document.querySelector('#data-discourse-setup')
      : null;
    const declaredBase = setup && typeof setup.getAttribute === 'function'
      ? setup.getAttribute('data-base-uri')
      : '';
    if (declaredBase && String(declaredBase).startsWith('/')) basePath = String(declaredBase).replace(/\/$/u, '');
    return { url, basePath, topicId };
  }

  function discourseAuthor(post) {
    const name = clean(post && (post.display_username || post.name || post.username)) || '匿名用户';
    return forumAuthor(
      post && post.user_id,
      name,
      `discourse:${post && post.id != null ? post.id : 'unknown'}`
    );
  }

  function parseDiscourseTopic(initialPayload, missingPayloads, options) {
    const all = [];
    const initialStream = initialPayload && initialPayload.post_stream;
    all.push(...(initialStream && Array.isArray(initialStream.posts) ? initialStream.posts : []));
    for (const payload of Array.isArray(missingPayloads) ? missingPayloads : []) {
      const stream = payload && payload.post_stream;
      all.push(...(stream && Array.isArray(stream.posts) ? stream.posts : []));
    }
    const unique = new Map();
    for (const post of all) {
      const id = post && post.id != null ? String(post.id) : '';
      if (id && !unique.has(id)) unique.set(id, post);
    }
    const posts = Array.from(unique.values())
      .filter((post) => !post.deleted_at && !post.hidden && (post.post_type == null || Number(post.post_type) === 1))
      .sort((left, right) => Number(left.post_number) - Number(right.post_number));
    const first = posts.find((post) => htmlToReadableText(
      post.cooked,
      options && options.DOMParserCtor,
      { removeBlockquotes: true }
    ));
    const firstId = first && first.id != null ? String(first.id) : '';
    const opAuthor = first ? discourseAuthor(first) : null;
    return posts.flatMap((post) => {
      const id = String(post.id);
      const author = discourseAuthor(post);
      const sourceSelector = `article[data-post-id="${cssString(id)}"], article#post_${cssString(id)}`;
      return expandForumPost({
        id: `discourse:post:${id}`,
        adapter: 'discourse',
        containerSelector: `article[data-post-id="${cssString(id)}"] .cooked, article#post_${cssString(id)} .cooked`,
        postId: id,
        floor: Number(post.post_number),
        authorId: author.id,
        authorName: author.name,
        isOp: id === firstId || Boolean(opAuthor && opAuthor.stable && author.stable && author.id === opAuthor.id),
        sourceKey: `discourse:${id}`,
        sourceSelector
      }, post.cooked, Object.assign({}, options, { removeBlockquotes: true }));
    });
  }

  function extractDiscourseDom(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    const nodes = Array.from(document.querySelectorAll('article[data-post-id], article[id^="post_"]'));
    const mapped = nodes.map((post, index) => {
      const content = post.querySelector && post.querySelector('.cooked, [itemprop="text"]');
      const authorNode = post.querySelector && post.querySelector('[data-user-card], .names .username, .topic-meta-data .username');
      const authorName = clean(authorNode && authorNode.textContent) || '匿名用户';
      const authorId = String((authorNode && authorNode.getAttribute && authorNode.getAttribute('data-user-card')) || authorKey('', authorName));
      const postId = String((post.getAttribute && post.getAttribute('data-post-id')) || post.id || index + 1).replace(/^post_/u, '');
      const floorNode = post.querySelector && post.querySelector('.post-number, a.post-date');
      const floorMatch = clean(floorNode && floorNode.textContent).match(/(\d+)/u);
      return { postId, floor: floorMatch ? Number(floorMatch[1]) : index + 1, authorId, authorName, content };
    }).filter((item) => ForumContent.semanticUnitsFromElement(item.content, { removeBlockquotes: true }).length);
    const first = mapped.slice().sort((a, b) => a.floor - b.floor)[0];
    return mapped.sort((a, b) => a.floor - b.floor).flatMap((item) => {
      const sourceSelector = `article[data-post-id="${cssString(item.postId)}"], article#post_${cssString(item.postId)}`;
      return expandForumPost({
      id: `discourse:post:${item.postId}`,
      adapter: 'discourse',
      containerSelector: `article[data-post-id="${cssString(item.postId)}"] .cooked, article#post_${cssString(item.postId)} .cooked`,
      postId: item.postId,
      floor: item.floor,
      authorId: item.authorId,
      authorName: item.authorName,
      isOp: Boolean(first) && first.authorId === item.authorId,
      sourceKey: `discourse:${item.postId}`,
      sourceSelector
      }, item.content, { removeBlockquotes: true });
    });
  }

  async function extractDiscourseDocument(document, options) {
    const route = discourseRoute(document);
    const fetchFn = options && options.fetchFn;
    if (!route || typeof fetchFn !== 'function') {
      return documentResult(document, {
        adapterId: 'discourse',
        blocks: extractDiscourseDom(document),
        complete: false,
        warnings: ['discourse-current-dom-only']
      });
    }
    const initialUrl = new URL(`${route.basePath || ''}/t/${route.topicId}.json`.replace(/\/{2,}/gu, '/'), route.url.origin);
    try {
      const initialResponse = await fetchJson(fetchFn, initialUrl, {
        origin: route.url.origin,
        baseUrl: initialUrl,
        signal: options.signal
      });
      const initial = initialResponse.payload;
      const stream = initial && initial.post_stream;
      const ids = stream && Array.isArray(stream.stream) ? stream.stream.map(String) : [];
      const embedded = stream && Array.isArray(stream.posts) ? stream.posts : [];
      const present = new Set(embedded.map((post) => String(post.id)));
      const missing = ids.filter((id) => !present.has(id));
      const pages = [];
      const failedIds = [];
      for (let index = 0; index < missing.length; index += 20) {
        const batch = missing.slice(index, index + 20);
        const batchUrl = new URL(`${route.basePath || ''}/t/${route.topicId}/posts.json`.replace(/\/{2,}/gu, '/'), route.url.origin);
        batch.forEach((id) => batchUrl.searchParams.append('post_ids[]', id));
        try {
          const response = await fetchJson(fetchFn, batchUrl, {
            origin: route.url.origin,
            baseUrl: batchUrl,
            signal: options.signal
          });
          pages.push(response.payload);
        } catch (error) {
          if (isAbortError(error)) throw error;
          failedIds.push(...batch);
        }
      }
      const blocks = parseDiscourseTopic(initial, pages, options);
      return documentResult(document, {
        adapterId: 'discourse',
        title: initial.title || (document && document.title),
        blocks,
        complete: failedIds.length === 0 && blocks.length === ids.length,
        warnings: failedIds.length ? [`discourse-missing-posts:${failedIds.join(',')}`] : [],
        stats: { expectedPosts: ids.length, extractedPosts: blocks.length, fetchedPages: 1 + pages.length }
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return documentResult(document, {
        adapterId: 'discourse',
        blocks: extractDiscourseDom(document),
        complete: false,
        warnings: ['discourse-api-unavailable']
      });
    }
  }

  function nodebbRoute(document) {
    const url = getLocationUrl(document);
    const match = url.pathname.match(/^(.*?)\/topic\/(\d+)(\/.*)?$/u);
    if (!match) return null;
    const suffixParts = String(match[3] || '').split('/').filter(Boolean);
    if (suffixParts.length > 1 && /^\d+$/u.test(suffixParts[suffixParts.length - 1])) {
      suffixParts.pop();
    }
    const suffix = suffixParts.length ? `/${suffixParts.join('/')}` : '';
    const apiPath = `${match[1]}/api/topic/${match[2]}${suffix}`.replace(/\/{2,}/gu, '/');
    return { url, topicId: match[2], apiUrl: new URL(apiPath, url.origin) };
  }

  function parseNodebbTopicPages(pages, options) {
    const list = Array.isArray(pages) ? pages : [];
    const root = list[0] || {};
    const unique = new Map();
    list.forEach((page) => {
      (Array.isArray(page && page.posts) ? page.posts : []).forEach((post) => {
        const id = post && post.pid != null ? String(post.pid) : '';
        if (id && !unique.has(id)) unique.set(id, post);
      });
    });
    const posts = Array.from(unique.values())
      .filter((post) => !post.deleted && !post.isDeleted && post.status !== 'deleted')
      .sort((left, right) => Number(left.index) - Number(right.index));
    const first = posts[0];
    const firstId = first && first.pid != null ? String(first.pid) : '';
    const firstUser = first && first.user || {};
    const firstName = clean(firstUser.displayname || firstUser.username || first && first.username);
    const firstAuthor = first
      ? forumAuthor(first.uid != null ? first.uid : firstUser.uid, firstName, `nodebb:${firstId}`)
      : null;
    const rootOpKey = authorKey(root.uid, '');
    const opKey = rootOpKey || (firstAuthor && firstAuthor.stable ? firstAuthor.id : '');
    return posts.flatMap((post) => {
      const id = String(post.pid);
      const user = post.user || {};
      const authorName = clean(user.displayname || user.username || post.username) || '匿名用户';
      const author = forumAuthor(
        post.uid != null ? post.uid : user.uid,
        authorName,
        `nodebb:${id}`
      );
      const index = Number(post.index);
      const sourceSelector = `[component="post"][data-pid="${cssString(id)}"]`;
      return expandForumPost({
        id: `nodebb:post:${id}`,
        adapter: 'nodebb',
        containerSelector: `${sourceSelector} [component="post/content"]`,
        postId: id,
        floor: Number.isFinite(index) ? index + 1 : null,
        authorId: author.id,
        authorName,
        isOp: post.topicOwnerPost === true || id === firstId || Boolean(opKey && author.stable && author.id === opKey),
        sourceKey: `nodebb:${id}`,
        sourceSelector
      }, post.content, Object.assign({}, options, { removeBlockquotes: true }));
    });
  }

  function extractNodebbDom(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    const nodes = Array.from(document.querySelectorAll('[component="post"][data-pid], li[data-pid]'));
    const mapped = nodes.map((post, index) => {
      const content = post.querySelector && post.querySelector('[component="post/content"], .content');
      const authorNode = post.querySelector && post.querySelector('[component="username"], [data-username]');
      const authorName = clean(authorNode && (authorNode.getAttribute && authorNode.getAttribute('data-username') || authorNode.textContent)) || '匿名用户';
      const postId = String((post.getAttribute && post.getAttribute('data-pid')) || index + 1);
      const author = forumAuthor(
        post.getAttribute && post.getAttribute('data-uid'),
        authorName,
        `nodebb:${postId}`
      );
      const indexValue = Number(post.getAttribute && post.getAttribute('data-index'));
      return { postId, floor: Number.isFinite(indexValue) ? indexValue + 1 : index + 1, authorId: author.id, authorName, content };
    }).filter((item) => ForumContent.semanticUnitsFromElement(item.content, { removeBlockquotes: true }).length);
    const first = mapped.slice().sort((a, b) => a.floor - b.floor)[0];
    return mapped.sort((a, b) => a.floor - b.floor).flatMap((item) => {
      const sourceSelector = `[component="post"][data-pid="${cssString(item.postId)}"]`;
      return expandForumPost({
      id: `nodebb:post:${item.postId}`,
      adapter: 'nodebb',
      containerSelector: `${sourceSelector} [component="post/content"]`,
      postId: item.postId,
      floor: item.floor,
      authorId: item.authorId,
      authorName: item.authorName,
      isOp: Boolean(first) && first.authorId === item.authorId,
      sourceKey: `nodebb:${item.postId}`,
      sourceSelector
      }, item.content, { removeBlockquotes: true });
    });
  }

  async function extractNodebbDocument(document, options) {
    const route = nodebbRoute(document);
    const fetchFn = options && options.fetchFn;
    if (!route || typeof fetchFn !== 'function') {
      return documentResult(document, {
        adapterId: 'nodebb',
        blocks: extractNodebbDom(document),
        complete: false,
        warnings: ['nodebb-current-dom-only']
      });
    }
    const pages = [];
    try {
      const firstResponse = await fetchJson(fetchFn, route.apiUrl, {
        origin: route.url.origin,
        baseUrl: route.apiUrl,
        signal: options.signal
      });
      pages.push(firstResponse.payload);
      const reportedPageCount = Math.max(
        1,
        Number(
          firstResponse.payload &&
          firstResponse.payload.pagination &&
          firstResponse.payload.pagination.pageCount
        ) || 1
      );
      const pageCount = Math.min(MAX_PAGES, reportedPageCount);
      const paginationCapped = reportedPageCount > MAX_PAGES;
      for (let page = 2; page <= pageCount; page += 1) {
        const pageUrl = new URL(route.apiUrl.toString());
        pageUrl.searchParams.set('page', String(page));
        const response = await fetchJson(fetchFn, pageUrl, {
          origin: route.url.origin,
          baseUrl: pageUrl,
          signal: options.signal
        });
        pages.push(response.payload);
      }
      const blocks = parseNodebbTopicPages(pages, options);
      return documentResult(document, {
        adapterId: 'nodebb',
        title: firstResponse.payload.title || (document && document.title),
        blocks,
        complete: !paginationCapped && pages.length === reportedPageCount,
        warnings: paginationCapped || pages.length !== pageCount ? ['nodebb-pagination-limit'] : [],
        stats: {
          fetchedPages: pages.length,
          reportedPages: reportedPageCount,
          extractedPosts: blocks.length
        }
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (pages.length) {
        const blocks = parseNodebbTopicPages(pages, options);
        return documentResult(document, {
          adapterId: 'nodebb',
          blocks,
          complete: false,
          warnings: ['nodebb-api-partial'],
          stats: { fetchedPages: pages.length, extractedPosts: blocks.length }
        });
      }
      return documentResult(document, {
        adapterId: 'nodebb',
        blocks: extractNodebbDom(document),
        complete: false,
        warnings: ['nodebb-api-unavailable']
      });
    }
  }

  function isXenForo(document) {
    if (!document) return false;
    const root = document.documentElement;
    const template = root && root.getAttribute && root.getAttribute('data-template');
    const contentKey = root && root.getAttribute && root.getAttribute('data-content-key');
    if (root && root.id === 'XF') return true;
    if (/^thread_view/u.test(String(template || '')) || /^thread-/u.test(String(contentKey || ''))) return true;
    return typeof document.querySelector === 'function'
      ? Boolean(document.querySelector('.message--post[data-content^="post-"]'))
      : false;
  }

  function extractXenForo(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    const posts = Array.from(document.querySelectorAll('.message--post[data-content^="post-"], article.message--post'));
    const mapped = posts.map((post, index) => {
      const content = post.querySelector && (
        post.querySelector('.message-userContent .message-body .bbWrapper') ||
        post.querySelector('.message-body .bbWrapper') ||
        post.querySelector('.message-body')
      );
      const authorName = clean(post.getAttribute && post.getAttribute('data-author')) || '匿名用户';
      const contentId = String((post.getAttribute && post.getAttribute('data-content')) || post.id || index + 1);
      const postId = contentId.replace(/^(?:post-|js-post-)/u, '');
      const author = forumAuthor('', authorName, `xenforo:${postId}`);
      const floorNode = post.querySelector && post.querySelector(
        '.message-attribution-opposite a[href*="#post-"], ' +
        '.message-attribution-opposite a, ' +
        '.message-attribution-opposite, ' +
        'a.message-attribution-gadget[href*="#post-"]'
      );
      const floorMatch = clean(floorNode && floorNode.textContent).match(/#?(\d+)/u);
      const starterMarker = Boolean(post.querySelector && post.querySelector('.message-threadStarter, .message-userExtras .message-threadStarter, [data-xf-init~="thread-starter"]'));
      return {
        postId,
        floor: floorMatch ? Number(floorMatch[1]) : index + 1,
        floorCertain: Boolean(floorMatch),
        authorId: author.id,
        authorName: author.name,
        authorStable: author.stable,
        starterMarker,
        content
      };
    }).filter((item) => ForumContent.semanticUnitsFromElement(item.content, { removeBlockquotes: true }).length).sort((left, right) => left.floor - right.floor);
    const markedStarter = mapped.find((item) => item.starterMarker);
    const visibleFirst = mapped.find((item) => item.floor === 1);
    const op = markedStarter || visibleFirst;
    return mapped.flatMap((item) => {
      const sourceSelector = `.message--post[data-content="post-${cssString(item.postId)}"], #js-post-${cssString(item.postId)}`;
      return expandForumPost({
      id: `xenforo:post:${item.postId}`,
      adapter: 'xenforo',
      containerSelector: `.message--post[data-content="post-${cssString(item.postId)}"] .message-body .bbWrapper, #js-post-${cssString(item.postId)} .message-body .bbWrapper`,
      postId: item.postId,
      floor: item.floor,
      authorId: item.authorId,
      authorName: item.authorName,
      isOp: Boolean(op) && (
        item.postId === op.postId ||
        Boolean(op.authorStable && item.authorStable && item.authorId === op.authorId)
      ),
      sourceKey: `xenforo:${item.postId}`,
      sourceSelector
      }, item.content, { removeBlockquotes: true });
    });
  }

  function isMirrorCardForum(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return false;
    let hostname = '';
    try {
      hostname = getLocationUrl(document).hostname.toLowerCase();
    } catch (_) {}
    return hostname === 'mirror.chromaso.net' && document.querySelectorAll('.mm-post .card-body').length > 0;
  }

  function extractMirrorCardForum(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    const posts = Array.from(document.querySelectorAll('.mm-post'));
    const mapped = posts.map((post, index) => {
      const content = post.querySelector && post.querySelector('.card-body');
      if (!content) return null;
      const authorNode = post.querySelector && post.querySelector(
        '.card-header a.ui-link[href*="/author/"], .card-header a[href*="/author/"]'
      );
      const authorName = clean(authorNode && authorNode.textContent);
      const authorHref = String(authorNode && authorNode.getAttribute && authorNode.getAttribute('href') || '');
      const authorMatch = authorHref.match(/\/author\/([^/?#]+)/u);
      const rawPostId = String(post.id || `mirror-${index + 1}`);
      const postId = rawPostId.replace(/^p/u, '') || String(index + 1);
      const author = forumAuthor(authorMatch && authorMatch[1], authorName, `mirror:${postId}`);
      const subtitle = post.querySelector && post.querySelector(
        '.card-header .flex-grow-1 > .text-muted, .card-header .text-muted:last-child, .card-header .text-muted'
      );
      return {
        rawPostId,
        postId,
        floor: index + 1,
        author,
        isReply: /^\s*re\s*:/iu.test(clean(subtitle && subtitle.textContent)),
        content
      };
    }).filter(Boolean);
    const op = mapped.find((item) => !item.isReply);
    return mapped.flatMap((item) => {
      const containerSelector = `[id="${cssString(item.rawPostId)}"] .card-body`;
      return expandForumPost({
        id: `mirror-card:post:${item.postId}`,
        adapter: 'mirror-card',
        containerSelector,
        postId: item.postId,
        floor: item.floor,
        authorId: item.author.id,
        authorName: item.author.name,
        isOp: Boolean(op) && item.author.stable && op.author.stable && item.author.id === op.author.id,
        sourceKey: `mirror-card:${item.postId}`,
        sourceSelector: containerSelector
      }, String(item.content.innerHTML || ''), { removeBlockquotes: true });
    });
  }

  function splitArticleText(value) {
    return String(value || '')
      .replace(/\r\n?/gu, '\n')
      .split(/\n+/gu)
      .map(clean)
      .filter(Boolean);
  }

  function extractReadability(document, ReadabilityCtor) {
    const Ctor = ReadabilityCtor || global.Readability;
    if (typeof Ctor !== 'function' || !document || typeof document.cloneNode !== 'function') return null;
    let article;
    try {
      article = new Ctor(document.cloneNode(true), { charThreshold: 200 }).parse();
    } catch (_) {
      return null;
    }
    if (!article) return null;
    const semanticParts = article.content && ForumContent
      ? ForumContent.semanticUnitsFromHtml(article.content, { removeBlockquotes: true }).map((unit) => unit.text)
      : [];
    const parts = semanticParts.length ? semanticParts : splitArticleText(article.textContent);
    if (!parts.length) return null;
    return documentResult(document, {
      adapterId: 'readability',
      title: article.title || (document && document.title),
      blocks: parts.map((part, index) => ({
        id: `readability:${index + 1}`,
        type: 'article',
        text: part,
        floor: index + 1,
        sourceKey: `readability:${fingerprint(part)}`
      }))
    });
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function scoreCandidate(element) {
    const content = elementReadableText(element);
    if (!content) return -Infinity;
    const blockCount = element && typeof element.querySelectorAll === 'function'
      ? element.querySelectorAll('p, li, blockquote').length
      : 0;
    const linkCount = element && typeof element.querySelectorAll === 'function'
      ? element.querySelectorAll('a').length
      : 0;
    return content.length + blockCount * 160 - linkCount * 100;
  }

  function isReadableNode(node) {
    if (!node || node.hidden || (node.getAttribute && node.getAttribute('aria-hidden') === 'true')) return false;
    const ancestor = typeof node.closest === 'function'
      ? node.closest('nav, header, footer, aside, [role="navigation"], .advertisement, .ads, .comments, .toolbar')
      : null;
    return !ancestor;
  }

  function extractGeneric(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    const candidates = Array.from(document.querySelectorAll(
      'article, main, [role="main"], [itemprop="articleBody"], #chaptercontent, #content, .article-content, .article-body, .entry-content, .entry-body, .post-content, .chapter-content, .read-content, .reader-content, .novel-content, .content'
    ));
    const candidate = candidates
      .map((element) => ({ element, score: scoreCandidate(element) }))
      .sort((left, right) => right.score - left.score)[0];
    if (!candidate || candidate.score <= 0) return [];
    const descendants = candidate.element && typeof candidate.element.querySelectorAll === 'function'
      ? Array.from(candidate.element.querySelectorAll('p, li, blockquote, h1, h2, h3, h4'))
      : [];
    const readableBlocks = descendants.length ? descendants : [candidate.element];
    const segments = [];
    readableBlocks.forEach((node) => {
      if (!isReadableNode(node)) return;
      const units = ForumContent
        ? ForumContent.semanticUnitsFromElement(node, { removeBlockquotes: true })
        : [];
      const texts = units.length ? units.map((unit) => unit.text) : [elementReadableText(node)];
      texts.forEach((cleaned) => {
        if (!cleaned || GENERIC_CONTROL_PATTERN.test(cleaned)) return;
        const index = segments.length;
        segments.push(block({
          id: `generic:${index}`,
          type: 'article',
          floor: index + 1,
          text: cleaned,
          sourceKey: `generic:${index}:${fingerprint(cleaned)}`
        }));
      });
    });
    return segments;
  }

  function candidateMetrics(document) {
    const blocks = document && Array.isArray(document.blocks) ? document.blocks : [];
    const texts = blocks.map((entry) => clean(entry && entry.text)).filter(Boolean);
    const totalChars = texts.reduce((sum, value) => sum + value.length, 0);
    const speakableChars = texts.reduce((sum, value) => (
      sum + Array.from(value).filter((character) => /[\p{L}\p{N}]/u.test(character)).length
    ), 0);
    const uniqueBlocks = new Set(texts.map((value) => value.toLocaleLowerCase())).size;
    return {
      blockCount: texts.length,
      totalChars,
      averageChars: texts.length ? totalChars / texts.length : 0,
      speakableRatio: totalChars ? speakableChars / totalChars : 0,
      uniqueRatio: texts.length ? uniqueBlocks / texts.length : 0
    };
  }

  function evaluateCandidate(document, options) {
    const settings = options || {};
    const metrics = candidateMetrics(document);
    if (!metrics.blockCount || !metrics.totalChars) {
      return { score: -Infinity, confidence: 'none', metrics };
    }
    const adapterId = String(document && document.adapterId || settings.adapterId || '');
    const adapterBias = adapterId === 'readability' ? 12 : adapterId === 'generic' ? 2 : 20;
    const shortPenalty = metrics.totalChars < 80 ? (80 - metrics.totalChars) / 4 : 0;
    const duplicatePenalty = (1 - metrics.uniqueRatio) * 24;
    const score = Math.max(0, Math.min(100,
      adapterBias +
      Math.min(36, metrics.totalChars / 70) +
      Math.min(14, Math.sqrt(metrics.blockCount) * 3) +
      Math.min(10, metrics.averageChars / 18) +
      metrics.speakableRatio * 12 +
      metrics.uniqueRatio * 12 -
      shortPenalty -
      duplicatePenalty
    ));
    return {
      score: Math.round(score * 100) / 100,
      confidence: score >= 72 ? 'high' : score >= 48 ? 'medium' : 'low',
      metrics
    };
  }

  function makeCandidate(document, options) {
    if (!document) return null;
    const quality = evaluateCandidate(document, options);
    return {
      id: String(document.adapterId || options && options.id || 'candidate'),
      document,
      score: quality.score,
      confidence: quality.confidence,
      metrics: quality.metrics
    };
  }

  function chooseCandidate(candidates) {
    const viable = (Array.isArray(candidates) ? candidates : [])
      .filter((candidate) => candidate && candidate.document && Number.isFinite(candidate.score));
    if (!viable.length) return null;
    return viable.slice().sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const priority = { readability: 2, generic: 1 };
      return (priority[right.id] || 0) - (priority[left.id] || 0);
    })[0];
  }

  function attachCandidateDiagnostics(selected, candidates, fallbackFrom) {
    if (!selected || !selected.document) return null;
    const result = selected.document;
    result.stats = Object.assign({}, result.stats, {
      fallbackFrom: fallbackFrom || '',
      selectedCandidate: selected.id,
      selectedCandidateScore: selected.score,
      selectedCandidateConfidence: selected.confidence,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.score,
        confidence: candidate.confidence,
        metrics: Object.assign({}, candidate.metrics)
      }))
    });
    return result;
  }

  function selectedText(document, options) {
    if (!options || options.mode !== 'selection') return '';
    if (Object.prototype.hasOwnProperty.call(options || {}, 'selectionText')) {
      return clean(options.selectionText);
    }
    const selection = document && typeof document.getSelection === 'function' ? document.getSelection() : null;
    return selection && !selection.isCollapsed ? clean(selection.toString()) : '';
  }

  function detectAdapter(document) {
    if (isMirrorCardForum(document)) return 'mirror-card';
    if (discourseRoute(document)) return 'discourse';
    if (flarumRoute(document)) return 'flarum';
    if (nodebbRoute(document)) return 'nodebb';
    if (isXenForo(document)) return 'xenforo';
    return '';
  }

  function forumPageIdentity(route, routeType, id) {
    const path = `${route.basePath || ''}/${routeType}/${id}`.replace(/\/{2,}/gu, '/');
    return new URL(path.startsWith('/') ? path : `/${path}`, route.url.origin).toString();
  }

  function pageIdentity(document) {
    const discourse = discourseRoute(document);
    if (discourse) return forumPageIdentity(discourse, 't', discourse.topicId);

    const flarum = flarumRoute(document);
    if (flarum) return forumPageIdentity(flarum, 'd', flarum.discussionId);

    const location = document && document.location ? document.location : document;
    const href = location && (location.href || location);
    if (model && typeof model.makePageKey === 'function') {
      return model.makePageKey(href);
    }
    try {
      const url = new URL(String(href || ''));
      if (!/^#!?\//u.test(url.hash)) url.hash = '';
      return url.toString();
    } catch (_) {
      return String(href || '').replace(/#.*$/u, '');
    }
  }

  async function extractDocument(document, options) {
    const settings = typeof options === 'function' ? { fetchFn: options } : Object.assign({}, options || {});
    const selection = selectedText(document, settings);
    if (selection) {
      return documentResult(document, {
        adapterId: 'selection',
        blocks: [{
          id: 'selection:1',
          type: 'selection',
          text: selection,
          floor: 1,
          sourceKey: 'selection'
        }]
      });
    }

    const adapterId = detectAdapter(document);
    let forumResult = null;
    if (adapterId === 'discourse') forumResult = await extractDiscourseDocument(document, settings);
    if (adapterId === 'flarum') forumResult = await extractFlarumDocument(document, settings);
    if (adapterId === 'nodebb') forumResult = await extractNodebbDocument(document, settings);
    if (adapterId === 'xenforo') {
      forumResult = documentResult(document, {
        adapterId: 'xenforo',
        blocks: extractXenForo(document),
        complete: false,
        warnings: ['xenforo-current-page-only']
      });
    }
    if (adapterId === 'mirror-card') {
      forumResult = documentResult(document, {
        adapterId: 'mirror-card',
        kind: 'forum',
        blocks: extractMirrorCardForum(document),
        complete: false,
        warnings: ['mirror-card-current-page-only']
      });
    }
    if (forumResult && forumResult.blocks.length) return forumResult;
    const fallbackWarnings = forumResult
      ? [...forumResult.warnings, `${adapterId}-empty-fallback`]
      : [];

    if (!adapterId && GenericThreadDetector && typeof GenericThreadDetector.detect === 'function') {
      const detectedThread = GenericThreadDetector.detect(document, settings.genericThreadOptions);
      if (detectedThread) {
        return documentResult(document, {
          adapterId: 'generic-thread',
          kind: 'forum',
          blocks: GenericThreadDetector.toBlocks(detectedThread),
          complete: false,
          warnings: ['generic-thread-heuristic'],
          stats: {
            detectorScore: detectedThread.score,
            detectorConfidence: detectedThread.confidence,
            detectorSelector: detectedThread.selector
          }
        });
      }
    }

    const candidates = [];
    const readable = extractReadability(document, settings.ReadabilityCtor);
    if (readable) candidates.push(makeCandidate(readable));
    const generic = documentResult(document, {
      adapterId: 'generic',
      blocks: extractGeneric(document),
      complete: true,
      warnings: fallbackWarnings
    });
    if (generic.blocks.length) candidates.push(makeCandidate(generic));
    const selected = chooseCandidate(candidates);
    if (selected) {
      selected.document.warnings = Array.from(new Set([
        ...(selected.document.warnings || []),
        ...fallbackWarnings
      ]));
      return attachCandidateDiagnostics(selected, candidates, forumResult ? adapterId : '');
    }
    return generic;
  }

  async function extractPage(document, fetchOrOptions, extraOptions) {
    const options = typeof fetchOrOptions === 'function'
      ? Object.assign({}, extraOptions || {}, { fetchFn: fetchOrOptions })
      : Object.assign({}, fetchOrOptions || {});
    const result = await extractDocument(document, options);
    const blocks = result.blocks.slice();
    Object.defineProperty(blocks, 'documentMeta', {
      configurable: true,
      enumerable: false,
      value: result
    });
    return blocks;
  }

  global.QwenReaderExtractors = Object.freeze({
    detectAdapter,
    pageIdentity,
    extractDocument,
    extractPage,
    parseFlarumApi,
    extractFlarum,
    extractFlarumDom,
    parseDiscourseTopic,
    parseNodebbTopicPages,
    extractXenForo,
    extractMirrorCardForum,
    extractReadability,
    extractGeneric,
    candidateMetrics,
    evaluateCandidate,
    makeCandidate,
    chooseCandidate,
    htmlToReadableText,
    makeFlarumPostsUrl
  });
})(globalThis);
