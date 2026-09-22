import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { SettingsApp } from './SettingsApp';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
