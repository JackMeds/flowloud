(function pageGuideController() {
  'use strict';
  const params = new URLSearchParams(location.search); const tabId = Number(params.get('tabId')); const outline = document.getElementById('outline');
  const filter = document.getElementById('filter'); let nodes = []; let index = 0;
  async function message(type, payload) { const result = await chrome.runtime.sendMessage(Object.assign({ type, tabId }, payload)); if (!result?.ok) throw new Error(result?.error?.message || '无法读取页面。'); return result; }
  function render() { outline.replaceChildren(); nodes.forEach((node, itemIndex) => { const li = document.createElement('li'); li.className = itemIndex === index ? 'is-current' : ''; const button = document.createElement('button'); button.type = 'button'; button.textContent = `${node.type}${node.level ? ` ${node.level}` : ''}：${node.label}`; button.addEventListener('click', () => select(itemIndex)); li.append(button); outline.append(li); }); if (!nodes.length) outline.textContent = '没有找到符合条件的可见语义内容。'; }
  async function load() { const result = await message('guide:snapshot', { filter: filter.value }); nodes = result.snapshot.nodes; index = Math.min(index, Math.max(0, nodes.length - 1)); document.getElementById('page-title').textContent = result.snapshot.title; render(); }
  async function select(next) { if (!nodes.length) return; index = (next + nodes.length) % nodes.length; render(); outline.children[index]?.scrollIntoView({ block: 'nearest' }); await message('guide:focus', { id: nodes[index].id }); }
  document.getElementById('previous').onclick = () => select(index - 1); document.getElementById('next').onclick = () => select(index + 1);
  document.getElementById('read').onclick = () => { if (nodes[index]) speechSynthesis.speak(new SpeechSynthesisUtterance(nodes[index].label)); };
  document.getElementById('refresh').onclick = load; filter.onchange = load; void load().catch((error) => { outline.textContent = error.message; });
}());
