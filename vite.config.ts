import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/editor',
  plugins: [react()],
  base: '/',
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
