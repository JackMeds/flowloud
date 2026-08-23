import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PopupConsole } from './PopupConsole';
import { demoPopupModel, type PopupModel, type PopupSettings } from './model';

function InteractivePopup({ initialModel }: { initialModel: PopupModel }) {
  const [model, setModel] = useState(initialModel);
  const changeSetting = <Key extends keyof PopupSettings>(key: Key, value: PopupSettings[Key]) => {
    setModel((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
  };
  return (
    <PopupConsole
      model={model}
      onSettingChange={changeSetting}
      onVoiceChange={(voiceId) => setModel((current) => ({ ...current, selectedVoiceId: voiceId }))}
      onPageVoiceChange={(authorId, voiceId) => setModel((current) => {
        const assignments = { ...(current.pageVoiceAssignments || {}) };
        if (voiceId === '__strategy__') delete assignments[authorId];
        else assignments[authorId] = voiceId;
        return { ...current, pageVoiceAssignments: assignments };
      })}
      onCommand={(command) => {
        if (command === 'previous') setModel((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
        if (command === 'next') setModel((current) => ({ ...current, index: Math.min(Math.max(0, current.total - 1), current.index + 1) }));
        if (command === 'toggle-playback') setModel((current) => ({ ...current, status: current.status === 'playing' ? 'paused' : 'playing' }));
      }}
    />
  );
}

const meta = {
  title: 'Mock/Flowloud/Popup Console',
  component: PopupConsole,
  args: { model: demoPopupModel },
  render: ({ model }) => <InteractivePopup initialModel={model} />,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof PopupConsole>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playing: Story = {};
export const Paused: Story = { args: { model: { ...demoPopupModel, status: 'paused' } } };
export const Failure: Story = { args: { model: { ...demoPopupModel, status: 'error', settings: { ...demoPopupModel.settings, activeProviderId: 'local-service' }, message: '本地服务暂时无法合成当前句。' } } };
export const Empty: Story = { args: { model: { ...demoPopupModel, title: '当前网页不支持朗读', currentText: '打开一篇文章或讨论页后，即可开始朗读。', status: 'idle', index: 0, total: 0, authors: [] } } };
