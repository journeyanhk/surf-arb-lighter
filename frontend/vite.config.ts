import path from 'path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(async () => {
  // 工作室注入的错误上报插件；VPS/生产环境没有该文件时自动降级为 no-op。
  // 用绝对 file:// URL 动态导入，既避免 esbuild 静态解析报错，也兼容工作室的临时打包目录。
  let viteErrorReporter: (opts?: unknown) => unknown = () => ({ name: 'vulcan-noop' })
  const reporterAbs = path.resolve(__dirname, '.vulcan-error-reporter.js')
  if (fs.existsSync(reporterAbs)) {
    viteErrorReporter = (await import(/* @vite-ignore */ pathToFileURL(reporterAbs).href)).default
  }

  const frontendPort = Number.parseInt(process.env.PORT || '', 10)
  const backendPort = Number.parseInt(process.env.BACKEND_PORT || '', 10)
  const base = process.env.BASE_PATH || './'
  const hasAbsBase = base.startsWith('/')
  const apiBasePrefix = hasAbsBase ? base.replace(/\/$/, '') : ''

  const backendProxy = {
    target: `http://127.0.0.1:${backendPort}`,
    changeOrigin: true,
    ...(hasAbsBase && {
      rewrite: (requestPath: string) => requestPath.replace(base, '/'),
    }),
  }

  return {
    cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
    plugins: [
      viteErrorReporter({ vulcanDir: "/workspaces/.vulcan" }),react(), tailwindcss()],
    server: {
      allowedHosts: true,
      host: '0.0.0.0',
      port: frontendPort || undefined,
      proxy: {
        [`${apiBasePrefix}/api`]: backendProxy,
      },
      hmr: {
        path: 'ws/vite-hmr',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
      dedupe: ['react', 'react-dom'],
      preserveSymlinks: true,
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-dev-runtime',
        'react/jsx-runtime',
        '@tanstack/react-query',
        '@tanstack/query-core',
      ],
    },
    base,
  }
})
