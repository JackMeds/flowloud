import React from 'react';
import ReactDOM from 'react-dom/client';
import { OptionsWorkspace } from '../../components/OptionsWorkspace';
import '../../styles/tokens.css';
import '../../styles/components.css';
import '../../styles/voice-center.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsWorkspace />
  </React.StrictMode>,
);
