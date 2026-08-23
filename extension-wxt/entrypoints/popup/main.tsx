import React from 'react';
import ReactDOM from 'react-dom/client';
import { RuntimePopup } from '../../components/RuntimePopup';
import '../../styles/tokens.css';
import '../../styles/components.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RuntimePopup />
  </React.StrictMode>,
);
