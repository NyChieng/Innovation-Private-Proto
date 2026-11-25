import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './lib/store.jsx';
import App from './App.jsx';
import { registerServiceWorker } from './lib/install.js';

import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/400-italic.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import './styles/theme.css';
import './styles/app.css';
import './styles/motion.css';
import './styles/forest.css';

registerServiceWorker();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
