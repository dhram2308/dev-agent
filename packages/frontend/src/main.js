import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './global.css';
const rootEl = document.getElementById('root');
if (!rootEl) {
    throw new Error('Root element #root not found in DOM');
}
createRoot(rootEl).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
