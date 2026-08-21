import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './lib/api'

const qc = new QueryClient()

type Tab = 'dashboard' | 'settings'

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  )
}

function Shell() {
  const [tab, setTab] = useState<Tab>('dashboard')
  return (
    <div className="min-h-screen bg-[#fafafa] text-[#111]">
      <header className="border-b border-[#e5e5e5] bg-white">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">RBLighter ↔ Lighter 价差套利</h1>
            <p className="text-[12px] text-[#888]">Cross-venue orderbook spread monitor</p>
          </div>
          <nav className="flex gap-1 text-[13px]">
            <TabBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')}>监控面板</TabBtn>
            <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>设置</TabBtn>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        {tab === 'dashboard' ? <Dashboard /> : <Settings />}
      </main>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md border transition-colors ${
        active ? 'bg-[#111] text-white border-[#111]' : 'bg-white text-[#555] border-[#e5e5e5] hover:border-[#bbb]'
      }`}
    >
      {children}
    </button>
  )
}

/* ---------------- Dashboard ---------------- */

function Dashboard() {
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['scan'],
    queryFn: () => fetch(api('monitor/scan?limit=30')).then((r) => r.json()),
    refetchInterval: 8000,
  })
  const signals = useQuery({
    queryKey: ['signals'],
    queryFn: () => fetch(api('monitor/signals')).then((r) => r.json()),
    refetchInterval: 8000,
  })

  if (isLoading) return <Loading label="正在扫描双边订单簿…" />
  if (error || data?.error) return <ErrorBox msg={data?.error || String(error)} />

  const rows = (data?.rows || []) as any[]

  return (
    <div className="space-y-6">
      <StatBar data={data} fetching={isFetching} />

      <HealthBar />

      <TasksPanel />

      <Card title="实时价差" subtitle={`共 ${data?.total_common ?? 0} 个共同市场 · 扫描 ${data?.scanned ?? 0} 个 · 每 8 秒刷新 · 深度倍数阈值 ${fmt(data?.min_depth_ratio, 1)}×（低于阈值实盘不开仓）`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[#999] border-b border-[#eee]">
                <Th>市场</Th>
                <Th right>Lighter 买/卖</Th>
                <Th right>RBLighter 买/卖</Th>
                <Th right>方向</Th>
                <Th right>价差 (bps)</Th>
                <Th right>净价差</Th>
                <Th right>深度倍数</Th>
                <Th right>样本</Th>
                <Th right>状态</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className={`border-b border-[#f3f3f3] ${r.signal ? 'bg-[#f0fdf4]' : ''}`}>
                  <Td className="font-medium">{r.symbol}</Td>
                  <Td right mono>{fmt(r.lighter_bid)} / {fmt(r.lighter_ask)}</Td>
                  <Td right mono>{fmt(r.rblighter_bid)} / {fmt(r.rblighter_ask)}</Td>
                  <Td right>{r.best?.direction === 'buy_lighter' ? '买L 卖RB' : '买RB 卖L'}</Td>
                  <Td right mono className={spreadColor(r.best?.spread_bps)}>{fmt(r.best?.spread_bps, 1)}</Td>
                  <Td right mono className={spreadColor(r.net_bps)}>{fmt(r.net_bps, 1)}</Td>
                  <Td right mono className={r.depth_ratio == null ? 'text-[#999]' : r.depth_ok ? 'text-emerald-600' : 'text-red-500'}>
                    {r.depth_ratio == null ? '—' : `${fmt(r.depth_ratio, 1)}×`}
                  </Td>
                  <Td right mono>{r.samples ?? 0}</Td>
                  <Td right>
                    {r.signal ? <Badge tone="green">信号</Badge> : r.armed ? <Badge tone="gray">已就绪</Badge> : <Badge tone="light">采样中</Badge>}
                  </Td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={9} className="py-6 text-center text-[#999]">暂无数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="入场信号记录" subtitle="价差超过阈值且样本达标时写入本地数据库">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[#999] border-b border-[#eee]">
                <Th>时间</Th><Th>市场</Th><Th>买入</Th><Th>卖出</Th><Th right>价差 (bps)</Th><Th right>样本</Th><Th right>模式</Th>
              </tr>
            </thead>
            <tbody>
              {(signals.data?.signals || []).map((s: any) => (
                <tr key={s.id} className="border-b border-[#f3f3f3]">
                  <Td className="text-[#888]">{new Date(s.created_at).toLocaleTimeString()}</Td>
                  <Td className="font-medium">{s.symbol}</Td>
                  <Td>{s.buy_venue} @ {fmt(s.buy_price)}</Td>
                  <Td>{s.sell_venue} @ {fmt(s.sell_price)}</Td>
                  <Td right mono className="text-emerald-600">{fmt(s.spread_bps, 1)}</Td>
                  <Td right mono>{s.samples}</Td>
                  <Td right>{s.dry_run ? <Badge tone="gray">模拟</Badge> : <Badge tone="red">实盘</Badge>}</Td>
                </tr>
              ))}
              {!(signals.data?.signals || []).length && (
                <tr><td colSpan={7} className="py-6 text-center text-[#999]">尚无信号</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

const STATE_META: Record<string, { label: string; tone: 'green' | 'gray' | 'red' | 'light' }> = {
  ENTERING: { label: '开仓中', tone: 'light' },
  RECONCILING: { label: '对账中', tone: 'light' },
  HOLDING: { label: '持仓中', tone: 'green' },
  EXITING: { label: '平仓中', tone: 'light' },
  CLOSED: { label: '已平仓', tone: 'gray' },
  ERROR: { label: '作废', tone: 'red' },
  PAUSED: { label: '已暂停', tone: 'red' },
}
const ACTIVE = ['ENTERING', 'RECONCILING', 'HOLDING', 'EXITING', 'PAUSED']

function TasksPanel() {
  const client = useQueryClient()
  const { data } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => fetch(api('tasks')).then((r) => r.json()),
    refetchInterval: 8000,
  })
  const act = useMutation({
    mutationFn: ({ id, op }: { id: number; op: string }) =>
      fetch(api(`tasks/${id}/${op}`), { method: 'POST' }).then((r) => r.json()),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tasks'] }),
  })
  const clearHistory = useMutation({
    mutationFn: () => fetch(api('tasks/history'), { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tasks'] }),
  })

  const s = data?.summary || {}
  const tasks = (data?.tasks || []) as any[]
  const pnl = Number(s.realized_pnl || 0)

  return (
    <Card
      title="套利任务（模拟执行）"
      subtitle="按原逻辑：IOC 双腿开仓 → 成交对账 → 部分/单腿补偿 → 持仓 → reduce-only 平仓。DRY_RUN 下不触发真实下单。"
    >
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-4">
        <MiniStat label="进行中" value={s.open ?? 0} />
        <MiniStat label="持仓" value={s.holding ?? 0} />
        <MiniStat label="已完成" value={s.closed ?? 0} />
        <MiniStat label="暂停" value={s.paused ?? 0} />
        <MiniStat label="作废" value={s.error ?? 0} />
        <MiniStat label="累计盈亏" value={`$${pnl.toFixed(2)}`} tone={pnl >= 0 ? 'green' : 'red'} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[#999] border-b border-[#eee]">
              <Th>市场</Th><Th>方向</Th><Th right>撮合量</Th><Th right>入场价差</Th>
              <Th right>盈亏(USD)</Th><Th>状态</Th><Th>说明</Th><Th right>操作</Th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const meta = STATE_META[t.state] || { label: t.state, tone: 'light' as const }
              const active = ACTIVE.includes(t.state)
              return (
                <tr key={t.id} className="border-b border-[#f3f3f3]">
                  <Td className="font-medium">{t.symbol}</Td>
                  <Td>{t.direction === 'buy_lighter' ? '买L 卖RB' : '买RB 卖L'}</Td>
                  <Td right mono>{t.matched_size ? Number(t.matched_size).toFixed(4) : '-'}</Td>
                  <Td right mono className="text-emerald-600">{fmt(t.entry_spread_bps, 1)}</Td>
                  <Td right mono className={t.pnl_usd == null ? '' : t.pnl_usd >= 0 ? 'text-emerald-600' : 'text-red-500'}>
                    {t.pnl_usd == null ? '-' : Number(t.pnl_usd).toFixed(2)}
                  </Td>
                  <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
                  <Td className="text-[#888] max-w-[240px] truncate" >{t.note}</Td>
                  <Td right>
                    {active ? (
                      <div className="flex gap-1 justify-end">
                        {t.state === 'PAUSED' ? (
                          <MiniBtn onClick={() => act.mutate({ id: t.id, op: 'resume' })}>恢复</MiniBtn>
                        ) : t.state === 'HOLDING' ? (
                          <MiniBtn onClick={() => act.mutate({ id: t.id, op: 'pause' })}>暂停</MiniBtn>
                        ) : null}
                        {(t.state === 'HOLDING' || t.state === 'PAUSED') && (
                          <MiniBtn onClick={() => act.mutate({ id: t.id, op: 'close' })}>平仓</MiniBtn>
                        )}
                      </div>
                    ) : (
                      <span className="text-[#ccc]">—</span>
                    )}
                  </Td>
                </tr>
              )
            })}
            {!tasks.length && (
              <tr><td colSpan={8} className="py-6 text-center text-[#999]">暂无任务。当价差触发信号时会自动开仓（需在设置中开启自动执行）。</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {tasks.some((t) => t.state === 'CLOSED' || t.state === 'ERROR') && (
        <div className="mt-3 text-right">
          <MiniBtn onClick={() => clearHistory.mutate()}>清空历史记录</MiniBtn>
        </div>
      )}
    </Card>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: any; tone?: string }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-emerald-600' : 'text-[#111]'
  return (
    <div className="bg-[#fafafa] border border-[#eee] rounded-md px-3 py-2">
      <div className="text-[11px] text-[#999]">{label}</div>
      <div className={`text-[15px] font-semibold ${color}`}>{value}</div>
    </div>
  )
}
function MiniBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="px-2 py-0.5 rounded border border-[#ddd] text-[12px] text-[#555] hover:border-[#999] bg-white">
      {children}
    </button>
  )
}

function HealthBar() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetch(api('monitor/health')).then((r) => r.json()),
    refetchInterval: 5000,
  })
  if (!data) return null
  const on = data.background_enabled
  const since = data.seconds_since_last_run
  const stale = since != null && since > (data.interval_sec || 8) * 3
  const uptime = fmtDuration(data.uptime_sec)
  const lastRun =
    data.last_run_at ? `${since}s 前` : '尚未运行'
  return (
    <div className="bg-white border border-[#e5e5e5] rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
      <span className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${on ? (stale ? 'bg-amber-400' : 'bg-emerald-500') : 'bg-gray-300'}`} />
        <span className="font-medium text-[13px]">{on ? '后台运行中' : '后台已关闭'}</span>
      </span>
      <HealthItem label="上次采样" value={lastRun} warn={stale} />
      <HealthItem label="采样间隔" value={`${data.interval_sec ?? '-'}s`} />
      <HealthItem label="每轮市场" value={data.scan_market_limit ?? '-'} />
      <HealthItem label="累计轮次" value={data.ticks ?? 0} />
      <HealthItem label="运行时长" value={uptime} />
      <HealthItem label="单轮耗时" value={data.last_duration_ms != null ? `${data.last_duration_ms}ms` : '-'} />
      <HealthItem label="状态" value={data.last_status === 'error' ? '异常' : data.last_status === 'ok' ? '正常' : '-'} warn={data.last_status === 'error'} />
      {data.last_error && <span className="text-red-500 truncate max-w-[280px]" title={data.last_error}>错误：{data.last_error}</span>}
    </div>
  )
}
function HealthItem({ label, value, warn }: { label: string; value: any; warn?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[#999]">{label}</span>
      <span className={`font-medium ${warn ? 'text-amber-600' : 'text-[#333]'}`}>{value}</span>
    </span>
  )
}
function fmtDuration(sec: number) {
  if (!sec || sec < 0) return '-'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

function StatBar({ data, fetching }: { data: any; fetching: boolean }) {
  const focus = (data?.focus_symbol || '').trim()
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <Stat label="运行模式" value={data?.dry_run ? '模拟 (DRY_RUN)' : '实盘'} tone={data?.dry_run ? 'gray' : 'red'} />
      <Stat label="实盘就绪" value={data?.live_ready ? '是' : '否'} tone={data?.live_ready ? 'green' : 'gray'} />
      <Stat label="价差阈值" value={`${fmt(data?.threshold_bps, 1)} bps`} />
      <Stat label="交易范围" value={focus || '全部币种'} tone={focus ? 'green' : 'gray'} extra={`最多 ${data?.max_concurrent_tasks ?? 1} 仓`} />
      <Stat label="当前机会" value={data?.opportunities_count ?? 0} tone={(data?.opportunities_count || 0) > 0 ? 'green' : 'gray'} extra={fetching ? '刷新中…' : ''} />
      <Stat label="后台运行" value={data?.background_enabled ? '开启' : '关闭'} tone={data?.background_enabled ? 'green' : 'gray'} extra={data?.background_enabled ? '关闭页面也采样' : '仅打开页面时'} />
    </div>
  )
}

function Stat({ label, value, tone, extra }: { label: string; value: any; tone?: string; extra?: string }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-emerald-600' : 'text-[#111]'
  return (
    <div className="bg-white border border-[#e5e5e5] rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[#999]">{label}</div>
      <div className={`text-[16px] font-semibold ${color}`}>{value}</div>
      {extra ? <div className="text-[11px] text-[#bbb]">{extra}</div> : null}
    </div>
  )
}

/* ---------------- Settings ---------------- */

const FIELD_GROUPS: { title: string; note?: string; fields: { key: string; label: string; type?: string; secret?: boolean; placeholder?: string }[] }[] = [
  {
    title: '安全开关',
    note: '首次使用请保持默认（模拟模式）。全部开启且确认后方可实盘。',
    fields: [
      { key: 'dry_run', label: 'DRY_RUN（模拟模式）', type: 'bool' },
      { key: 'live_trading_ack', label: 'LIVE_TRADING_ACK（确认实盘）', type: 'bool' },
      { key: 'poc_verified', label: 'POC_VERIFIED（验证通过）', type: 'bool' },
      { key: 'enable_real_market_streams', label: 'ENABLE_REAL_MARKET_STREAMS', type: 'bool' },
    ],
  },
  {
    title: 'Lighter 账户',
    fields: [
      { key: 'lighter_base_url', label: 'REST 地址' },
      { key: 'lighter_ws_url', label: 'WebSocket 地址' },
      { key: 'lighter_account_index', label: 'Account Index' },
      { key: 'lighter_api_key_index', label: 'API Key Index' },
      { key: 'lighter_api_private_key', label: 'API 私钥', secret: true, placeholder: '留空则不修改' },
    ],
  },
  {
    title: 'RBLighter 账户',
    fields: [
      { key: 'rblighter_base_url', label: 'REST 地址' },
      { key: 'rblighter_ws_url', label: 'WebSocket 地址' },
      { key: 'rblighter_account_index', label: 'Account Index' },
      { key: 'rblighter_api_key_index', label: 'API Key Index' },
      { key: 'rblighter_api_private_key', label: 'API 私钥', secret: true, placeholder: '留空则不修改' },
    ],
  },
  {
    title: '运行范围（先单币种·单仓位跑通）',
    note: '建议先选定 1 个币种、仓位上限设为 1，把完整流程跑顺、验证盈亏无误后再逐步放开。',
    fields: [
      { key: 'focus_symbol', label: '只交易此币种（留空=全部）', type: 'symbol' },
      { key: 'scan_symbols', label: '只扫描这些币种（逗号分隔，如 BTC,ETH；留空=按下方数量扫描）', placeholder: 'BTC,ETH' },
      { key: 'max_concurrent_tasks', label: '同时最多持有仓位数', type: 'num' },
    ],
  },
  {
    title: '策略参数',
    fields: [
      { key: 'spread_threshold_bps', label: '入场价差阈值 (bps)', type: 'num' },
      { key: 'min_samples', label: '最小样本数', type: 'num' },
      { key: 'max_slippage_bps', label: '最大滑点 (bps)', type: 'num' },
      { key: 'order_notional_usd', label: '单笔名义金额 (USD)', type: 'num' },
      { key: 'min_depth_ratio', label: '最小深度倍数（盘口量÷下单量，实盘生效）', type: 'num' },
      { key: 'taker_fee_bps', label: '单边 taker 手续费 (bps，用于盈亏计算)', type: 'num' },
      { key: 'exit_spread_bps', label: '平仓收敛阈值 (bps)', type: 'num' },
      { key: 'max_hold_ticks', label: '最大持仓 tick 数', type: 'num' },
      { key: 'reduce_only', label: 'Reduce-Only 风控', type: 'bool' },
      { key: 'ioc_orders', label: 'IOC 订单', type: 'bool' },
      { key: 'maker_open', label: 'Maker 挂单开仓（买腿被动挂单 0 费，成交后 taker 对冲卖腿）', type: 'bool' },
      { key: 'maker_open_wait_ticks', label: 'Maker 开仓耐心 tick 数（挂单未成交则撤单放弃）', type: 'num' },
      { key: 'maker_close', label: 'Maker 挂单平仓（0 手续费，post-only）', type: 'bool' },
      { key: 'maker_close_wait_ticks', label: 'Maker 平仓耐心 tick 数（对冲后可安全久等，超时才 taker 补平）', type: 'num' },
      { key: 'auto_execute', label: '自动执行任务（模拟）', type: 'bool' },
      { key: 'background_enabled', label: '后台采样与执行（关闭页面也运行）', type: 'bool' },
      { key: 'scan_interval_sec', label: '扫描间隔（秒，最小 3）', type: 'num' },
      { key: 'scan_market_limit', label: '每轮扫描市场数（1–40）', type: 'num' },
    ],
  },
  {
    title: '网络代理',
    note: '所有交易所接口将通过此代理访问。支持 http/https/socks5，可包含账号密码。留空则直连。',
    fields: [
      { key: 'proxy_url', label: '代理地址', placeholder: 'http://user:pass@host:port 或 socks5://host:1080（留空直连）' },
    ],
  },
  {
    title: '通知（可选）',
    fields: [
      { key: 'telegram_bot_token', label: 'Telegram Bot Token', secret: true, placeholder: '留空则不修改' },
      { key: 'telegram_chat_id', label: 'Telegram Chat ID' },
    ],
  },
]

function Settings() {
  const client = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => fetch(api('settings')).then((r) => r.json()),
  })
  const [form, setForm] = useState<Record<string, any>>({})
  const [saved, setSaved] = useState(false)

  const mut = useMutation({
    mutationFn: (payload: Record<string, any>) =>
      fetch(api('settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json()),
    onSuccess: () => {
      setSaved(true)
      setForm({})
      client.invalidateQueries({ queryKey: ['settings'] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const test = useMutation({
    mutationFn: () => fetch(api('settings/test')).then((r) => r.json()),
  })

  // Symbol list for the focus dropdown — reuse the live scan so users pick, not type.
  const scan = useQuery({
    queryKey: ['scan-symbols'],
    queryFn: () => fetch(api('monitor/scan?limit=40')).then((r) => r.json()),
    staleTime: 30000,
  })
  const symbols: string[] = ((scan.data?.rows || []) as any[]).map((r) => r.symbol).filter(Boolean)

  if (isLoading) return <Loading label="加载设置…" />

  const val = (k: string) => (k in form ? form[k] : data?.[k])
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="space-y-5 max-w-3xl">
      <p className="text-[13px] text-[#888]">
        账户凭据与策略配置保存在本地数据库。API 私钥保存后不会回显，重新填写才会覆盖。
      </p>
      {FIELD_GROUPS.map((g) => (
        <Card key={g.title} title={g.title} subtitle={g.note}>
          <div className="grid md:grid-cols-2 gap-4">
            {g.fields.map((f) => (
              <div key={f.key}>
                <label className="block text-[12px] text-[#666] mb-1">{f.label}</label>
                {f.type === 'bool' ? (
                  <button
                    type="button"
                    onClick={() => set(f.key, !val(f.key))}
                    className={`px-3 py-1.5 rounded-md border text-[13px] ${
                      val(f.key) ? 'bg-[#111] text-white border-[#111]' : 'bg-white text-[#555] border-[#ddd]'
                    }`}
                  >
                    {val(f.key) ? '开启' : '关闭'}
                  </button>
                ) : f.type === 'symbol' ? (
                  <select
                    value={val(f.key) ?? ''}
                    onChange={(e) => set(f.key, e.target.value)}
                    className="w-full px-3 py-1.5 rounded-md border border-[#ddd] text-[13px] bg-white focus:border-[#111] outline-none"
                  >
                    <option value="">全部币种</option>
                    {symbols.map((sym) => (
                      <option key={sym} value={sym}>{sym}</option>
                    ))}
                    {val(f.key) && !symbols.includes(val(f.key)) && (
                      <option value={val(f.key)}>{val(f.key)}（当前）</option>
                    )}
                  </select>
                ) : (
                  <input
                    type={f.secret ? 'password' : f.type === 'num' ? 'number' : 'text'}
                    value={f.secret ? (form[f.key] ?? '') : (val(f.key) ?? '')}
                    placeholder={f.secret && data?.[`${f.key}__set`] ? '已设置（留空不修改）' : f.placeholder || ''}
                    onChange={(e) => set(f.key, f.type === 'num' ? e.target.value : e.target.value)}
                    className="w-full px-3 py-1.5 rounded-md border border-[#ddd] text-[13px] bg-white focus:border-[#111] outline-none"
                  />
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => {
            const payload: Record<string, any> = { ...form }
            for (const g of FIELD_GROUPS)
              for (const f of g.fields)
                if (f.type === 'num' && f.key in payload) {
                  const n = parseFloat(payload[f.key])
                  if (Number.isFinite(n)) payload[f.key] = n
                  else delete payload[f.key] // 空/非法数字不提交，避免写入 null 导致下单量为 0
                }
            mut.mutate(payload)
          }}
          disabled={mut.isPending}
          className="px-5 py-2 rounded-md bg-[#111] text-white text-[13px] font-medium disabled:opacity-50"
        >
          {mut.isPending ? '保存中…' : '保存设置'}
        </button>
        <button
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="px-4 py-2 rounded-md border border-[#ddd] text-[#555] text-[13px] font-medium hover:border-[#999] disabled:opacity-50"
        >
          {test.isPending ? '测试中…' : '测试连接（经代理）'}
        </button>
        {saved && <span className="text-[13px] text-emerald-600">已保存到本地数据库 ✓</span>}
      </div>

      {test.data && (
        <div className="text-[13px] bg-white border border-[#e5e5e5] rounded-lg p-4 space-y-1">
          <div className="text-[#888] mb-1">代理：{test.data.proxy_enabled ? '已启用' : '未启用（直连）'} · 先保存再测试</div>
          {['lighter', 'rblighter'].map((k) => {
            const v = test.data[k]
            if (!v) return null
            return (
              <div key={k} className="flex items-center gap-2">
                <Badge tone={v.ok ? 'green' : 'red'}>{v.ok ? '通' : '失败'}</Badge>
                <span className="font-medium">{v.name}</span>
                <span className="text-[#888]">
                  {v.ok ? `${v.ms}ms · ${v.markets} 个市场` : `${v.ms}ms · ${v.error}`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------------- primitives ---------------- */

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[#e5e5e5] rounded-lg">
      <div className="px-5 py-3 border-b border-[#f0f0f0]">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {subtitle ? <p className="text-[12px] text-[#999] mt-0.5">{subtitle}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`py-2 px-2 font-medium ${right ? 'text-right' : ''}`}>{children}</th>
}
function Td({ children, right, mono, className = '' }: { children: React.ReactNode; right?: boolean; mono?: boolean; className?: string }) {
  return <td className={`py-2 px-2 ${right ? 'text-right' : ''} ${mono ? 'tabular-nums font-mono text-[12px]' : ''} ${className}`}>{children}</td>
}
function Badge({ children, tone }: { children: React.ReactNode; tone: 'green' | 'gray' | 'red' | 'light' }) {
  const map: Record<string, string> = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    gray: 'bg-[#f5f5f5] text-[#666] border-[#e5e5e5]',
    red: 'bg-red-50 text-red-700 border-red-200',
    light: 'bg-white text-[#999] border-[#eee]',
  }
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] border ${map[tone]}`}>{children}</span>
}
function Loading({ label }: { label: string }) {
  return <div className="py-16 text-center text-[#999] text-[13px]">{label}</div>
}
function ErrorBox({ msg }: { msg: string }) {
  return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-red-700 text-[13px]">加载失败：{msg}</div>
}

function fmt(n: any, d = 4) {
  const x = typeof n === 'number' ? n : parseFloat(n)
  if (!Number.isFinite(x)) return '-'
  return x.toLocaleString('en-US', { maximumFractionDigits: d })
}
function spreadColor(bps: any) {
  const x = typeof bps === 'number' ? bps : parseFloat(bps)
  if (!Number.isFinite(x)) return ''
  return x > 0 ? 'text-emerald-600' : x < 0 ? 'text-red-500' : ''
}

