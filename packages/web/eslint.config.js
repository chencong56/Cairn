import globals from 'globals'
import js from '@eslint/js'
import pluginQuery from '@tanstack/eslint-plugin-query'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['dist', 'src/components/ui'] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginQuery.configs['flat/recommended'],
    ],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // eslint-plugin-react-hooks 7.x 把 React Compiler 的检查也塞进了 recommended：这条假定项目会用编译器
      // 自动做 memo，据此把「effect 里 setState 会多渲染一帧」当错误。本仓库没有接入 React Compiler
      // （无 babel-plugin-react-compiler / vite 编译器插件），这条假设不成立；与外部状态（URL、SSE、服务端
      // 租约）同步的 effect 本就该在 effect 里 setState。降级为 warn：新代码仍会被提示尽量在渲染期
      // 派生，但不因为一个不存在的前提卡住构建。
      'react-hooks/set-state-in-effect': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-console': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Enforce type-only imports for TypeScript types
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      // Prevent duplicate imports from the same module
      'no-duplicate-imports': 'error',
      // crypto.randomUUID 只在安全上下文可用；局域网明文 HTTP 部署里它是 undefined，直接调用会让按钮静默失效。
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='randomUUID']",
          message: '禁止直接调用 crypto.randomUUID（明文 HTTP 部署下不可用），请改用 @/lib/uuid 的 newUuid()。',
        },
      ],
    },
  },
  {
    // newUuid 本身需要探测并回退；测试里可以直接造 UUID。
    files: ['src/lib/uuid.ts', '**/*.{test,spec}.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  }
)
