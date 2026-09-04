import { Button } from 'react-aria-components';
import {
  CheckCircle2,
  ChevronRight,
  Cloud,
  Cpu,
  Globe2,
  HardDrive,
  Radio,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { ProviderState } from './model';
import { providerRegistry, type ProviderId } from './provider-registry';
import { connectionLabel, providerStatusMessage } from './voice-workbench-model';

const sourceIcons: Record<ProviderId, ComponentType<{ 'aria-hidden'?: boolean }>> = {
  'browser-system': Globe2,
  'browser-model': Cpu,
  'local-service': HardDrive,
  'openai-compatible': Cloud,
  'doubao-tts': Radio,
};

interface VoiceSourceCardsProps {
  activeProviderId: string;
  selectedProvider: ProviderId;
  statuses: ProviderState[];
  onSelect: (providerId: ProviderId) => void;
}

export function VoiceSourceCards({ activeProviderId, selectedProvider, statuses, onSelect }: VoiceSourceCardsProps) {
  return (
    <section id="voice-sources" className="fl-source-section" aria-labelledby="voice-source-heading">
      <header className="fl-section-heading">
        <div>
          <span className="fl-step-label">1</span>
          <div>
            <h2 id="voice-source-heading">选择并配置声音来源</h2>
            <p>五种来源全部显示在这里。点击任意卡片，就能查看它自己的配置和连接状态。</p>
          </div>
        </div>
      </header>

      <div className="fl-source-grid">
        {providerRegistry.map((provider) => {
          const Icon = sourceIcons[provider.id];
          const state = statuses.find((item) => item.providerId === provider.id);
          const selected = selectedProvider === provider.id;
          const current = activeProviderId === provider.id;
          return (
            <Button
              key={provider.id}
              className={`fl-source-card ${selected ? 'is-selected' : ''} ${current ? 'is-current' : ''}`}
              aria-pressed={selected}
              aria-label={`${provider.label}，${current ? '当前正在使用，' : ''}${connectionLabel(state)}。查看配置`}
              onPress={() => onSelect(provider.id)}
            >
              <span className="fl-source-icon"><Icon aria-hidden={true} /></span>
              <span className="fl-source-card-copy">
                <span className="fl-source-card-title">
                  <strong>{provider.shortLabel}</strong>
                  {current ? <em><CheckCircle2 aria-hidden={true} />正在使用</em> : null}
                </span>
                <small>{providerStatusMessage(provider.id, state)}</small>
              </span>
              <span className={`fl-connection-pill is-${state?.connectionState || 'connecting'}`}>
                {connectionLabel(state)}
              </span>
              <ChevronRight className="fl-source-card-arrow" aria-hidden={true} />
            </Button>
          );
        })}
      </div>
    </section>
  );
}
