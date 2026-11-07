import { render } from 'preact';
import { App } from './app.tsx';
import { registerServiceWorker } from './pwa.ts';
import './styles.css';

const root = document.getElementById('app');
if (root) render(<App />, root);

// The development server should not cache its unhashed modules; the built app
// registers the shell/offline worker instead.
if (import.meta.env.PROD) void registerServiceWorker();
