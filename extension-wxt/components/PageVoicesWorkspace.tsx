import { useState } from 'react';
import { Button } from 'react-aria-components';
import { Check, RotateCcw, Users, Volume2 } from 'lucide-react';
import { ChoiceSelect } from './FormControls';

const voiceOptions = [
  ['auto', '跟随全局设置'],
  ['shaosimeng', '邵思萌'],
  ['yunxi', '云希'],
  ['qinglang', '清朗'],
] as const;

const initialAuthors = [
  { id: 'op', name: 'Filmcuratop2025', meta: '楼主 · 6 个楼层', voice: 'shaosimeng' },
  { id: 'yqyan', name: 'yqyan', meta: '回复者 · 1 个楼层', voice: 'qinglang' },
  { id: 'a-zhao', name: 'A_zhao', meta: '回复者 · 1 个楼层', voice: 'auto' },
];

export function PageVoicesWorkspace() {
  const [authors, setAuthors] = useState(initialAuthors);
  const [saved, setSaved] = useState(false);
  const setVoice = (id: string, voice: string) => {
    setAuthors((current) => current.map((author) => author.id === id ? { ...author, voice } : author));
    setSaved(false);
  };
  return (
    <main className="fl-route-page" aria-label="本页配音">
      <header className="fl-route-header"><div className="fl-workspace-brand"><img src="/assets/flowloud-32.png" alt="" /><div><strong>本页配音</strong><span>为什么几乎所有 AI 客户端都不重视回答朗读呢？</span></div></div><div className="fl-route-actions"><Button className="fl-secondary-button" onPress={() => { setAuthors(initialAuthors); setSaved(false); }}><RotateCcw aria-hidden="true" />恢复默认</Button><Button className="fl-primary-button" onPress={() => setSaved(true)}><Check aria-hidden="true" />应用到本页</Button></div></header>
      <div className="fl-route-body">
        <section className="fl-summary-card"><Users aria-hidden="true" /><div><strong>3 位作者</strong><span>楼主保持固定声音，其他作者可以单独选择；设置只作用于当前主题。</span></div>{saved ? <span className="fl-saved-pill">已应用</span> : <span className="fl-saved-pill is-pending">待应用</span>}</section>
        <section className="fl-author-table" aria-label="作者声音分配">
          <div className="fl-table-heading"><span>作者</span><span>页面角色</span><span>声音</span><span>试听</span></div>
          {authors.map((author, index) => <div className="fl-author-row" key={author.id}><div className="fl-author-identity"><span>{index + 1}</span><strong>{author.name}</strong></div><span>{author.meta}</span><ChoiceSelect label={`${author.name} 的声音`} value={author.voice} options={voiceOptions} onChange={(value) => setVoice(author.id, value)} /><Button className="fl-icon-button" aria-label={`试听 ${author.name} 的声音`}><Volume2 aria-hidden="true" /></Button></div>)}
        </section>
      </div>
    </main>
  );
}
