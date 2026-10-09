/**
 * Worker 测试套件资源分组。四组互斥，磁盘上每个 .spec.ts 必须且只能落在一组：
 *
 * - PURE：不启动 Chromium、不连 PostgreSQL。`test:fast` 并行跑。
 * - DB：真实 PostgreSQL，浏览器端口是假的。组内文件串行（lifecycle「停机落在领取期间」竞态用例
 *   与并行跑存在确定性耦合，门控两轮复现；与模板库克隆无关，克隆并发在 db / api 包一直是 3～4 路）。
 *   在 `pnpm test` 的集成配置里排在浏览器文件之后单独执行。`test:db`，并计入 `pnpm test`。
 * - BROWSER：启动 Chromium，但页面来自 setContent、127.0.0.1 或被路由拦截的保留域名。
 *   结果确定，计入 `pnpm test`。BROWSER 内部再按是否连 PostgreSQL 分两档：
 *   - SERIAL：连库真 Chromium，每个文件 openIsolatedDb 克隆自己的库。保持在独立一档是因为 managed-page.lab
 *     等真 SDK 用例时序敏感，曾在 3 路并发下耦合失败（见 vitest.integration.config.mts）；
 *     「克隆并发会互踩」不是原因，已不成立；
 *   - PARALLEL：不连库，各自独立临时 profile + 随机端口，无跨文件共享资源，
 *     可受控并行（maxWorkers 限制并发 Chromium 数）。CAIRN_BROWSER_PARALLEL=0
 *     可整档退回串行（排查偶发时的逃生舱）。
 * - DEMO：演示 / 验收类全链路（守卫 vs 演示分类，2026-09-29）。验证「某条能力链
 *   走得通」而非回归不变式，默认套件不跑，通过 `test:demo` 按需触发；改动相关
 *   子系统时由 verify:changed 的 L3 提示补跑。
 * - LIVE：会访问公网站点或在线模型。不进 `test` / `test:browser`，只通过 `test:live` 手动巡检。
 */

/** BROWSER 组中连 PostgreSQL 的文件：单独一档，与不连库的文件分开调度（理由见文件头）。 */
export const BROWSER_SERIAL_SPEC_FILES: readonly string[] = [
  'src/ai/midscene/managed-page.lab.spec.ts',
  'src/browser/concurrency-p4-barrier.lab.spec.ts',
  'src/browser/engine.lab.spec.ts',
  'src/browser/engine.outcome-c.lab.spec.ts',
  'src/browser/engine.outcome.lab.spec.ts',
  'src/browser/engine.page-health.lab.spec.ts',
  'src/browser/file-submission.lab.spec.ts',
  'src/browser/managed-browser.lab.spec.ts',
  'src/browser/session-auth-driven.integration.spec.ts',
  'src/browser/session-manager.integration.spec.ts',
  'src/runtime/e2e-report-simulation.spec.ts',
]

/** BROWSER 组中不连 PostgreSQL 的文件：无跨文件共享资源，可受控并行。 */
export const BROWSER_PARALLEL_SPEC_FILES: readonly string[] = [
  'src/ai/midscene/__tests__/action-recorder.lab.spec.ts',
  'src/browser/action-navigation.spec.ts',
  'src/browser/page-health-collector.browser.spec.ts',
  'src/ai/midscene/page-write-gate.spec.ts',
  'src/ai/page-agent/inpage-binding.spec.ts',
  'src/browser/aria-match.spec.ts',
  'src/browser/aria-snapshot.spec.ts',
  'src/browser/captcha/__tests__/captcha-integration.spec.ts',
  'src/browser/concurrency-p2-shared.lab.spec.ts',
  'src/browser/explore-network-guard.spec.ts',
  'src/browser/host-isolation.lab.spec.ts',
  'src/browser/landing-settle.lab.spec.ts',
  'src/browser/managed-helpers.spec.ts',
  'src/browser/map-consumption.lab.spec.ts',
  'src/browser/map-ingest-collector.spec.ts',
  'src/browser/page-discovery.spec.ts',
  'src/browser/profiles.isolation.lab.spec.ts',
  'src/browser/resolved-handle.lab.spec.ts',
  'src/browser/reverse-locator-probe.lab.spec.ts',
  'src/browser/reverse-locator.spec.ts',
  'src/browser/runtime.hmi.spec.ts',
  'src/browser/runtime.health.spec.ts',
  'src/browser/runtime.navigation.spec.ts',
  'src/browser/runtime.screenshot.spec.ts',
  'src/browser/screencast.spec.ts',
  'src/browser/screenshot-quality.lab.spec.ts',
  'src/browser/session-auth.page.spec.ts',
  'src/browser/surface.aria-assert.spec.ts',
  'src/browser/surface.business-flows.lab.spec.ts',
  'src/browser/surface.dynamic-lab.spec.ts',
  'src/browser/surface.lab.spec.ts',
  'src/browser/table-read-grids.browser.spec.ts',
  'src/browser/table-read-v2.browser.spec.ts',
    'src/browser/table-read-structured.browser.spec.ts',
    'src/browser/table-read-real.browser.spec.ts',
    'src/browser/table-adapters/registry.browser.spec.ts',
    'src/browser/table-read-modern-grids.browser.spec.ts',
]

