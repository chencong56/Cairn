import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import { DB_SPEC_FILES } from './src/testing/test-groups.mjs'

/**
 * PostgreSQL 集成测试。浏览器端口由用例自己伪造，不启动 Chromium。
 * 隔离库从同一模板克隆，并发 CREATE DATABASE ... TEMPLATE 会互相踩，因此串行。
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: [...DB_SPEC_FILES],
    env: {
      CAIRN_WORKER_INTERNAL_PORT: '0',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
    fileParallelism: false,
    globalSetup: './vitest.global-setup.mts',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
