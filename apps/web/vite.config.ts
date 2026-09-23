import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The PWA uses `injectManifest` rather than a generated service worker,
 * because the worker needs its own `push` and `notificationclick` handlers
 * (DESIGN.md sections 6 and 11) and a generated one cannot provide those.
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
      manifest: {
        name: mode === 'dev' ? 'OctoAgile Advisor Dev' : 'OctoAgile Advisor',
        short_name: mode === 'dev' ? 'Agile Dev' : 'Agile Advisor',
        description:
          'Independent Agile electricity price forecasts, alerts and half-hourly guidance.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0c1718',
        theme_color: '#0c1718',
        categories: ['utilities', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // The API and the price worker live in the server app during development.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
}));
