import { Shuffle, UserRound, UsersRound, Workflow } from 'lucide-react';
import type { ComponentType } from 'react';
import type { VoicePreset } from './voice-workbench-model';

const strategies: Array<{
  id: VoicePreset;
  label: string;
  description: string;
  icon: ComponentType<{ 'aria-hidden'?: boolean }>;
}> = [
  {
    id: 'everyone-one',
    label: '所有内容使用默认旁白',
    description: '文章、楼主和回复都使用同一个声音，最稳定。',
    icon: UserRound,
  },
  {
    id: 'op-plus-one',
    label: '楼主独立，回复共用一个声音',
    description: '回复使用声音池中的第一个声音。',
    icon: UsersRound,
  },
  {
    id: 'op-stable-random',
    label: '每位作者固定一个声音',
    description: '从声音池稳定分配，同一作者始终保持同一声音。',
    icon: Shuffle,
  },
  {
    id: 'op-round-robin',
    label: '按楼层轮换声音',
    description: '每个回复楼层按声音池顺序轮换。',
    icon: Workflow,
  },
];

interface VoiceStrategyPanelProps {
  preset: VoicePreset;
  narratorLabel: string;
  poolSize: number;
  onChange: (preset: VoicePreset) => void;
}

export function VoiceStrategyPanel({ preset, narratorLabel, poolSize, onChange }: VoiceStrategyPanelProps) {
  return (
    <section id="voice-strategy" className="fl-strategy-section" aria-labelledby="voice-strategy-heading">
      <header className="fl-section-heading">
        <div>
          <span className="fl-step-label">2</span>
          <div>
            <h2 id="voice-strategy-heading">决定这些声音怎么分配</h2>
            <p>默认旁白是单选；人物声音池支持多选、全选和清空。</p>
          </div>
        </div>
        <div className="fl-strategy-summary" aria-label="当前配音摘要">
          <span><strong>{narratorLabel || '未选择'}</strong><small>默认旁白</small></span>
          <span><strong>{poolSize}</strong><small>声音池</small></span>
        </div>
      </header>

      <fieldset className="fl-strategy-grid">
        <legend className="sr-only">配音方式</legend>
        {strategies.map((strategy) => {
          const Icon = strategy.icon;
          return (
            <label key={strategy.id} className={preset === strategy.id ? 'is-selected' : ''}>
              <input
                type="radio"
                name="voice-strategy"
                value={strategy.id}
                checked={preset === strategy.id}
                onChange={() => onChange(strategy.id)}
              />
              <Icon aria-hidden={true} />
              <span><strong>{strategy.label}</strong><small>{strategy.description}</small></span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
