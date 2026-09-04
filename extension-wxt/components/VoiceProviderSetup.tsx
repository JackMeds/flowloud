import { Button } from 'react-aria-components';
import {
  Check,
  CircleAlert,
  Cpu,
  Download,
  KeyRound,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ModelDownloadState, ProviderState } from './model';
import { providerRegistry, type ProviderId } from './provider-registry';
import {
  bytesLabel,
  canActivateProvider,
  connectionLabel,
  providerStatusMessage,
  type ProviderConfig,
} from './voice-workbench-model';

interface SecretStatus {
  present?: boolean;
  remembered?: boolean;
}

interface VoiceProviderSetupProps {
  selectedProvider: ProviderId;
  activeProviderId: string;
  status?: ProviderState;
  modelState?: ModelDownloadState;
  config: ProviderConfig;
  secret: string;
  secretStatus?: SecretStatus;
  installMode: 'full' | 'custom';
  downloadQueueSize: number;
  modelVoiceCount: number;
  cachedModelVoiceCount: number;
  remainingVoiceBytes: number;
  busy: boolean;
  studioOpen: boolean;
  onConfigChange: (patch: ProviderConfig) => void;
  onSecretChange: (value: string) => void;
  onInstallModeChange: (mode: 'full' | 'custom') => void;
  onSave: () => void;
  onConnect: () => void;
  onActivate: () => void;
  onInstallModel: () => void;
  onValidateModel: () => void;
  onDownloadQueue: () => void;
  onDownloadAll: () => void;
  onRepairAll: () => void;
  onDeleteAll: () => void;
  onStudioToggle: () => void;
}

const audioFormats = [
  ['wav', 'WAV'],
  ['mp3', 'MP3'],
  ['opus', 'Opus'],
  ['aac', 'AAC'],
] as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="fl-provider-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function RememberSecret({
  checked,
  status,
  noun,
  onChange,
}: {
  checked: boolean;
  status?: SecretStatus;
  noun: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="fl-secret-choice">
      <label>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span><strong>在这台浏览器中长期保存{noun}</strong><small>关闭时只保留到本次浏览器会话结束，下次需要重新粘贴。</small></span>
      </label>
      <span className={status?.present ? 'is-present' : 'is-missing'}>
        <KeyRound aria-hidden={true} />
        {status?.present ? status.remembered ? `${noun}已长期保存` : `${noun}仅本次会话有效` : `尚未保存${noun}`}
      </span>
    </div>
  );
}

