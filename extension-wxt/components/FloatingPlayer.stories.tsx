import type { Meta, StoryObj } from '@storybook/react-vite';
import { FloatingPlayer } from './FloatingPlayer';

const meta = {
  title: 'Mock/Flowloud/Floating Player',
  component: FloatingPlayer,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof FloatingPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Orb: Story = {};
export const Loading: Story = { args: { initialState: 'loading' } };
export const FloatingPaused: Story = { args: { initialState: 'paused' } };
export const ErrorState: Story = { args: { initialState: 'error' } };
export const Expanded: Story = { args: { initialExpanded: true } };
export const AllStates: Story = {
  render: () => (
    <div className="fl-floating-story-grid">
      <section className="fl-floating-story-stage" aria-label="半隐藏悬浮球交互预览">
        <span>将鼠标移到右侧半圆上</span>
        <FloatingPlayer />
      </section>
      <section className="fl-floating-story-stage" aria-label="展开播放器预览">
        <FloatingPlayer initialExpanded initialState="paused" />
      </section>
    </div>
  ),
};
