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
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
});