export function VoiceProviderSetup(props: VoiceProviderSetupProps) {
  const {
    selectedProvider,
    activeProviderId,
    status,
    modelState,
    config,
    secret,
    secretStatus,
    installMode,
    downloadQueueSize,
    modelVoiceCount,
    cachedModelVoiceCount,
    remainingVoiceBytes,
    busy,
    studioOpen,
    onConfigChange,
    onSecretChange,
    onInstallModeChange,
    onSave,
    onConnect,
    onActivate,
    onInstallModel,
    onValidateModel,
    onDownloadQueue,
    onDownloadAll,
    onRepairAll,
    onDeleteAll,
    onStudioToggle,
  } = props;
  const provider = providerRegistry.find((item) => item.id === selectedProvider)!;
  const active = activeProviderId === selectedProvider;
  const canActivate = canActivateProvider(selectedProvider, status, modelState);

  const actions = selectedProvider === 'browser-system' ? (
    <Button className="fl-primary-button" isDisabled={busy || active} onPress={onActivate}>
      <Check aria-hidden={true} />{active ? '当前正在使用' : '设为当前来源'}
    </Button>
  ) : selectedProvider === 'browser-model' ? (
    <>
      <Button
        className="fl-primary-button"
        isDisabled={busy || (modelState?.ready === true && !downloadQueueSize && !remainingVoiceBytes)}
        onPress={modelState?.ready ? downloadQueueSize ? onDownloadQueue : onDownloadAll : onInstallModel}
      >
        <Download aria-hidden={true} />
        {modelState?.ready
          ? downloadQueueSize ? `下载队列（${downloadQueueSize}）` : remainingVoiceBytes ? '补齐全部音色' : '音色已全部下载'
          : installMode === 'full' ? '安装模型与全部音色' : `安装模型与所选音色（${downloadQueueSize}）`}
      </Button>
      <Button className="fl-secondary-button" isDisabled={busy || modelState?.cached !== true} onPress={onValidateModel}><RefreshCcw aria-hidden={true} />验证模型</Button>
      <Button className="fl-secondary-button" isDisabled={busy || active || !canActivate} onPress={onActivate}>
        <Check aria-hidden={true} />{active ? '当前正在使用' : '设为当前来源'}
      </Button>
      <Button className="fl-text-button" isDisabled={busy || modelState?.ready !== true} onPress={onRepairAll}>修复全部音色缓存</Button>
      <Button className="fl-text-button is-danger" isDisabled={busy || !cachedModelVoiceCount} onPress={onDeleteAll}>删除全部音色缓存</Button>
    </>
  ) : (
    <>
      <Button className="fl-primary-button" isDisabled={busy} onPress={onConnect}>
        <RefreshCcw aria-hidden={true} />保存并连接
      </Button>
      <Button className="fl-secondary-button" isDisabled={busy} onPress={onSave}>
        <Check aria-hidden={true} />仅保存
      </Button>
      <Button className="fl-secondary-button" isDisabled={busy || active || !canActivate} onPress={onActivate}>
        <Volume2 aria-hidden={true} />{active ? '当前正在使用' : '设为当前来源'}
      </Button>
    </>
  );

  return (
    <section id="voice-source" className="fl-source-setup" aria-labelledby="selected-source-heading">
      <header className="fl-source-setup-heading">
        <div>
          <span className="fl-source-setup-icon"><Settings2 aria-hidden={true} /></span>
          <span>
            <small>正在配置</small>
            <h3 id="selected-source-heading">{provider.label}</h3>
            <p>{provider.description}</p>
          </span>
        </div>
        <span className={`fl-connection-pill is-${status?.connectionState || 'connecting'}`}>{connectionLabel(status)}</span>
      </header>

      <div className={`fl-source-health is-${status?.connectionState || 'connecting'}`} role="status">
        {status?.connectionState === 'connected' ? <ShieldCheck aria-hidden={true} /> : <CircleAlert aria-hidden={true} />}
        <span><strong>{active ? '当前朗读正在使用这个来源' : connectionLabel(status)}</strong><small>{providerStatusMessage(selectedProvider, status)}</small></span>
      </div>

      {selectedProvider === 'browser-system' ? (
        <div className="fl-provider-zero-config">
          <Volume2 aria-hidden={true} />
          <div><strong>无需配置</strong><p>直接从下方声音目录选择 Windows 或浏览器提供的声音。系统声音列表会随操作系统变化。</p></div>
        </div>
      ) : null}

      {selectedProvider === 'browser-model' ? (
        <div className="fl-provider-config-grid">
          <Field label="模型来源" hint="魔搭社区是默认来源；Hugging Face 仅作为手动备用。">
            <select value={String(config.source || 'modelscope')} onChange={(event) => onConfigChange({ source: event.target.value })}>
              <option value="modelscope">魔搭社区（推荐）</option>
              <option value="huggingface">Hugging Face（备用）</option>
            </select>
          </Field>
          <Field label="运行设备" hint="WASM 兼容性最好；WebGPU 仍是实验选项。">
            <select value={String(config.device || 'wasm')} onChange={(event) => onConfigChange({ device: event.target.value })}>
              <option value="wasm">WASM（推荐）</option>
              <option value="webgpu">WebGPU（实验）</option>
            </select>
          </Field>
          <Field label="并行下载" hint="网络不稳定时可降低并发。">
            <select value={String(config.downloadConcurrency || 4)} onChange={(event) => onConfigChange({ downloadConcurrency: Number(event.target.value) })}>
              {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} 个文件</option>)}
            </select>
          </Field>
          <fieldset className="fl-model-install-mode">
            <legend>安装范围</legend>
            <label><input type="radio" checked={installMode === 'full'} onChange={() => onInstallModeChange('full')} /><span><strong>完整安装</strong><small>主模型与 {modelVoiceCount || 103} 个音色一次备齐</small></span></label>
            <label><input type="radio" checked={installMode === 'custom'} onChange={() => onInstallModeChange('custom')} /><span><strong>自定义安装</strong><small>只安装下方加入下载队列的 {downloadQueueSize} 个音色</small></span></label>
          </fieldset>
          <div className="fl-model-storage-summary">
            <Cpu aria-hidden={true} />
            <span>
              <strong>{modelState?.ready ? '模型已就绪' : '模型尚未安装或验证'}</strong>
              <small>{cachedModelVoiceCount}/{modelVoiceCount || 103} 个音色已下载{remainingVoiceBytes ? ` · 剩余约 ${bytesLabel(remainingVoiceBytes)}` : ''}</small>
            </span>
          </div>
        </div>
      ) : null}

      {selectedProvider === 'local-service' ? (
        <>
          <ol className="fl-local-reconnect-guide" aria-label="重新连接本地 TTS 的步骤">
            <li><span>1</span><div><strong>确认托盘网关正在运行</strong><small>默认地址固定为 http://127.0.0.1:7811；发布包不包含网关和模型。</small></div></li>
            <li><span>2</span><div><strong>从托盘复制配对令牌</strong><small>打开 QwenTrayGateway 托盘菜单，点击“复制扩展配对令牌”。</small></div></li>
            <li><span>3</span><div><strong>粘贴后点击“保存并连接”</strong><small>连接会依次检查网关、声音列表并合成一条短句。</small></div></li>
          </ol>
          <div className="fl-provider-config-grid">
            <Field label="本地适配器">
              <select value={String(config.adapterId || 'flowloud-qwen')} onChange={(event) => onConfigChange({ adapterId: event.target.value })}>
                <option value="flowloud-qwen">Flowloud Qwen（托盘网关）</option>
                <option value="gpt-sovits">GPT-SoVITS</option>
                <option value="cosyvoice">CosyVoice</option>
                <option value="openai-local">OpenAI 本地兼容</option>
              </select>
            </Field>
            <Field label="Base URL" hint="只允许 localhost、127.0.0.1 或 ::1。">
              <input value={String(config.baseUrl || 'http://127.0.0.1:7811')} onChange={(event) => onConfigChange({ baseUrl: event.target.value })} />
            </Field>
            <Field label="模型" hint="Flowloud 网关默认使用 qwen3-tts-0.6b-q4。">
              <input value={String(config.model || 'qwen3-tts-0.6b-q4')} onChange={(event) => onConfigChange({ model: event.target.value })} />
            </Field>
            <Field label="音频格式">
              <select value={String(config.responseFormat || 'wav')} onChange={(event) => onConfigChange({ responseFormat: event.target.value })}>
                {audioFormats.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="扩展配对令牌" hint="令牌只用于本机回环网关，不会出现在设置导出中。">
              <input type="password" autoComplete="new-password" value={secret} onChange={(event) => onSecretChange(event.target.value)} placeholder={config.rememberToken === true && secretStatus?.present && secretStatus.remembered !== true ? '请重新粘贴令牌，以改为长期保存' : secretStatus?.present ? '已保存；留空保持不变' : '从 QwenTrayGateway 托盘菜单复制'} />
            </Field>
          </div>
          <RememberSecret checked={config.rememberToken === true} status={secretStatus} noun="配对令牌" onChange={(checked) => onConfigChange({ rememberToken: checked })} />
          <Button className="fl-studio-button" onPress={onStudioToggle}>
            <Volume2 aria-hidden={true} />{studioOpen ? '收起声音创建工作台' : '创建或导入本地音色'}
          </Button>
        </>
      ) : null}

      {selectedProvider === 'openai-compatible' ? (
        <>
          <div className="fl-provider-config-grid">
            <Field label="Base URL" hint="远程服务必须使用 HTTPS。"><input value={String(config.baseUrl || '')} onChange={(event) => onConfigChange({ baseUrl: event.target.value })} placeholder="https://api.example.com" /></Field>
            <Field label="模型"><input value={String(config.model || '')} onChange={(event) => onConfigChange({ model: event.target.value })} placeholder="tts-1" /></Field>
            <Field label="音色 ID" hint="多个 ID 用逗号分隔，保存后会出现在声音目录中。"><input value={(Array.isArray(config.voiceIds) ? config.voiceIds : ['alloy']).join(', ')} onChange={(event) => onConfigChange({ voiceIds: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></Field>
            <Field label="音频格式"><select value={String(config.responseFormat || 'mp3')} onChange={(event) => onConfigChange({ responseFormat: event.target.value })}>{audioFormats.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
            <Field label="API Key"><input type="password" autoComplete="new-password" value={secret} onChange={(event) => onSecretChange(event.target.value)} placeholder={secretStatus?.present ? '已保存；留空保持不变' : '必填'} /></Field>
          </div>
          <RememberSecret checked={config.rememberKey === true} status={secretStatus} noun="API Key" onChange={(checked) => onConfigChange({ rememberKey: checked })} />
        </>
      ) : null}

      {selectedProvider === 'doubao-tts' ? (
        <>
          <div className="fl-provider-config-grid">
            <Field label="Base URL"><input value={String(config.baseUrl || 'https://openspeech.bytedance.com')} onChange={(event) => onConfigChange({ baseUrl: event.target.value })} /></Field>
            <Field label="App ID"><input value={String(config.appId || '')} onChange={(event) => onConfigChange({ appId: event.target.value })} /></Field>
            <Field label="Resource ID"><input value={String(config.resourceId || 'seed-tts-2.0')} onChange={(event) => onConfigChange({ resourceId: event.target.value })} /></Field>
            <Field label="音色 ID" hint="多个 ID 用逗号分隔。"><input value={(Array.isArray(config.voiceIds) ? config.voiceIds : []).join(', ')} onChange={(event) => onConfigChange({ voiceIds: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></Field>
            <Field label="API Key"><input type="password" autoComplete="new-password" value={secret} onChange={(event) => onSecretChange(event.target.value)} placeholder={secretStatus?.present ? '已保存；留空保持不变' : '必填'} /></Field>
          </div>
          <RememberSecret checked={config.rememberKey === true} status={secretStatus} noun="API Key" onChange={(checked) => onConfigChange({ rememberKey: checked })} />
        </>
      ) : null}

      <footer className="fl-source-actions">{actions}</footer>
    </section>
  );
}
