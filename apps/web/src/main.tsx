/**
 * Browser entry point.
 *
 * Registers the service worker, which is what makes the app installable and
 * lets it receive push notifications while closed.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// `autoUpdate` means a new build takes over on the next load rather than
// prompting; the app is small and there is nothing to lose mid-session.
registerSW({ immediate: true });
