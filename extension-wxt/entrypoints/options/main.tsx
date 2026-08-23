import React from 'react';
import ReactDOM from 'react-dom/client';
import { SettingsWorkspace } from '../../components/SettingsWorkspace';
import '../../styles/tokens.css';
import '../../styles/components.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsWorkspace />
  </React.StrictMode>,
);
