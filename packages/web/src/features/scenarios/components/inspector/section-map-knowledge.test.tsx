import '@/styles/index.css'
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { SectionMapKnowledge } from './section-map-knowledge'

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

describe('地图知识分区', () => {
  beforeEach(() => signIn(['map:read', 'workflow:write']))

  it('默认折叠，展开后才渲染内容', async () => {
    const screen = await render(
      <SectionMapKnowledge>
        <p>分区内容</p>
      </SectionMapKnowledge>
    )
    const trigger = screen.getByRole('button', { name: '地图知识' })
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect.element(screen.getByText('分区内容')).not.toBeInTheDocument()
    await trigger.click()
    await expect.element(screen.getByText('分区内容')).toBeVisible()
  })

  it('无地图读取权限时不显示分区', async () => {
    signIn(['workflow:write'])
    const screen = await render(
      <SectionMapKnowledge>
        <p>分区内容</p>
      </SectionMapKnowledge>
    )
    await expect.element(screen.getByTestId('section-map-knowledge')).not.toBeInTheDocument()
  })
})
