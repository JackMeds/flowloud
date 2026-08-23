import { useState } from 'react';
import { Button, FileTrigger, Input, Label, TextArea, TextField } from 'react-aria-components';
import { Check, FileAudio, Mic, Plus, Trash2, Upload, Volume2 } from 'lucide-react';

interface VoiceDraft {
  id: string;
  name: string;
  duration: string;
  referenceText: string;
  ready: boolean;
}

const initialDrafts: VoiceDraft[] = [
  { id: 'sample-1', name: '清朗-参考音.wav', duration: '9.8 秒', referenceText: '今天的风很轻，适合慢慢读完这一页。', ready: true },
  { id: 'sample-2', name: '温和男声.wav', duration: '7.2 秒', referenceText: '', ready: false },
];

export function VoiceStudioWorkspace() {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [saved, setSaved] = useState(false);
  const updateDraft = (id: string, patch: Partial<VoiceDraft>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
    setSaved(false);
  };
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const additions = Array.from(files).map((file, index) => ({ id: `${file.name}-${file.lastModified}-${index}`, name: file.name, duration: '待分析', referenceText: '', ready: false }));
    setDrafts((current) => [...current, ...additions]);
    setSaved(false);
  };
  const readyCount = drafts.filter((draft) => draft.ready && draft.referenceText.trim()).length;
  const canSave = drafts.length > 0 && readyCount === drafts.length;

  return (
    <main className="fl-route-page" aria-label="音色工作室">
      <header className="fl-route-header"><div className="fl-workspace-brand"><img src="/assets/flowloud-32.png" alt="" /><div><strong>音色工作室</strong><span>录制或导入 5–15 秒清晰人声，保存在浏览器本地。</span></div></div><div className="fl-route-actions"><Button className="fl-secondary-button"><Mic aria-hidden="true" />开始录音</Button><Button className="fl-primary-button" isDisabled={!canSave} onPress={() => setSaved(true)}><Check aria-hidden="true" />保存全部</Button></div></header>
      <div className="fl-route-body fl-voice-studio-body">
        <section className="fl-import-panel"><div><Upload aria-hidden="true" /><h1>批量导入参考音频</h1><p>支持 WAV、MP3、M4A。每个文件独立分析、转写和保存，失败项不会阻塞其他声音。</p></div><FileTrigger acceptedFileTypes={['audio/*']} allowsMultiple onSelect={addFiles}><Button className="fl-primary-button"><Plus aria-hidden="true" />选择音频文件</Button></FileTrigger></section>
        <div className="fl-batch-heading"><div><strong>待保存声音</strong><span>{drafts.length} 项 · {readyCount} 项就绪</span></div>{saved ? <span className="fl-saved-pill">全部已保存</span> : null}</div>
        <section className="fl-voice-drafts" aria-label="待保存声音">
          {drafts.length ? drafts.map((draft) => <article className="fl-voice-draft" key={draft.id}>
            <div className="fl-draft-file"><span><FileAudio aria-hidden="true" /></span><div><strong>{draft.name}</strong><small>{draft.duration} · 单声道 24 kHz</small></div><span className={draft.ready ? 'fl-draft-state is-ready' : 'fl-draft-state'}>{draft.ready ? '质量合格' : '需要补充'}</span></div>
            <div className="fl-draft-fields"><TextField value={draft.name.replace(/\.[^.]+$/u, '')} onChange={(value) => updateDraft(draft.id, { name: `${value}.wav` })}><Label>声音名称</Label><Input /></TextField><TextField value={draft.referenceText} onChange={(value) => updateDraft(draft.id, { referenceText: value, ready: value.trim().length >= 6 })}><Label>参考文本</Label><TextArea placeholder="输入或核对这段音频对应的文字" /></TextField></div>
            <div className="fl-draft-actions"><Button className="fl-secondary-button"><Volume2 aria-hidden="true" />试听</Button><Button className="fl-secondary-button" onPress={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2 aria-hidden="true" />移除</Button></div>
          </article>) : <div className="fl-empty-studio"><FileAudio aria-hidden="true" /><strong>还没有待处理的音频</strong><span>选择文件或录制一段声音后，会在这里进行检查。</span></div>}
        </section>
      </div>
    </main>
  );
}
