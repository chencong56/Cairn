import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // 显式收窄：默认 include 同样匹配 dist 下编译出来的 .test.js，
    // 测试结果不该取决于有没有先跑过构建
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // beforeAll 里的 openIsolatedDb 要建库 + 跑全部迁移，实测常在 7s 上下；
    // vitest 默认 hookTimeout 是 10s，整包并行时越线就把文件判红。
    hookTimeout: 60_000,
    retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
    globalSetup: ['./vitest.global-setup.mts'],
    // 每个文件开始时归还上一个文件占用的复用库，下一次 openContractDb 会先清表。
    setupFiles: ['./src/__tests__/contract-reuse-setup.ts'],
    // 限制测试文件并发 worker，防止过多进程同时向单个 PostgreSQL 实例发起 CREATE DATABASE TEMPLATE 导致元数据锁争用与 fsync 堆叠
    maxWorkers: 4,
  },
})
