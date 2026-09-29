import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  // 门禁范围先钉在「死文件 / 无用依赖 / 重复导出」三类会持续腐烂的问题上；
  // 142 个存量未使用导出（多为 feature barrel 转发）待专项收敛后再纳入。
  include: ['files', 'dependencies', 'duplicates'],
  ignore: [
    // shadcn/ui 原语整体保留：按需组合，不逐文件判定是否已被业务页面引用
    'src/components/ui/**',
    // 设计规范约定的日期选择器，见 docs/design/front/implementation.md
    'src/components/date-picker.tsx',
  ],
  // 由被忽略的原语或设计规范使用，业务代码里不直接出现的依赖：
  // - tabs / radio / switch / date-fns / react-day-picker：只被 src/components/ui/** 引用
  // - recharts：docs/design/front/implementation.md 约定的图表基线
  ignoreDependencies: [
    '@radix-ui/react-radio-group',
    '@radix-ui/react-switch',
    '@radix-ui/react-tabs',
    'date-fns',
    'react-day-picker',
    'recharts',
  ],
}

export default config
