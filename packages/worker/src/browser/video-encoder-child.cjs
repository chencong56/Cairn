'use strict'

// @ffmpeg/core 0.11 是 GPL/nonfree WASM，只在一次性编码子进程里加载，不进 shared / web / api。
const { readFileSync, writeFileSync, readdirSync, existsSync, statSync } = require('node:fs')

const WHOLE_SET_FALLBACK_MAX_BYTES = 192 * 1024 * 1024
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const dir = process.argv[2]
const outPath = process.argv[3]
const fps = Number(process.argv[4] || '2') || 2
const maxBytes = process.argv[5] || '134217728'

if (!dir || !outPath) {
  process.stderr.write('用法: video-encoder-child.cjs <jpegDir> <out.webm> [fps] [maxBytes]\n')
  process.exit(2)
}

const createFFmpegCore = require('@ffmpeg/core')
const wasmBinary = readFileSync(require.resolve('@ffmpeg/core/dist/ffmpeg-core.wasm'))

function listJpeg(names) {
  return names.filter((name) => name.endsWith('.jpg')).sort()
}

function buildConcat(frames, sealedTMs) {
  const lines = ['ffconcat version 1.0']
  for (let i = 0; i < frames.length; i += 1) {
    const next = i + 1 < frames.length ? frames[i + 1].tMs : sealedTMs
    const durationMs = Math.max(1, Math.round(next - frames[i].tMs))
    lines.push(`file '${String(frames[i].file).replace(/'/g, "'\\''")}'`)
    lines.push(`duration ${(durationMs / 1000).toFixed(3)}`)
  }
  if (frames.length > 0) lines.push(`file '${String(frames[frames.length - 1].file).replace(/'/g, "'\\''")}'`)
  return `${lines.join('\n')}\n`
}

function resampleGrid(frames, sealedTMs, rate) {
  const span = Math.max(0, sealedTMs)
  const count = Math.max(1, Math.round((span * rate) / 1000))
  const picked = []
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : Math.round((i * span) / count)
    while (cursor + 1 < frames.length && frames[cursor + 1].tMs <= t) cursor += 1
    picked.push(frames[cursor])
  }
  return picked
}

function honorsTimeline(decoded, sealedTMs) {
  return (
    Number.isFinite(decoded.decodedFrames) &&
    decoded.decodedFrames >= 1 &&
    Number.isFinite(decoded.decodedDurationMs) &&
    Math.abs(decoded.decodedDurationMs - sealedTMs) <= 1000
  )
}

function parseDecodeLog(text) {
  let decodedDurationMs = 0
  const duration = text.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (duration) {
    decodedDurationMs = Math.round(
      (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
    )
  }
  let decodedFrames = 0
  for (const match of text.matchAll(/frame=\s*(\d+)/g)) {
    decodedFrames = Number(match[1])
  }
  return { decodedDurationMs, decodedFrames }
}

async function runFfmpeg(args, files, collectErr = false) {
  const logs = []
  let ended
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('VP8 编码超时')), 120_000)
    ended = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  const core = await createFFmpegCore({
    wasmBinary,
    print: (message) => {
      if (String(message) === 'FFMPEG_END') ended()
    },
    printErr: (message) => {
      if (collectErr) logs.push(String(message))
    },
  })
  for (const [name, bytes] of files) {
    core.FS.writeFile(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }
  const run = core.cwrap('proxy_main', 'number', ['number', 'number'])
  const argv = ['./ffmpeg', '-nostdin', '-y', ...args]
  const argsPtr = core._malloc(argv.length * 4)
  argv.forEach((value, index) => {
    const size = core.lengthBytesUTF8(value) + 1
    const buf = core._malloc(size)
    core.stringToUTF8(value, buf, size)
    core.setValue(argsPtr + 4 * index, buf, 'i32')
  })
  run(argv.length, argsPtr)
  await finished
  return { core, logs: logs.join('\n') }
}

/** 每个 WASM 实例自带 pthread 线程池和独立堆；不释放，分段越多线程与内存越多（线上曾累积到 501 线程 / 5.9GB）。 */
function disposeCore(core) {
  try {
    core.PThread?.terminateAllThreads?.()
  } catch {}
  try {
    core.exit?.(0)
  } catch {}
  // 每个实例初始堆 1GB，等 V8 自己回收会同时存活好几份；父进程以 --expose-gc 启动时主动收一次。
  if (typeof global.gc === 'function') global.gc()
}

