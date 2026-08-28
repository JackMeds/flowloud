import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageGuideWorkspace } from './PageGuideWorkspace';
import { PageVoicesWorkspace } from './PageVoicesWorkspace';
import { SettingsWorkspace } from './SettingsWorkspace';

const meta = {
  title: 'Mock/Flowloud/Workspaces',
  component: SettingsWorkspace,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SettingsWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsCenter: Story = {};
export const SettingsAppearance: Story = { args: { defaultSection: 'appearance' } };
export const PageVoices: Story = { render: () => <PageVoicesWorkspace /> };
export const PageGuide: Story = { render: () => <PageGuideWorkspace /> };
