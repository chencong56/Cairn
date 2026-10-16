/* 靶场公共：控件页从 /grids/api 取数（数据由服务端 grids/data.mjs 确定性生成）。 */
window.GridLab = (() => {
  const q = new URLSearchParams(location.search)
  const params = {
    rows: Math.max(0, Number(q.get('rows') ?? 8)),
    empty: q.get('empty') === '1',
    pinned: q.get('pinned') === '1',
    summary: q.get('summary') === '1' || q.get('bad') === '1',
    bad: q.get('bad') === '1',
    group: q.get('group') === '1',
    paged: q.get('paged') === '1',
    virtual: q.get('virtual') === '1',
    post: q.get('post') === '1',
    badTotal: q.get('badTotal') === '1',
    shortPage: q.get('shortPage') === '1',
    drift: q.get('drift') === '1',
    collapsed: q.get('collapsed') === '1',
  }
  const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const COLS = [
    { key: 'id', title: '编号' },
    { key: 'name', title: '站点名称' },
    { key: 'region', title: '区域' },
    { key: 'qty', title: '数量' },
    { key: 'amount', title: '金额（元）' },
    { key: 'status', title: '状态' },
    { key: 'date', title: '日期' },
  ]
  /** 取站点数据：参数原样转给接口；post=1 时用 POST（企业系统常见的查询方式）。 */
  const fetchSites = async () => {
    const url = `/grids/api/sites${location.search}`
    const res = params.post
      ? await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 1 }) })
      : await fetch(url)
    const body = await res.json()
    // drift=1：接口第一行的数量被改过，页面仍按真值显示——模拟“前端展示与接口返回不一致”
    const rows = params.drift ? body.data.list.map((r, i) => (i === 0 ? { ...r, qty: r.qty - 100 } : r)) : body.data.list
    return { rows, total: body.data.summary ?? null }
  }
  return { params, fmt, COLS, fetchSites }
})()
