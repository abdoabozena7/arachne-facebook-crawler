import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/server.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile: 'dist/server.js', sourcemap: true }),
  build({ entryPoints: ['src/browser/overlay.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/overlay.js', sourcemap: true }),
  build({ entryPoints: ['src/dashboard.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/public/dashboard.js', sourcemap: true }),
  cp('public', 'dist/public', { recursive: true })
]);
await cp('dist/overlay.js', 'companion/overlay.js');
console.log('Built server, DOM observer, spider renderer, and dashboard.');
