import { useState } from 'react';
import { Button } from 'react-aria-components';
import {
  AudioLines,
  CircleAlert,
  LoaderCircle,
  LocateFixed,
  Minimize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';

type FloatingState = 'ready' | 'loading' | 'playing' | 'paused' | 'error';

function ActiveFloatingSentence() {
  return <>复杂的 <mark>作者配音</mark> 不该挤在一个瞬时小窗里。</>;
}

function FloatingSignal({ state }: { state: FloatingState }) {
  if (state === 'loading') return <LoaderCircle className="fl-floating-signal-loader" aria-hidden="true" />;
  if (state === 'paused') return <Pause aria-hidden="true" />;
  if (state === 'error') return <CircleAlert aria-hidden="true" />;
  return <AudioLines aria-hidden="true" />;
}

export function FloatingPlayer({
  initialExpanded = false,
  initialState = 'playing',
}: {
  initialExpanded?: boolean;
  initialState?: FloatingState;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [state, setState] = useState<FloatingState>(initialState);
  const playing = state === 'playing' || state === 'loading';

  if (!expanded) {
    return (
      <div className={`fl-floating-edge-control is-${state}`} data-edge="right">
        <div className="fl-floating-hit-area">
          <Button className="fl-orb" aria-label="展开网页悬浮播放器" onPress={() => setExpanded(true)}>
            <FloatingSignal state={state} />
          </Button>
          <div className="fl-floating-quick-actions is-above" role="group" aria-label="上方悬浮快捷控制">
            <Button aria-label={playing ? '暂停朗读' : '继续朗读'} onPress={() => setState(playing ? 'paused' : 'playing')}>
              {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </Button>
            <Button aria-label="回到当前朗读位置"><LocateFixed aria-hidden="true" /></Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className={`fl-floating-player is-${state}`} aria-label="网页悬浮播放器">
      <div className="fl-floating-heading">
        <div className="fl-floating-identity"><strong>远山</strong></div>
        <span>第 3 段 / 共 18 段</span>
      </div>
      <p className="fl-floating-sentence"><ActiveFloatingSentence /></p>
      <div className="fl-floating-progress"><div><span /></div><small>17%</small></div>
      <div className="fl-floating-status" role="status">{state === 'paused' ? '已暂停 · 点击继续' : state === 'loading' ? '正在加载音频…' : state === 'error' ? '播放失败' : '正在朗读'}</div>
      <div className="fl-floating-controls" role="group" aria-label="悬浮播放控制">
        <Button aria-label="上一句"><SkipBack aria-hidden="true" /></Button>
        <Button className="is-primary" aria-label={playing ? '暂停朗读' : '继续朗读'} onPress={() => setState(playing ? 'paused' : 'playing')}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
        <Button aria-label="下一句"><SkipForward aria-hidden="true" /></Button>
        <Button aria-label="回到当前朗读位置"><LocateFixed aria-hidden="true" /></Button>
        <Button aria-label="收起网页悬浮播放器" onPress={() => setExpanded(false)}><Minimize2 aria-hidden="true" /></Button>
      </div>
    </section>
  );
}
