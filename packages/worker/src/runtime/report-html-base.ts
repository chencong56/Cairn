/** 报告 HTML 的共用基础：转义与版式样式。各主体模板（单场景、场景集、周期耗时）共用。 */

export function escapeHtml(str: unknown): string {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const SHARED_STYLES = `
  :root {
    --bg-page: #f8fafc;
    --bg-card: #ffffff;
    --border-color: #e2e8f0;
    --border-subtle: #f1f5f9;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #94a3b8;
    --color-brand: #0284c7;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: var(--bg-page);
    color: var(--text-primary);
    font-family: var(--font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    padding-bottom: 60px;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 20px;
  }
  /* Top Bar */
  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .brand-logo-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-logo {
    max-height: 36px;
    max-width: 140px;
    object-fit: contain;
  }
  .platform-tag {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-brand);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .actions-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-card);
    color: var(--text-secondary);
    transition: transform 100ms ease-out, color 120ms ease-out, background-color 120ms ease-out, border-color 120ms ease-out;
    user-select: none;
  }
  .btn:hover {
    background: #f1f5f9;
    color: var(--text-primary);
    border-color: #cbd5e1;
  }
  .btn:active { transform: scale(0.97); }
  .btn-primary {
    background: #0284c7;
    color: #ffffff;
    border-color: #0284c7;
  }
  .btn-primary:hover {
    background: #0369a1;
    border-color: #0369a1;
    color: #ffffff;
  }

  /* Header Card */
  .header-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
  }
  .header-title {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 6px;
    line-height: 1.15;
    letter-spacing: -0.02em;
  }
  .header-kicker {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 12px;
    letter-spacing: 0;
  }
  .header-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* Grid Layouts */
  .grid-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 16px 20px;
    box-shadow: 0 1px 2px 0 rgba(0,0,0,0.03);
  }
  .stat-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .stat-subtext {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 4px;
  }

  /* Health Score Large Showcase */
  .score-hero {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .score-circle {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    border: 4px solid currentColor;
    background: #ffffff;
    flex-shrink: 0;
  }
  .score-val { font-size: 22px; line-height: 1; }
  .score-max { font-size: 10px; opacity: 0.7; }

  /* Badges */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    border: 1px solid transparent;
  }
  .badge-success { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
  .badge-danger  { background: #fff1f2; color: #9f1239; border-color: #fecdd3; }
  .badge-warning { background: #fffbeb; color: #92400e; border-color: #fde68a; }
  .badge-info    { background: #f0f9ff; color: #0369a1; border-color: #bae6fd; }
  .badge-neutral { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }

  /* Sections */
  .section {
    margin-bottom: 28px;
  }
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 10px;
  }
  .section-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Filter Pills */
  .filter-pills {
    display: flex;
    gap: 6px;
    background: #f1f5f9;
    padding: 3px;
    border-radius: 8px;
  }
  .pill {
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    transition: transform 100ms ease-out, color 120ms ease-out, background-color 120ms ease-out;
  }
  .pill:hover { color: var(--text-primary); }
  .pill:active { transform: scale(0.97); }
  .pill.active {
    background: #ffffff;
    color: var(--color-brand);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }

  /* Tables */
  .table-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.03);
  }
  .table-responsive {
    width: 100%;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    text-align: left;
  }
  th {
    background: #f8fafc;
    color: var(--text-secondary);
    font-weight: 600;
    padding: 12px 10px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
  }
  td {
    padding: 12px 10px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    vertical-align: middle;
  }
  th.num, td.num {
    width: 72px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    text-align: right;
    white-space: nowrap;
  }
  th.num.lead { width: 88px; }
  td.num.lead { font-weight: 600; }
  td.num.muted { color: var(--text-secondary); }
  .table-note {
    margin: 0;
    padding: 10px 14px 12px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-muted);
    border-top: 1px solid var(--border-subtle);
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background-color: #fbfcfe; }
  .table-num { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  /* Collapsible Accordion (details / summary) */
  details.step-accordion {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    margin-bottom: 10px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.02);
    transition: border-color 0.15s ease;
  }
  details.step-accordion[open] {
    border-color: #cbd5e1;
  }
  summary.step-summary {
    list-style: none;
    cursor: pointer;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    user-select: none;
  }
  summary.step-summary::-webkit-details-marker { display: none; }
  summary.step-summary:hover { background: #fbfcfe; }
  .step-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }
  .step-idx {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
    min-width: 24px;
  }
  .step-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step-header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .step-chevron {
    width: 18px;
    height: 18px;
    color: var(--text-muted);
    transition: transform 0.2s ease;
  }
  details[open] .step-chevron {
    transform: rotate(180deg);
  }
  .step-body {
    padding: 16px 20px;
    border-top: 1px solid var(--border-subtle);
    background: #fbfcfe;
    font-size: 13px;
  }

  /* Screenshot Cards & Lightbox */
  .screenshot-gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 14px;
    margin-top: 12px;
  }
  .thumb-card {
    background: #ffffff;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    cursor: zoom-in;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .thumb-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
  .thumb-img {
    width: 100%;
    height: 140px;
    object-fit: cover;
    display: block;
    border-bottom: 1px solid var(--border-subtle);
  }
  .thumb-caption {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Lightbox Overlay */
  .lightbox-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.88);
    backdrop-filter: blur(4px);
    z-index: 10000;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .lightbox-overlay.active { display: flex; }
  .lightbox-content {
    max-width: 92vw;
    max-height: 82vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
  }
  .lightbox-caption {
    color: #f1f5f9;
    margin-top: 12px;
    font-size: 14px;
    font-weight: 500;
    text-align: center;
  }
  .lightbox-close {
    position: absolute;
    top: 20px;
    right: 24px;
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
    border: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    font-size: 20px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
  }
  .lightbox-close:hover { background: rgba(255, 255, 255, 0.3); }

  /* Key-Value Tag */
  .kv-tag {
    display: inline-flex;
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-mono);
    margin: 2px 4px 2px 0;
    border: 1px solid #e2e8f0;
  }
  .kv-key { color: var(--text-secondary); font-weight: 600; margin-right: 4px; }
  .kv-val { color: var(--text-primary); }

  /* Toast Notification */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #0f172a;
    color: #ffffff;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: none;
    z-index: 10001;
  }
  .toast.show { display: block; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

  /* AI Interpretation Card */
  .ai-card {
    background: linear-gradient(135deg, #f0fdf4 0%, #f8fafc 100%);
    border: 1px solid #bbf7d0;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);
  }
  .ai-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #dcfce7;
    padding-bottom: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ai-card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 700;
    color: #166534;
  }
  .ai-card-meta {
    font-size: 12px;
    color: #4b5563;
  }
  .ai-card-disclaimer {
    display: inline-block;
    background: #e2e8f0;
    color: #475569;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    margin-left: 6px;
  }
  .ai-alert-inconclusive {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 14px;
    color: #92400e;
    font-size: 13px;
  }
  .ai-observation {
    font-size: 14px;
    color: #1f2937;
    line-height: 1.6;
    margin-bottom: 14px;
    background: #ffffff;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
  }
  .ai-section-subtitle {
    font-size: 13px;
    font-weight: 700;
    color: #374151;
    margin-top: 14px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ai-finding-item {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 8px;
  }
  .ai-finding-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .ai-finding-title {
    font-weight: 600;
    font-size: 13px;
    color: #111827;
  }
  .ai-finding-detail {
    font-size: 13px;
    color: #4b5563;
    line-height: 1.5;
  }
  .ai-citation-pill {
    display: inline-flex;
    align-items: center;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    color: #334155;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-mono);
    margin-left: 4px;
  }
  .ai-suggestion-list {
    margin-left: 20px;
    font-size: 13px;
    color: #374151;
    line-height: 1.6;
  }

  @media (prefers-reduced-motion: reduce) {
    .pill, .btn { transition: none; transform: none !important; }
  }

  /* Media Print Optimizations */
  @media print {
    @page { size: A4 portrait; margin: 12mm; }
    body { background: #ffffff !important; padding: 0 !important; color: #000000 !important; }
    .container { max-width: 100% !important; padding: 0 !important; }
    .no-print { display: none !important; }
    .header-card, .stat-card, .table-card, .ai-card, details.step-accordion {
      box-shadow: none !important;
      border-color: #cbd5e1 !important;
    }
    details.step-accordion { display: block !important; }
    details.step-accordion > * { display: block !important; }
    .step-chevron { display: none !important; }
    table, tr, .stat-card, .ai-card, details.step-accordion {
      break-inside: avoid !important;
      page-break-inside: avoid !important;
    }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
`