function readAndDispose(core, name) {
  try {
    return Buffer.from(core.FS.readFile(name))
  } finally {
    disposeCore(core)
  }
}

function isWebm(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
}

const encodeArgs = ['-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-fs', String(maxBytes), 'out.webm']

async function encodeCfr(files, rate) {
  const { core } = await runFfmpeg(['-framerate', String(rate), '-i', 'frame_%05d.jpg', ...encodeArgs], files)
  return readAndDispose(core, 'out.webm')
}

async function encodeConcat(files, concatText) {
  const withList = [...files, ['timeline.concat', Buffer.from(concatText)]]
  const { core } = await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'timeline.concat', '-vsync', 'vfr', ...encodeArgs], withList)
  return readAndDispose(core, 'out.webm')
}

async function encodeCopyConcat(files, concatText) {
  const withList = [...files, ['segments.concat', Buffer.from(concatText)]]
  const { core } = await runFfmpeg(
    ['-f', 'concat', '-safe', '0', '-i', 'segments.concat', '-c', 'copy', '-fs', String(maxBytes), 'out.webm'],
    withList,
  )
  return readAndDispose(core, 'out.webm')
}

function partitionSegments(frames, sealedTMs, segmentMs = 8000) {
  if (frames.length === 0) return []
  const windows = []
  let start = 0
  for (let i = 1; i <= frames.length; i += 1) {
    const last = i === frames.length
    const endT = last ? sealedTMs : frames[i].tMs
    if (last || endT - frames[start].tMs >= segmentMs) {
      windows.push({
        frames: frames.slice(start, i),
        fromMs: frames[start].tMs,
        toMs: Math.max(endT, frames[start].tMs + 1),
      })
      start = i
    }
  }
  return windows
}

function segmentHostName(index) {
  return `segment_${String(index).padStart(3, '0')}.webm`
}

async function encodeSegment(seg, index) {
  const hostName = segmentHostName(index)
  const hostPath = join(dir, hostName)
  if (existsSync(hostPath)) {
    const existing = readFileSync(hostPath)
    if (isWebm(existing)) return { name: hostName, bytes: existing, timingMode: 'concat' }
  }
  const remapped = seg.frames.map((frame, index) => ({
    file: `frame_${String(index).padStart(5, '0')}.jpg`,
    tMs: frame.tMs - seg.fromMs,
  }))
  const jpegFiles = remapped.map((frame, index) => [frame.file, readFileSync(join(dir, seg.frames[index].file))])
  const sealedRel = Math.max(1, seg.toMs - seg.fromMs)
  let bytes
  let timingMode = 'concat'
  try {
    bytes = await encodeConcat(jpegFiles, buildConcat(remapped, sealedRel))
    if (!isWebm(bytes)) throw new Error('concat 结果不是 WebM')
    const decoded = await decodeWebm(bytes)
    if (!honorsTimeline(decoded, sealedRel)) throw new Error('concat 未保住采集区间')
  } catch {
    const rate = Math.max(1, seg.frames.length / Math.max(0.001, sealedRel / 1000))
    bytes = await encodeCfr(jpegFiles, rate)
    timingMode = 'cfr'
  }
  if (!isWebm(bytes)) throw new Error('分段编码结果不是可播 WebM')
  writeFileSync(hostPath, bytes)
  return { name: hostName, bytes, timingMode }
}

/**
 * 分段交给独立子进程编码：同一进程里反复创建/销毁 WASM 实例，堆不会还给系统
 * （实测 38 段仍涨到 2.9GB，改前整进程 OOM），进程退出才是可靠的释放。
 */
