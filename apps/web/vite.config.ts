import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * A static SPA, deliberately.
 *
 * At this scale the read path is 98% cacheable aggregates (docs/SCALING.md §2), and a static bundle on
 * a CDN with a long immutable cache is the cheapest, most available way to serve a billion people.
 * Server-side rendering would put an origin in front of every page view for no benefit the product
 * needs — the interesting data arrives from cacheable API calls either way.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // Content-hashed filenames, so assets can be cached immutably for a year.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: process.env['VITE_API_URL'] ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
});
