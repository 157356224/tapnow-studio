import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    open: true,
    // Chromium locks Default/Sessions files while running. They and other
    // runtime/generated directories must never be watched by Vite on Windows.
    watch: {
      ignored: [
        /(?:^|[/\\])server[/\\]data(?:[/\\]|$)/,
        /(?:^|[/\\])server[/\\]uploads(?:[/\\]|$)/,
        /(?:^|[/\\])vendor(?:[/\\]|$)/,
        /(?:^|[/\\])work(?:[/\\]|$)/,
        /(?:^|[/\\])dist(?:[/\\]|$)/
      ]
    },
    proxy: { '/api': 'http://127.0.0.1:3701' }
  }
});