function encodeSegmentInChild(seg, index) {
  const hostName = segmentHostName(index)
  const hostPath = join(dir, hostName)
  const metaPath = `${hostPath}.json`
  const cached = existsSync(hostPath) && isWebm(readFileSync(hostPath))
  if (!cached) {
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=1536', __filename, dir, outPath, String(fps), String(maxBytes)],
      {
        env: { ...process.env, CAIRN_ENCODER_SEGMENT_INDEX: String(index) },
        encoding: 'utf8',
        timeout: 120_000,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    if (result.status !== 0) {
      throw new Error(`分段 ${index} 编码失败：${(result.stderr || result.error?.message || '').trim() || result.status}`)
    }
  }
  const bytes = readFileSync(hostPath)
  if (!isWebm(bytes)) throw new Error('分段编码结果不是可播 WebM')
  let timingMode = 'concat'
  try {
    timingMode = JSON.parse(readFileSync(metaPath, 'utf8')).timingMode === 'cfr' ? 'cfr' : 'concat'
  } catch {}
  return { name: hostName, bytes, timingMode }
}

async function runSegmentOnly(index) {
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'))
  const frames = Array.isArray(timeline.frames) ? timeline.frames : []
  const windows = partitionSegments(frames, Number(timeline.sealedTMs))
  const seg = windows[index]
  if (!seg) throw new Error(`分段 ${index} 不存在`)
  const result = await encodeSegment(seg, index)
  writeFileSync(`${join(dir, segmentHostName(index))}.json`, JSON.stringify({ timingMode: result.timingMode }))
}

async function decodeWebm(bytes) {
  const { core, logs } = await runFfmpeg(['-i', 'in.webm', '-f', 'null', '-'], [['in.webm', bytes]], true)
  disposeCore(core)
  return parseDecodeLog(logs)
}

async function main() {
  const names = listJpeg(readdirSync(dir))
  if (names.length === 0) {
    throw new Error('没有可编码的录像帧')
  }

  const timelinePath = join(dir, 'timeline.json')
  let timingMode = 'cfr'
  let bytes

  if (existsSync(timelinePath)) {
    const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'))
    const frames = Array.isArray(timeline.frames) ? timeline.frames : []
    const sealedTMs = Number(timeline.sealedTMs)
    if (frames.length === 0 || !Number.isFinite(sealedTMs)) {
      throw new Error('录像时间轴不完整')
    }
    const windows = partitionSegments(frames, sealedTMs)
    try {
      const segments = []
      let anyCfr = false
      for (let i = 0; i < windows.length; i += 1) {
        const seg = encodeSegmentInChild(windows[i], i)
        segments.push(seg)
        if (seg.timingMode === 'cfr') anyCfr = true
      }
      if (segments.length === 1) {
        bytes = segments[0].bytes
        timingMode = anyCfr ? 'cfr' : 'concat'
      } else {
        const list = ['ffconcat version 1.0', ...segments.map((seg) => `file '${seg.name}'`)].join('\n') + '\n'
        const webmFiles = segments.map((seg) => [seg.name, seg.bytes])
        bytes = await encodeCopyConcat(webmFiles, list)
        if (!isWebm(bytes) || !honorsTimeline(await decodeWebm(bytes), sealedTMs)) {
          throw new Error('分段拼接未保住采集区间')
        }
        timingMode = anyCfr ? 'cfr' : 'concat'
      }
    } catch {
      // 整批回退要把全部帧载入同一个 WASM 堆，超过预算就放弃，宁可视频缺失也不拖垮执行节点。
      const total = names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
      if (total > WHOLE_SET_FALLBACK_MAX_BYTES) throw new Error('录像过大，整批回退编码已放弃')
      const jpegFiles = names.map((name) => [name, readFileSync(join(dir, name))])
      try {
        bytes = await encodeConcat(jpegFiles, buildConcat(frames, sealedTMs))
        if (!isWebm(bytes)) throw new Error('concat 结果不是 WebM')
        const decoded = await decodeWebm(bytes)
        if (!honorsTimeline(decoded, sealedTMs)) throw new Error('concat 未保住采集区间')
        timingMode = 'concat'
      } catch {
        const rate = Math.max(1, frames.length / Math.max(0.001, sealedTMs / 1000))
        bytes = await encodeCfr(jpegFiles, rate)
        timingMode = 'cfr'
      }
    }
  } else {
    const jpegFiles = names.map((name) => [name, readFileSync(join(dir, name))])
    bytes = await encodeCfr(jpegFiles, fps)
  }

  if (!isWebm(bytes)) {
    throw new Error('编码结果不是可播 WebM')
  }

  const decoded = await decodeWebm(bytes)
  if (!Number.isFinite(decoded.decodedFrames) || decoded.decodedFrames < 1) {
    throw new Error('编码结果无法解码')
  }

  writeFileSync(outPath, bytes)
  process.stdout.write(JSON.stringify({
    decodedDurationMs: Math.max(0, decoded.decodedDurationMs),
    decodedFrames: decoded.decodedFrames,
    timingMode,
  }))
}

const segmentIndex = process.env.CAIRN_ENCODER_SEGMENT_INDEX
;(segmentIndex === undefined ? main() : runSegmentOnly(Number(segmentIndex)))
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