export const BROWSER_SPEC_FILES: readonly string[] = [
  ...BROWSER_SERIAL_SPEC_FILES,
  ...BROWSER_PARALLEL_SPEC_FILES,
]

/** 演示 / 验收档：验证能力链走得通，非回归守卫；默认不跑，`test:demo` 按需触发。 */
export const DEMO_SPEC_FILES: readonly string[] = [
  'src/ai/demonstration.lab.spec.ts',
  'src/browser/file-submission.demo.lab.spec.ts',
  'src/browser/run-video-lead.lab.spec.ts',
]

export const DB_SPEC_FILES: readonly string[] = [
  'src/__tests__/harness.spec.ts',
  'src/engine/engine.ai.spec.ts',
  'src/engine/engine.auth-recovery.spec.ts',
  'src/engine/engine.browser.spec.ts',
  'src/engine/engine.download.spec.ts',
  'src/engine/engine.integration.spec.ts',
  'src/engine/engine.logging.spec.ts',
  'src/engine/engine.loop.spec.ts',
  'src/engine/engine.outcome.spec.ts',
  'src/engine/engine.passive-map.spec.ts',
  'src/engine/engine.upload.spec.ts',
  'src/objects/objects.integration.spec.ts',
  'src/runtime/alert-delivery.integration.spec.ts',
  'src/runtime/lifecycle.integration.spec.ts',
]

