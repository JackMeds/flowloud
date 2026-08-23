import { useState } from 'react';
import { Button } from 'react-aria-components';
import { ArrowRight, LocateFixed, Pause, Play, Rows3 } from 'lucide-react';

const sections = [
  { id: 'title', label: '主题标题', detail: '为什么几乎所有 AI 客户端都不重视回答朗读呢？' },
  { id: 'op', label: '楼主正文', detail: '3 个段落 · 291 字' },
  { id: 'replies', label: '讨论回复', detail: '42 个回复 · 21 位作者' },
  { id: 'footer', label: '主题信息', detail: '浏览量、点赞与发布时间' },
];

export function PageGuideWorkspace() {
  const [selected, setSelected] = useState('op');
  const [playing, setPlaying] = useState(false);
  const current = sections.find((section) => section.id === selected) ?? sections[0]!;
  return (
    <main className="fl-route-page fl-guide-page" aria-label="页面导览">
      <header className="fl-route-header"><div className="fl-workspace-brand"><img src="/assets/flowloud-32.png" alt="" /><div><strong>页面导览</strong><span>按语义浏览当前网页，不朗读导航与论坛控件。</span></div></div><Button className="fl-primary-button" onPress={() => setPlaying((value) => !value)}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{playing ? '暂停导览' : '开始导览'}</Button></header>
      <div className="fl-guide-layout">
        <nav className="fl-guide-nav" aria-label="页面结构"><div className="fl-guide-nav-heading"><Rows3 aria-hidden="true" /><strong>页面结构</strong><span>{sections.length} 个区域</span></div>{sections.map((section, index) => <Button key={section.id} className={selected === section.id ? 'is-selected' : ''} onPress={() => setSelected(section.id)}><span>{index + 1}</span><div><strong>{section.label}</strong><small>{section.detail}</small></div><ArrowRight aria-hidden="true" /></Button>)}</nav>
        <section className="fl-guide-preview"><p>当前区域</p><h1>{current.label}</h1><span>{current.detail}</span><div className="fl-guide-copy">{selected === 'op' ? '我试了好多 AI 客户端：要么语音机械，要么暂停和倍速不完整。一个可靠的朗读工具应该让语音输入、文本回答和自然朗读顺畅衔接。' : '选择左侧区域后，可定位网页位置并从该区域开始导览。'}</div><div className="fl-guide-actions"><Button className="fl-secondary-button"><LocateFixed aria-hidden="true" />定位到网页</Button><Button className="fl-primary-button" onPress={() => setPlaying(true)}><Play aria-hidden="true" />从此处朗读</Button></div></section>
      </div>
    </main>
  );
}
