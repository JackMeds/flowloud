(function semanticGuideModule(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudSemanticGuide = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeSemanticGuide() {
  'use strict';
  const SELECTOR = 'main,nav,header,footer,aside,section,article,h1,h2,h3,h4,h5,h6,p,ul,ol,table,a[href],button,input,select,textarea,img[alt]';
  function text(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
  function visible(element, view) {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = view?.getComputedStyle ? view.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
    const rect = element.getBoundingClientRect?.();
    return !rect || rect.width > 0 || rect.height > 0;
  }
  function accessibleName(element) {
    if (!element) return '';
    const labelledBy = text(element.getAttribute?.('aria-labelledby'));
    const referenced = labelledBy && element.ownerDocument?.getElementById
      ? labelledBy.split(' ').map((id) => text(element.ownerDocument.getElementById(id)?.textContent)).filter(Boolean).join(' ')
      : '';
    return text(element.getAttribute?.('aria-label') || referenced || element.getAttribute?.('alt') || element.getAttribute?.('title') ||
      (element.labels && Array.from(element.labels).map((label) => label.textContent).join(' ')) || element.textContent || element.value);
  }
  function typeOf(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (['main', 'nav', 'header', 'footer', 'aside', 'section', 'article'].includes(tag)) return 'landmark';
    if (tag === 'a') return 'link'; if (tag === 'button') return 'button';
    if (['input', 'select', 'textarea'].includes(tag)) return 'form'; if (tag === 'img') return 'image';
    if (['ul', 'ol'].includes(tag)) return 'list'; if (tag === 'table') return 'table'; return 'paragraph';
  }
  function describe(element, type) {
    if (type === 'table') {
      const rows = element.rows?.length || element.querySelectorAll('tr').length; const columns = element.rows?.[0]?.cells?.length || 0;
      return `${accessibleName(element.querySelector('caption')) || '表格'}，${rows} 行 ${columns} 列`;
    }
    if (type === 'list') return `${accessibleName(element).slice(0, 220)}，共 ${element.children.length} 项`;
    if (type === 'form') {
      const state = element.disabled ? '，已禁用' : element.required ? '，必填' : '';
      const controlType = text(element.type || element.tagName).toLowerCase();
      return `${accessibleName(element) || `未命名${controlType === 'checkbox' ? '复选框' : controlType === 'radio' ? '单选按钮' : '输入框'}`}${state}`;
    }
    const name = accessibleName(element);
    if (name) return name;
    if (type === 'button') return '未命名按钮';
    if (type === 'link') return '未命名链接';
    if (type === 'landmark') return '未命名区域';
    return name;
  }
  function buildSnapshot(document, options) {
    const view = document.defaultView; const filter = text(options?.filter || 'all'); const nodes = []; const elements = new Map();
    Array.from(document.querySelectorAll(SELECTOR)).forEach((element) => {
      if (element.closest('[id^="qwen-reader"], .qwen-reader-ui, script, style, noscript, [aria-hidden="true"]')) return;
      if (!visible(element, view)) return;
      const type = typeOf(element); if (filter !== 'all' && type !== filter) return;
      const label = describe(element, type); if (!label) return;
      if (['landmark', 'paragraph'].includes(type) && element.querySelector(SELECTOR) && text(element.childNodes?.[0]?.textContent).length < 2) return;
      const id = `guide-${nodes.length + 1}`; const level = type === 'heading' ? Number(element.tagName.slice(1)) : undefined;
      const item = { id, type, label: label.slice(0, 500), level, role: element.getAttribute('role') || '', checked: element.checked === true ? true : element.checked === false && ['checkbox', 'radio'].includes(element.type) ? false : undefined,
        expanded: element.hasAttribute('aria-expanded') ? element.getAttribute('aria-expanded') === 'true' : undefined };
      nodes.push(item); elements.set(id, element);
    });
    return { title: text(document.title) || text(document.querySelector('h1')?.textContent) || '未命名页面', url: document.location?.href || '', nodes, elements };
  }
  return Object.freeze({ SELECTOR, visible, accessibleName, typeOf, describe, buildSnapshot });
}));
