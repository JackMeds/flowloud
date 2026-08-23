import type { Preview } from '@storybook/react-vite';
import '../styles/tokens.css';
import '../styles/components.css';

const preview: Preview = {
  parameters: {
    backgrounds: { default: 'neutral' },
    layout: 'centered',
    a11y: { test: 'error' },
  },
};

export default preview;
