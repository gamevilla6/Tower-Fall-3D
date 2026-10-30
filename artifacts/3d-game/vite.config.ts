import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT ?? '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

export default defineConfig(async ({ command, mode }) => ({
  // Production URLs must work under /Tower-Fall-3D/ as well as custom domains.
  base: command === 'build' ? './' : (process.env.BASE_PATH ?? '/'),
  plugins: [
    react(),
    tailwindcss(),
    ...(command === 'serve' ? [runtimeErrorOverlay()] : []),
    ...(command === 'serve' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    // The Pages root has no React dependency; resolve it from the app package.
    dedupe: mode === 'github-pages' ? [] : ['react', 'react-dom'],
  },
  root: mode === 'github-pages'
    ? path.resolve(import.meta.dirname, '../..')
    : path.resolve(import.meta.dirname),
  publicDir: path.resolve(import.meta.dirname, 'public'),
  build: {
    outDir: mode === 'github-pages'
      ? path.resolve(import.meta.dirname, '../../generated-artifacts/github-pages')
      : path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
}));
