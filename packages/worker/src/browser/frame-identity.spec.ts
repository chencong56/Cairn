import { describe, expect, it } from 'vitest'
import {
  framePathIdentity,
  frameStepsFromHops,
  frameUrlPatternHits,
  stableFrameUrlPattern,
} from './frame-identity.js'

describe('iframe 身份：记录落地 path，匹配兼容跳转 src', () => {
  it('记录时优先落地 pathname，丢掉 query', () => {
    const jump =
      '/ctb-ass/frameTab.do?priv_id=10100010&cct_url=http%3A%2F%2Fbi.example%2Fctb-thematic-web%2FtowerSkip%2FgoReportMgt'
    const landed = 'http://bi.example/ctb-thematic-web/towerSkip/goReportMgt?flag=undefined&token=abc'
    expect(stableFrameUrlPattern(jump, landed)).toBe('/ctb-thematic-web/towerSkip/goReportMgt')
  })

  it('落地是 about:blank 时退回 src 的 path', () => {
    expect(stableFrameUrlPattern('/portal/frame-outer.html?x=1', 'about:blank')).toBe('/portal/frame-outer.html')
  })

  it('相对 src 也能收成 path', () => {
    expect(framePathIdentity('frame-inner.html?flag=1')).toBe('/frame-inner.html')
    expect(framePathIdentity('/frame-jump.html?to=/inner')).toBe('/frame-jump.html')
  })

  it('旧描述符记跳转 src：当前 URL 对不上，但 iframe src 仍对得上', () => {
    const recorded =
      '/frame-jump.html?priv_id=10100010&cct_url=http%3A%2F%2Fbi.example%2Finner'
    const current = 'http://127.0.0.1:9/frame-inner.html?flag=undefined'
    expect(frameUrlPatternHits(recorded, current)).toBe(false)
    expect(frameUrlPatternHits(recorded, current, recorded)).toBe(true)
    expect(
      frameUrlPatternHits(recorded, current, undefined, `http://127.0.0.1:9${recorded}`),
    ).toBe(true)
  })

  it('新描述符记落地 path：落地 URL 带新 token 仍命中', () => {
    expect(
      frameUrlPatternHits(
        '/frame-inner.html',
        'http://127.0.0.1:9/frame-inner.html?token=second-99',
        '/frame-jump.html?to=/frame-inner.html',
      ),
    ).toBe(true)
  })

  it('src 稳定、落地只多了 query：旧相对文件名仍命中', () => {
    expect(
      frameUrlPatternHits(
        'frame-inner.html',
        'http://127.0.0.1:9/frame-inner.html?session=xyz',
        'frame-inner.html',
      ),
    ).toBe(true)
  })

  it('过短 path 不做重叠回退，避免 / 命中一切', () => {
    expect(frameUrlPatternHits('/', 'http://example.com/app', '')).toBe(false)
    expect(frameUrlPatternHits('/a', 'http://example.com/app', '')).toBe(false)
  })

  it('点选 hops 收成 FrameStep，带 name / selector', () => {
    expect(
      frameStepsFromHops([
        {
          name: 'jump',
          src: '/frame-jump.html?priv_id=1',
          href: 'http://127.0.0.1:9/frame-inner.html?flag=undefined',
          selector: '#jump-frame',
        },
      ]),
    ).toEqual([{ name: 'jump', urlPattern: '/frame-inner.html', selector: '#jump-frame' }])
  })
})
