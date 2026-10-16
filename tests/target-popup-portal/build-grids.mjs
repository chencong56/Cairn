import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

/** 把 antd（依赖 React）打成单个本地 IIFE，门户页面不走 CDN。其余两个控件直接用发行版 UMD。 */
mkdirSync(new URL('./grids/dist', import.meta.url), { recursive: true })
await build({
  entryPoints: [new URL('./grids/antd.entry.jsx', import.meta.url).pathname],
  outfile: new URL('./grids/dist/antd.bundle.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})
