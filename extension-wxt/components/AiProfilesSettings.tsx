import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { Check, CloudCog, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { aiProfilePresets, profileFromPreset, type AiProfile } from './document-model';
import { createRuntimeBridge } from './runtime-bridge';

type SecretState = Record<string, { present?: boolean; remembered?: boolean }>;

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AiProfilesSettings() {
  const [bridge] = useState(() => createRuntimeBridge());
  const [rawSettings, setRawSettings] = useState<Record<string, unknown>>({});
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [ocrProfileId, setOcrProfileId] = useState('');
  const [translationProfileId, setTranslationProfileId] = useState('');
  const [presetId, setPresetId] = useState('ollama');
  const [secret, setSecret] = useState('');
  const [secrets, setSecrets] = useState<SecretState>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    if (!bridge.available) return undefined;
    void Promise.all([bridge.send({ type: 'settings:get' }), bridge.secretStatus()]).then(([response, secretStatus]) => {
      if (disposed) return;
      const raw = response.settings || {};
      const nextProfiles = Array.isArray(raw.aiProfiles) ? raw.aiProfiles as unknown as AiProfile[] : [];
      const selections = raw.aiProfileSelections && typeof raw.aiProfileSelections === 'object'
        ? raw.aiProfileSelections as Record<string, unknown> : {};
      setRawSettings(raw);
      setProfiles(nextProfiles);
      setSelectedId(nextProfiles[0]?.id || '');
      setOcrProfileId(String(selections.ocr || ''));
      setTranslationProfileId(String(selections.translation || ''));
      setSecrets(secretStatus);
    }).catch((error) => setStatus(messageFrom(error)));
    return () => { disposed = true; };
  }, [bridge]);

  const selected = profiles.find((profile) => profile.id === selectedId) || null;

  const updateSelected = (patch: Partial<AiProfile>) => {
    setProfiles((current) => current.map((profile) => profile.id === selectedId ? { ...profile, ...patch } : profile));
  };

  const save = async (test = false) => {
    if (!selected) return;
    setBusy(true); setStatus(test ? '正在保存并检查连接…' : '正在保存…');
    try {
      const granted = await bridge.requestAiOrigin(selected.baseUrl);
      if (!granted) throw new Error('没有获得该服务的精确 Origin 权限。');
      const nextSettings = { ...rawSettings, aiProfiles: profiles, aiProfileSelections: { ocr: ocrProfileId, translation: translationProfileId } };
      const response = await bridge.saveSettings(nextSettings);
      const saved = response.settings || nextSettings;
      setRawSettings(saved);
      if (secret) {
        await bridge.saveAiSecret(selected.id, secret, selected.rememberSecret);
        setSecret('');
      }
      setSecrets(await bridge.secretStatus());
      if (test) {
        const probe = await bridge.probeAiProfile(selected.id);
        const result = probe.result || {};
        setStatus(`连接检查完成 · ${String(result.note || (result.ready === false ? '服务未就绪' : '配置可用'))}`);
      } else setStatus('AI Profile 已保存。');
    } catch (error) { setStatus(messageFrom(error)); }
    finally { setBusy(false); }
  };

  const addProfile = () => {
    const next = profileFromPreset(presetId, profiles.map((profile) => profile.id));
    setProfiles((current) => [...current, next]);
    setSelectedId(next.id);
    if (!ocrProfileId && next.capabilities.visionOcr) setOcrProfileId(next.id);
    if (!translationProfileId && next.capabilities.textTranslation) setTranslationProfileId(next.id);
    setStatus('已创建草稿，请填写模型后保存。');
  };

  const deleteSelected = async () => {
    if (!selected || !window.confirm(`删除 AI Profile“${selected.label}”？`)) return;
    const next = profiles.filter((profile) => profile.id !== selected.id);
    const nextOcr = ocrProfileId === selected.id ? '' : ocrProfileId;
    const nextTranslation = translationProfileId === selected.id ? '' : translationProfileId;
    const nextSettings = { ...rawSettings, aiProfiles: next, aiProfileSelections: { ocr: nextOcr, translation: nextTranslation } };
    setBusy(true);
    try {
      await bridge.saveAiSecret(selected.id, '', false);
      const response = await bridge.saveSettings(nextSettings);
      setRawSettings(response.settings || nextSettings); setProfiles(next); setSelectedId(next[0]?.id || '');
      setOcrProfileId(nextOcr); setTranslationProfileId(nextTranslation); setSecrets(await bridge.secretStatus()); setStatus('AI Profile 已删除。');
    } catch (error) { setStatus(messageFrom(error)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fl-settings-stack">
      <section className="fl-settings-card">
        <div className="fl-card-heading"><Plus aria-hidden="true" /><div><h2>添加服务配置</h2><p>厂商预设只负责填写协议和地址，模型名称与密钥始终由你控制。</p></div></div>
        <div className="fl-settings-form-grid">
          <label><span>预设</span><select value={presetId} onChange={(event) => setPresetId(event.target.value)}>{Object.entries(aiProfilePresets).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></label>
          <label><span>已配置 Profile</span><select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setSecret(''); }}>{profiles.length ? profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>) : <option value="">尚未配置</option>}</select></label>
        </div>
        <Button className="fl-secondary-button" onPress={addProfile}><Plus aria-hidden="true" />从预设创建</Button>
      </section>

      {selected ? <section className="fl-settings-card">
        <div className="fl-card-heading"><CloudCog aria-hidden="true" /><div><h2>{selected.label}</h2><p>{selected.protocol} · Profile ID：{selected.id}</p></div></div>
        <div className="fl-settings-form-grid">
          <label><span>名称</span><input value={selected.label} onChange={(event) => updateSelected({ label: event.target.value })} /></label>
          <label><span>协议</span><select value={selected.protocol} onChange={(event) => updateSelected({ protocol: event.target.value as AiProfile['protocol'] })}><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="ollama-chat">Ollama Chat</option><option value="flowloud-document-v1">Flowloud Document V1</option></select></label>
          <label className="is-wide"><span>Base URL</span><input value={selected.baseUrl} onChange={(event) => updateSelected({ baseUrl: event.target.value })} /></label>
          <label><span>模型</span><input value={selected.model} onChange={(event) => updateSelected({ model: event.target.value })} placeholder="例如 qwen-vl / gpt-4.1-mini" /></label>
          <label><span>超时（秒）</span><input type="number" min="5" max="600" value={Math.round(selected.timeoutMs / 1000)} onChange={(event) => updateSelected({ timeoutMs: Math.max(5, Number(event.target.value) || 120) * 1000 })} /></label>
          <label><span>鉴权 Header</span><input value={selected.authHeader} onChange={(event) => updateSelected({ authHeader: event.target.value })} placeholder="Authorization" /></label>
          <label><span>鉴权前缀</span><input value={selected.authScheme} onChange={(event) => updateSelected({ authScheme: event.target.value })} placeholder="Bearer" /></label>
          <label className="is-wide"><span>额外请求 Header（JSON，不得填写密钥）</span><textarea key={`${selected.id}-headers`} defaultValue={JSON.stringify(selected.customHeaders || {}, null, 2)} onBlur={(event) => {
            try { const parsed = JSON.parse(event.target.value || '{}'); updateSelected({ customHeaders: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {} }); }
            catch { setStatus('额外 Header 必须是 JSON 对象；鉴权信息请使用上方密钥字段。'); }
          }} /></label>
          <label className="is-wide"><span>API Key / Token</span><input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={secrets[`ai:${selected.id}`]?.present ? '已保存；留空保持不变' : selected.protocol === 'ollama-chat' ? '本机 Ollama 通常留空' : '填写服务密钥'} /></label>
        </div>
        <div className="fl-capability-checks" aria-label="能力声明">
          <label><input type="checkbox" checked={selected.capabilities.visionOcr} onChange={(event) => updateSelected({ capabilities: { ...selected.capabilities, visionOcr: event.target.checked } })} />视觉 OCR</label>
          <label><input type="checkbox" checked={selected.capabilities.textTranslation} onChange={(event) => updateSelected({ capabilities: { ...selected.capabilities, textTranslation: event.target.checked } })} />文本翻译</label>
          <label><input type="checkbox" checked={selected.capabilities.structuredOutput} onChange={(event) => updateSelected({ capabilities: { ...selected.capabilities, structuredOutput: event.target.checked } })} />结构化输出</label>
          <label><input type="checkbox" checked={selected.rememberSecret} onChange={(event) => updateSelected({ rememberSecret: event.target.checked })} />跨会话记住密钥</label>
        </div>
        <div className="fl-settings-form-grid fl-profile-routing">
          <label><span>OCR 使用</span><select value={ocrProfileId} onChange={(event) => setOcrProfileId(event.target.value)}><option value="">未选择</option>{profiles.filter((profile) => profile.capabilities.visionOcr).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
          <label><span>翻译使用</span><select value={translationProfileId} onChange={(event) => setTranslationProfileId(event.target.value)}><option value="">未选择</option>{profiles.filter((profile) => profile.capabilities.textTranslation).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
        </div>
        <div className="fl-inline-note"><ShieldCheck aria-hidden="true" /><strong>{secrets[`ai:${selected.id}`]?.remembered ? '密钥已保存在本机扩展存储' : secrets[`ai:${selected.id}`]?.present ? '密钥仅在当前浏览器会话可用' : '密钥尚未保存'}</strong><span>设置导出、日志和诊断报告均不会包含密钥、正文或图片。</span></div>
        <div className="fl-operation-row"><span role="status" aria-live="polite">{status}</span><div><Button isDisabled={busy} className="fl-primary-button" onPress={() => save(true)}><Check aria-hidden="true" />保存并检查</Button><Button isDisabled={busy} className="fl-secondary-button" onPress={() => save(false)}><Save aria-hidden="true" />保存</Button><Button isDisabled={busy} className="fl-danger-button" onPress={deleteSelected}><Trash2 aria-hidden="true" />删除</Button></div></div>
      </section> : null}
    </div>
  );
}
