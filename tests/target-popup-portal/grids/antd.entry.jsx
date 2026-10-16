import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, ConfigProvider, Progress, Steps, Table, Tag } from 'antd'
import zhCN from 'antd/es/locale/zh_CN'

const { params, fmt, fetchSites } = window.GridLab

function App() {
  const [data, setData] = useState([])
  const [total, setTotal] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    fetchSites().then(({ rows, total }) => { setData(rows); setTotal(total); setLoading(false) })
  }, [])
  const col = (key, title, extra = {}) => ({ key, dataIndex: key, title, ...extra })
  const base = [col('id', '编号', params.pinned ? { fixed: 'left', width: 100 } : { width: 100 }), col('name', '站点名称', { width: 160 }), col('region', '区域', { width: 120 })]
  const nums = [col('qty', '数量', { width: 100 }), col('amount', '金额（元）', { width: 140, render: (v) => fmt(v) })]
  const rest = [col('status', '状态', { width: 120 }), col('date', '日期', { width: 140 })]
  const columns = params.group
    ? [{ title: '基础信息', children: base }, { title: '业务数据', children: nums }, ...rest]
    : [...base, ...nums, ...rest]
  const scroll = params.pinned || params.virtual ? { x: 1000, y: 320 } : { y: 320 }
  // 分页：中文后台常见写法（共 N 条 + 每页条数）。badTotal / shortPage 用于分页一致性反例
  const pagination = !params.paged
    ? false
    : params.shortPage
      ? { current: 1, pageSize: 20, total: data.length, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }
      : { pageSize: 20, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, ...(params.badTotal ? { total: data.length + 5 } : {}) }
  const shown = params.paged && params.shortPage ? data.slice(0, 18) : data
  return (
    <Table
      rowKey="id"
      columns={columns}
      dataSource={shown}
      loading={loading}
      rowSelection={{ type: 'checkbox' }}
      pagination={pagination}
      virtual={params.virtual}
      scroll={scroll}
      summary={total ? () => (
        <Table.Summary fixed>
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} />
            <Table.Summary.Cell index={1}>合计</Table.Summary.Cell>
            <Table.Summary.Cell index={2} />
            <Table.Summary.Cell index={3} />
            <Table.Summary.Cell index={4}>{total.qty}</Table.Summary.Cell>
            <Table.Summary.Cell index={5}>{fmt(total.amount)}</Table.Summary.Cell>
            <Table.Summary.Cell index={6} />
            <Table.Summary.Cell index={7} />
          </Table.Summary.Row>
        </Table.Summary>
      ) : undefined}
    />
  )
}
/** 树形表格：/grids/tree，数据来自 /grids/api/tree；默认全部展开，collapsed=1 全部折叠（可点开）。 */
function TreeApp() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState([])
  useEffect(() => {
    fetch(`/grids/api/tree${location.search}`)
      .then((res) => res.json())
      .then((body) => {
        const list = body.data.list
        const parents = []
        const walk = (nodes) => nodes.forEach((x) => { if (x.children?.length) { parents.push(x.key); walk(x.children) } })
        walk(list)
        setData(list)
        setExpanded(params.collapsed ? [] : parents)
        setLoading(false)
      })
  }, [])
  const columns = [
    { key: 'name', dataIndex: 'name', title: '名称', width: 240 },
    { key: 'qty', dataIndex: 'qty', title: '数量', width: 100 },
    { key: 'amount', dataIndex: 'amount', title: '金额（元）', width: 140, render: (v) => fmt(v) },
  ]
  return (
    <Table
      rowKey="key"
      columns={columns}
      dataSource={data}
      loading={loading}
      pagination={false}
      expandable={{ expandedRowKeys: expanded, onExpandedRowsChange: (keys) => setExpanded(keys) }}
    />
  )
}

/** 状态信号：/grids/status?lib=antd，数据来自 /grids/api/status。预设颜色（green）与自定义颜色（#0aa）不是语义。 */
function StatusApp() {
  const [data, setData] = useState(null)
  useEffect(() => {
    fetch(`/grids/api/status${location.search}`).then((res) => res.json()).then((body) => setData(body.data))
  }, [])
  if (!data) return <div>加载中…</div>
  const tagColor = (t) => (t.variant === 'preset' ? 'green' : t.variant === 'custom' ? '#00aaaa' : t.tone === 'default' ? 'default' : t.tone)
  const STEP = { success: 'finish', processing: 'process', default: 'wait', error: 'error' }
  return (
    <div>
      <div id="steps" style={{ marginBottom: 16 }}>
        <Steps items={data.steps.map((x) => ({ title: x.text, status: STEP[x.tone] }))} />
      </div>
      <div id="tags" style={{ marginBottom: 16 }}>
        {data.tags.map((t) => <Tag key={t.text} color={tagColor(t)}>{t.text}</Tag>)}
      </div>
      <div id="alerts" style={{ marginBottom: 16 }}>
        {data.alerts.map((a) => <Alert key={a.text} type={a.tone} message={a.text} style={{ marginBottom: 4 }} />)}
      </div>
      <div id="status-grid">
        <Table
          rowKey="id"
          pagination={false}
          dataSource={data.list}
          columns={[
            { key: 'id', dataIndex: 'id', title: '编号', width: 100 },
            { key: 'name', dataIndex: 'name', title: '站点名称', width: 160 },
            { key: 'status', dataIndex: 'status', title: '状态', width: 120, render: (v, r) => <Tag color={r.tone}>{v}</Tag> },
            { key: 'progress', dataIndex: 'progress', title: '进度', width: 220, render: (v) => <Progress percent={v} size="small" /> },
          ]}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('grid')).render(
  <ConfigProvider locale={zhCN}>
    {location.pathname.endsWith('/tree') ? <TreeApp /> : location.pathname.endsWith('/status') ? <StatusApp /> : <App />}
  </ConfigProvider>,
)
