import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The React app lives in FloraScan-Web-App/ and the Express API in Server/,
 * so Vite's root is the web app folder rather than the repository root.
 * The build still lands in dist/ at the top level, which is what Server/
 * serves in production.
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'FloraScan-Web-App'),
  plugins: [react()],
  // Pre-bundle every package the app imports when the dev server starts.
  // Left to discovery, Vite finds jsqr only when /scan is first opened, then
  // re-optimises and reloads the page under whoever is using it - which is
  // what crashed the first browser test run on a fresh clone ("Navigating
  // frame was detached").
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'jsqr'],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
});