export const PURE_SPEC_FILES: readonly string[] = [
  'src/__tests__/test-groups.spec.ts',
  'src/ai/__tests__/ai-extract-list.spec.ts',
  'src/ai/aria-tree-branch.spec.ts',
  'src/ai/midscene/__tests__/action-recorder.spec.ts',
  'src/ai/midscene/action-gate.spec.ts',
  'src/ai/midscene/extract.spec.ts',
  'src/ai/midscene/formal-agent.spec.ts',
  'src/ai/midscene/model-client.spec.ts',
  'src/ai/midscene/run-dir.spec.ts',
  'src/ai/mock-model-client.spec.ts',
  'src/ai/model-call-log.spec.ts',
  'src/ai/model-router.spec.ts',
  'src/ai/port.spec.ts',
  'src/browser/__tests__/element-candidate-inspector.spec.ts',
  'src/browser/__tests__/extract-many.spec.ts',
  'src/browser/auth-input-fence.spec.ts',
  'src/browser/captcha/__tests__/captcha-boundaries.spec.ts',
  'src/browser/captcha/__tests__/captcha-core.spec.ts',
  'src/browser/captcha/__tests__/captcha.spec.ts',
  'src/browser/credential-consume.spec.ts',
  'src/browser/execute.guard.spec.ts',
  'src/browser/frame-subscribe.spec.ts',
  'src/browser/guard.spec.ts',
  'src/browser/host-pool.spec.ts',
  'src/browser/managed-browser.boundary.spec.ts',
  'src/browser/map-observer.spec.ts',
  'src/browser/observe-grant.spec.ts',
  'src/browser/observe-page.spec.ts',
  'src/browser/observed-session.spec.ts',
  'src/browser/operation-progress.spec.ts',
  'src/browser/page-identity.spec.ts',
  'src/browser/port.spec.ts',
  'src/browser/prewarm-adaptive.spec.ts',
  'src/browser/profiles.spec.ts',
  'src/browser/resolved-handle.spec.ts',
  'src/browser/resolver.spec.ts',
  'src/browser/reuse.spec.ts',
  'src/browser/run-auth-observer.spec.ts',
  'src/browser/run-auth-recovery.spec.ts',
  'src/browser/run-video.integrity.spec.ts',
  'src/browser/run-video.spec.ts',
  'src/browser/run-video.stop.spec.ts',
  'src/browser/runtime.auth-probe.spec.ts',
  'src/browser/runtime.login-fields.spec.ts',
  'src/browser/runtime.occupancy.spec.ts',
  'src/browser/runtime.sensitive.spec.ts',
  'src/browser/runtime.stop.spec.ts',
  'src/browser/runtime.storage-state.spec.ts',
  'src/browser/session-auth.spec.ts',
  'src/browser/session-claim.spec.ts',
  'src/browser/session-command.spec.ts',
  'src/browser/session-idle-observer.spec.ts',
  'src/browser/session-maintenance.spec.ts',
  'src/browser/session-reaper.spec.ts',
  'src/browser/table-observe.spec.ts',
  'src/browser/totp.spec.ts',
  'src/browser/tracing.boundary.spec.ts',
  'src/browser/upload-runtime.spec.ts',
  'src/browser/video-encoder.spec.ts',
  'src/browser/video-encoder.timeout.spec.ts',
  'src/browser/video-timeline.spec.ts',
  'src/business-sources/build.service.spec.ts',
  'src/engine/__tests__/ai-executor-bindings.spec.ts',
  'src/engine/__tests__/output-size-limit.spec.ts',
  'src/engine/ai-executor.spec.ts',
  'src/engine/browser-executor.failure-screenshot.spec.ts',
  'src/engine/clock.spec.ts',
  'src/engine/debug-step-plan.spec.ts',
  'src/engine/engine.boundary.spec.ts',
  'src/engine/engine.control-flow.spec.ts',
  'src/engine/error-surface.spec.ts',
  'src/browser/page-health-collector.spec.ts',
  'src/engine/page-health.spec.ts',
  'src/engine/resolution-ladder.spec.ts',
  'src/engine/step-executor-registry.spec.ts',
  'src/engine/fixture-executor.checks.spec.ts',
    'src/engine/outcome-collector.table.spec.ts',
    'src/browser/table-read-v2.timeout.spec.ts',
  'src/internal/http-server.spec.ts',
  'src/map/consumption.service.spec.ts',
  'src/map/projection.service.spec.ts',
  'src/map/reference-scan.service.spec.ts',
  'src/map/surface-collect.spec.ts',
  'src/map/surface-state.spec.ts',
  'src/observe/run-control-hint.service.spec.ts',
  'src/reliability/__tests__/calculator.spec.ts',
  'src/reliability/__tests__/grouping-fingerprint.spec.ts',
  'src/reliability/__tests__/reliability-consumer.spec.ts',
  'src/runtime/analysis-executor.spec.ts',
  'src/runtime/browser-processes.spec.ts',
  'src/runtime/lifecycle.domain-isolation.spec.ts',
  'src/runtime/lifecycle.spec.ts',
  'src/runtime/outbound-delivery.spec.ts',
  'src/runtime/periodic-slots.spec.ts',
  'src/runtime/placement-backoff.spec.ts',
  'src/runtime/report-ai-runner.spec.ts',
  'src/runtime/report-render.spec.ts',
  'src/runtime/report-duration-html.spec.ts',
  'src/runtime/service-webhook-delivery.spec.ts',
  'src/runtime/single-flight-tasks.spec.ts',
  'src/testing/failure-artifacts.spec.ts',
]

export const LIVE_SPEC_FILES: readonly string[] = [
  'src/ai/aria-tree-probe.lab.spec.ts',
  'src/browser/captcha/__tests__/captcha-live-target.spec.ts',
  'src/browser/engine.dpm.spec.ts',
]
