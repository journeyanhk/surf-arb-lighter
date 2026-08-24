import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './lib/api'

const qc = new QueryClient()

type Tab = 'dashboard' | 'funding' | 'settings'

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthGate>
        <Shell />
      </AuthGate>
    </QueryClientProvider>
  )
}

// Gate the whole app behind a login when the backend has APP_PASSWORD set.
// When auth is disabled (local dev), this renders children immediately.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => fetch(api('auth/status'), { credentials: 'include' }).then((r) => r.json()),
    retry: false,
  })
  if (isLoading) return <div className="min-h-screen bg-[#fafafa]" />
  if (data && data.enabled && !data.authed) return <Login onDone={() => refetch()} />
  return <>{children}</>
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await fetch(api('auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) onDone()
      else setErr(j.error || '登录失败')
    } catch (_) {
      setErr('网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-h-screen bg-[#fafafa] flex items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-[340px] bg-white border border-[#e5e5e5] rounded-xl px-6 py-7 shadow-sm">
        <h1 className="text-[16px] font-semibold tracking-tight">登录</h1>
        <p className="text-[12px] text-[#888] mt-1 mb-5">RBLighter ↔ Lighter 套利控制台</p>
        <label className="block text-[12px] text-[#666] mb-1">用户名</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          className="w-full mb-3 px-3 py-2 rounded-md border border-[#ddd] text-[14px] outline-none focus:border-[#2563eb]"
        />
        <label className="block text-[12px] text-[#666] mb-1">密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded-md border border-[#ddd] text-[14px] outline-none focus:border-[#2563eb]"
        />
        {err ? <div className="text-[12px] text-red-500 mb-3">{err}</div> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-2 rounded-md bg-[#2563eb] text-white text-[14px] font-medium disabled:opacity-50 hover:bg-[#1d4ed8]"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
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
            <TabBtn active={tab === 'funding'} onClick={() => setTab('funding')}>资金费</TabBtn>
            <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>设置</TabBtn>
            <LogoutBtn />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        {tab === 'dashboard' ? <Dashboard /> : tab === 'funding' ? <Funding /> : <Settings />}
      </main>
    </div>
  )
}

function LogoutBtn() {
  const { data } = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => fetch(api('auth/status'), { credentials: 'include' }).then((r) => r.json()),
    retry: false,
  })
  if (!data?.enabled) return null
  const logout = async () => {
    await fetch(api('auth/logout'), { method: 'POST', credentials: 'include' }).catch(() => {})
    window.location.reload()
  }
  return (
    <button
      onClick={logout}
      className="px-3 py-1.5 rounded-md border bg-white text-[#999] border-[#e5e5e5] hover:text-[#555] hover:border-[#bbb] transition-colors"
    >
      退出
    </button>
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
                  <Td className="text-[#888] max-w-[420px] whitespace-normal break-words leading-snug align-top" title={t.note}>{t.note}</Td>
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
    title: '资金费套利（路线 A · 主引擎）',
    note: '对冲收取两所资金费差：做空费率高的一边、做多低的一边，持仓吃费、费差收敛才平。低频、少折腾。自动执行默认关闭，先手动开 1 单验证。',
    fields: [
      { key: 'funding_auto_execute', label: '自动执行资金费套利（默认关闭，手动验证后再开）', type: 'bool' },
      { key: 'funding_enter_bps_hr', label: '开仓费差阈值（每小时 bps，≥ 此值才开）', type: 'num' },
      { key: 'funding_exit_bps_hr', label: '平仓费差阈值（每小时 bps，费差 ≤ 此值即平）', type: 'num' },
      { key: 'funding_symbols', label: '只做这些币种（逗号分隔，如 BTC,ETH,SOL；留空=任意可配对）', placeholder: 'BTC,ETH,SOL' },
      { key: 'funding_max_positions', label: '资金费仓位上限（同时最多持有）', type: 'num' },
      { key: 'funding_max_hold_hours', label: '最长持仓小时数（安全上限，到点强制平仓）', type: 'num' },
      { key: 'funding_min_hold_hours', label: '最短持仓小时数（开仓后至少持有，避免被噪声秒平）', type: 'num' },
      { key: 'funding_exit_confirm_hours', label: '出场确认时长（费差需持续低于阈值这么久才平，去抖动）', type: 'num' },
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

/* ---------------- Funding (资金费套利 · 路线 A 主引擎) ---------------- */

function Funding() {
  const client = useQueryClient()
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['funding'],
    queryFn: () => fetch(api('monitor/funding')).then((r) => r.json()),
    refetchInterval: 30000,
  })
  const scan = useQuery({
    queryKey: ['scan-lite'],
    queryFn: () => fetch(api('monitor/scan?limit=30')).then((r) => r.json()),
    refetchInterval: 15000,
    staleTime: 10000,
  })
  const open = useMutation({
    mutationFn: (symbol: string) =>
      fetch(api('monitor/funding/open'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      }).then((r) => r.json()),
    onSuccess: (r) => {
      if (r?.error) alert(`开仓未成功：${r.error}`)
      client.invalidateQueries({ queryKey: ['tasks'] })
      client.invalidateQueries({ queryKey: ['funding'] })
    },
    onError: (e: any) => alert(`开仓请求失败：${String(e?.message || e)}`),
  })

  if (isLoading) return <Loading label="正在读取两所资金费率…" />
  if (error || data?.error) return <ErrorBox msg={data?.error || String(error)} />
  const rows = (data?.rows || []) as any[]
  const best = rows[0]
  const enter = Number(data?.enter_bps_hr ?? 0)
  const exit = Number(data?.exit_bps_hr ?? 0)
  const live = !!scan.data?.live_ready
  const dryRun = scan.data?.dry_run !== false

  const onOpen = (r: any) => {
    const mode = live && !dryRun ? '⚠️ 实盘真实下单' : '模拟（DRY_RUN，不动真钱）'
    const msg = `确认对 ${r.symbol} 建立资金费对冲仓位？\n\n做空 ${r.short_venue} · 做多 ${r.long_venue}\n当前费差 ${fmt(r.diff_bps_hr, 2)} bps/时\n\n执行模式：${mode}`
    if (window.confirm(msg)) open.mutate(r.symbol)
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-[#eff6ff] border border-[#bfdbfe] px-4 py-3 text-[13px] text-[#1e40af]">
        <div className="font-medium">资金费套利（carry）· 路线 A 主引擎</div>
        <div className="text-[#3b5b9a] mt-1 leading-relaxed">
          永续每 <b>1 小时</b>结算资金费（正值=多头付空头）。两所同币费率不同 →
          <b>在费率高的一边做空（收费）、低的一边做多（少付/收费）</b>，仓位对冲不吃价格方向，靠费差慢慢累积。
          <b>持仓吃费、费差收敛（≤ 平仓阈值）才平仓</b>，低频少折腾。下面点「开仓」手动建仓，或在设置里打开「自动执行」。
        </div>
      </div>

      {/* 执行状态条 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-white border border-[#e5e5e5] rounded-lg px-4 py-3 text-[12px]">
        <span className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${live && !dryRun ? 'bg-red-500' : 'bg-gray-300'}`} />
          <span className="font-medium text-[13px]">{live && !dryRun ? '实盘模式' : '模拟模式（DRY_RUN）'}</span>
        </span>
        <HealthItem label="开仓阈值" value={`≥ ${fmt(enter, 2)} bps/时`} />
        <HealthItem label="平仓阈值" value={`≤ ${fmt(exit, 2)} bps/时`} />
        <HealthItem label="自动执行" value={data?.funding_auto_execute ? '开启' : '关闭（手动）'} warn={!data?.funding_auto_execute ? false : false} />
        {data?.venue_errors?.length ? <span className="text-amber-600 truncate max-w-[320px]" title={data.venue_errors.join(' | ')}>部分源异常：{data.venue_errors.join(' | ')}</span> : null}
        {data?.venue_warnings?.length ? <span className="text-[#c98a00] truncate max-w-[320px]" title={data.venue_warnings.join(' | ')}>限流·暂用缓存：{data.venue_warnings.join(' | ')}</span> : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniStat label="可配对币种" value={data?.count ?? 0} />
        <MiniStat label="最佳费差 / 时" value={best ? `${fmt(best.diff_bps_hr, 2)} bps` : '-'} tone="green" />
        <MiniStat label="最佳日化" value={best ? `${fmt(best.daily_pct, 3)}%` : '-'} tone="green" />
        <MiniStat label="最佳年化(简单)" value={best ? `${fmt(best.apr_pct, 1)}%` : '-'} tone="green" />
      </div>

      <AccountOverview />

      <FundingPositions />

      <FundingIncome />

      <Card
        title="两所资金费差（按每小时费差排序）"
        subtitle={`每 30 秒刷新 · 费率为每小时值 · 达标(≥${fmt(enter, 2)}bps)行高亮 · ${data?.updated_at ? new Date(data.updated_at).toLocaleTimeString() : ''}${isFetching ? ' · 刷新中…' : ''}`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[#999] border-b border-[#eee]">
                <Th>币种</Th>
                <Th right>Lighter (bps/时)</Th>
                <Th right>RBLighter (bps/时)</Th>
                <Th right>费差 (bps/时)</Th>
                <Th>套利方向（对冲）</Th>
                <Th right>日化</Th>
                <Th right>年化(简单)</Th>
                <Th right>操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className={`border-b border-[#f3f3f3] ${r.tradeable ? 'bg-[#f0fdf4]' : ''}`}>
                  <Td className="font-medium">{r.symbol}</Td>
                  <Td right mono className={r.lighter_bps_hr >= 0 ? 'text-[#555]' : 'text-red-500'}>{fmt(r.lighter_bps_hr, 2)}</Td>
                  <Td right mono className={r.rblighter_bps_hr >= 0 ? 'text-[#555]' : 'text-red-500'}>{fmt(r.rblighter_bps_hr, 2)}</Td>
                  <Td right mono className="text-emerald-600 font-medium">{fmt(r.diff_bps_hr, 2)}</Td>
                  <Td>
                    <span className="text-red-500">做空 {r.short_venue}</span>
                    <span className="text-[#bbb]"> · </span>
                    <span className="text-emerald-600">做多 {r.long_venue}</span>
                  </Td>
                  <Td right mono>{fmt(r.daily_pct, 3)}%</Td>
                  <Td right mono>{fmt(r.apr_pct, 1)}%</Td>
                  <Td right>
                    <button
                      onClick={() => onOpen(r)}
                      disabled={open.isPending}
                      className={`px-2.5 py-0.5 rounded border text-[12px] disabled:opacity-40 ${
                        r.tradeable
                          ? 'bg-[#16a34a] text-white border-[#16a34a] hover:bg-[#15803d]'
                          : 'bg-white text-[#555] border-[#ddd] hover:border-[#999]'
                      }`}
                      title={r.tradeable ? '费差达标，建议开仓' : '费差未达开仓阈值，仍可手动开'}
                    >
                      开仓
                    </button>
                  </Td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={8} className="py-6 text-center text-[#999]">暂无数据（可能两所暂未返回资金费）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="text-[12px] text-[#999] leading-relaxed">
        风险提示：① 资金费每小时会变，费差可能收窄甚至反向，持仓期间引擎会持续监控、费差 ≤ 平仓阈值即自动平仓；
        ② 年化为简单外推（费差 × 24 × 365），并非锁定收益；③ 建仓/平仓各有一次跨价+手续费成本，费差需覆盖开平两次成本才净赚，
        故开仓阈值应明显高于平仓阈值；④ 模拟模式下「开仓」只写模拟仓位，不动真钱；实盘模式请先小额单币验证。
      </div>
    </div>
  )
}

// Real account overview: both venues' balances + current trading P&L (unrealized
// + realized from open positions), combined with funding into a true P&L picture.
// Only shows when the signing sidecar is configured (needs authed account read).
function AccountOverview() {
  const acct = useQuery({
    queryKey: ['accounts'],
    queryFn: () => fetch(api('accounts')).then((r) => r.json()),
    refetchInterval: 15000,
  })
  const income = useQuery({
    queryKey: ['funding-income'],
    queryFn: () => fetch(api('funding-income')).then((r) => r.json()),
    refetchInterval: 20000,
  })
  const d = acct.data
  if (!d || d.configured === false) return null // 未配置边车则隐藏（资金费面板已给出提示）

  const money = (n: number) => `${n >= 0 ? '+' : ''}${(Number(n) || 0).toFixed(4)} USD`
  const bal = (n: number) => `${(Number(n) || 0).toFixed(2)} USD`
  const tone = (n: number) => (n > 0 ? 'text-emerald-600' : n < 0 ? 'text-red-500' : 'text-[#888]')

  if (d.ok === false) {
    return (
      <Card title="真实盈亏总览（账户实时）" subtitle="读取两所账户余额与持仓盈亏">
        <div className="py-3 text-[13px] text-amber-600">账户读取失败：{d.error || '边车未就绪'}</div>
      </Card>
    )
  }

  const inc = income.data
  const fundingBy =
    inc?.source === 'account'
      ? { lighter: Number(inc.lighter_total_usd) || 0, rblighter: Number(inc.rblighter_total_usd) || 0 }
      : null
  const fundingTotal = fundingBy ? fundingBy.lighter + fundingBy.rblighter : null
  const equity = Number(d.total_equity_usd) || 0
  const tradePnl = Number(d.total_trading_pnl_usd) || 0
  const combined = fundingTotal == null ? null : tradePnl + fundingTotal
  const eqs = d.equity_summary || null
  const netStart = eqs && eqs.net_since_start_usd != null ? Number(eqs.net_since_start_usd) : null
  const net24 = eqs && eqs.net_24h_usd != null ? Number(eqs.net_24h_usd) : null

  const venues = [
    { key: 'lighter' as const, name: 'Lighter', v: d.lighter },
    { key: 'rblighter' as const, name: 'RBLighter', v: d.rblighter },
  ]

  return (
    <Card
      title="真实盈亏总览（账户实时）"
      subtitle={`两所账户余额 + 当前持仓交易盈亏（未实现+已实现）+ 资金费累计 = 真实综合盈亏。每 15 秒刷新。${d.dry_run ? ' · 边车 DRY_RUN' : ''}`}
    >
      <div className="mb-4 rounded-lg border border-[#e6e6e6] bg-[#fafafa] p-3">
        <div className="text-[12px] font-medium text-[#666] mb-2">
          真实净盈亏（账户余额变化 · 唯一不说谎的数字）
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MiniStat
            label="开机以来净盈亏"
            value={netStart == null ? '等待基线…' : money(netStart)}
            tone={netStart == null ? undefined : netStart >= 0 ? 'green' : 'red'}
          />
          <MiniStat
            label="近 24 小时净盈亏"
            value={net24 == null ? '不足 24 小时' : money(net24)}
            tone={net24 == null ? undefined : net24 >= 0 ? 'green' : 'red'}
          />
          <MiniStat
            label="基线权益"
            value={eqs && eqs.baseline_equity != null ? bal(Number(eqs.baseline_equity)) : '—'}
          />
        </div>
        <div className="mt-2 text-[11px] text-[#999] leading-relaxed">
          此处直接对比两所「账户总权益」的首次快照与当前快照，差额即真实净盈亏（含交易价差、滑点、资金费、一切）。
          面板上方「交易盈亏」在仓位完全平掉后会归零、看起来常绿，但余额变化不会——以此列为准。
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MiniStat label="账户总权益（两所）" value={bal(equity)} />
        <MiniStat label="交易盈亏（未实现+已实现）" value={money(tradePnl)} tone={tradePnl >= 0 ? 'green' : 'red'} />
        <MiniStat label="资金费累计" value={fundingTotal == null ? '—' : money(fundingTotal)} tone={fundingTotal == null ? undefined : fundingTotal >= 0 ? 'green' : 'red'} />
        <MiniStat label="综合盈亏（交易+资金费）" value={combined == null ? '—' : money(combined)} tone={combined == null ? undefined : combined >= 0 ? 'green' : 'red'} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[#999] border-b border-[#eee]">
              <Th>交易所</Th><Th right>总权益</Th><Th right>可用余额</Th><Th right>保证金</Th>
              <Th right>未实现盈亏</Th><Th right>已实现盈亏</Th><Th right>资金费累计</Th><Th right>综合盈亏</Th><Th right>持仓数</Th>
            </tr>
          </thead>
          <tbody>
            {venues.map(({ key, name, v }) => {
              if (!v || v.ok === false) {
                return (
                  <tr key={key} className="border-b border-[#f3f3f3]">
                    <Td className="font-medium">{name}</Td>
                    <td colSpan={8} className="py-2 text-amber-600 text-[13px]">{v?.error || '未就绪'}</td>
                  </tr>
                )
              }
              const fund = fundingBy ? fundingBy[key] : null
              const comb = fund == null ? Number(v.trading_pnl) || 0 : (Number(v.trading_pnl) || 0) + fund
              return (
                <tr key={key} className="border-b border-[#f3f3f3]">
                  <Td className="font-medium">{name}</Td>
                  <Td right mono>{bal(v.total_asset_value)}</Td>
                  <Td right mono>{bal(v.available_balance)}</Td>
                  <Td right mono>{bal(v.collateral)}</Td>
                  <Td right mono className={tone(Number(v.unrealized_pnl) || 0)}>{money(Number(v.unrealized_pnl) || 0)}</Td>
                  <Td right mono className={tone(Number(v.realized_pnl) || 0)}>{money(Number(v.realized_pnl) || 0)}</Td>
                  <Td right mono className={fund == null ? 'text-[#bbb]' : tone(fund)}>{fund == null ? '—' : money(fund)}</Td>
                  <Td right mono className={tone(comb)}>{money(comb)}</Td>
                  <Td right mono>{v.open_positions}</Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-[12px] text-[#999] leading-relaxed">
        说明：①「交易盈亏」为当前持仓的未实现+已实现盈亏（价格/基差口径，来自交易所账户，实时）；已完全平掉的历史仓位其价差盈亏交易所不再单列，故此列偏重反映当前在场仓位；
        ②「资金费累计」来自账户真实结算（最近 {inc?.days ?? 30} 天）；③「综合盈亏」=「交易盈亏」+「资金费累计」，是当前最接近真实的盈亏画像；④「总权益」为账户当前净值，受入金/出金影响。
      </div>
    </Card>
  )
}

// Real accumulated funding income. Prefers the exchange account's OWN funding
// settlements (via the signing sidecar — same data as the venue CSV export, all
// history), and falls back to the engine-recorded ledger when the sidecar isn't
// configured. Either way: this is funding money only, never price/basis PnL.
function FundingIncome() {
  const { data } = useQuery({
    queryKey: ['funding-income'],
    queryFn: () => fetch(api('funding-income')).then((r) => r.json()),
    refetchInterval: 20000,
  })
  const money = (n: number) => `${n >= 0 ? '+' : ''}${(Number(n) || 0).toFixed(4)} USD`
  const tone = (n: number) => (n > 0 ? 'text-emerald-600' : n < 0 ? 'text-red-500' : 'text-[#888]')
  const source = data?.source

  // ---- Real per-account settlements (via sidecar) ----
  if (source === 'account') {
    const grand = Number(data?.grand_total_usd) || 0
    const lTot = Number(data?.lighter_total_usd) || 0
    const rTot = Number(data?.rblighter_total_usd) || 0
    const settlements = Number(data?.settlements) || 0
    const bySymbol = (data?.by_symbol || []) as any[]
    const recent = (data?.recent || []) as any[]
    return (
      <Card
        title="真实资金费累计（账户结算）"
        subtitle={`直接读取两所账户的真实资金费结算记录（与你导出的 CSV 一致），覆盖最近 ${data?.days ?? 30} 天全部历史。每 20 秒刷新，无需再导 CSV。`}
      >
        {data?.venue_errors?.length ? (
          <div className="mb-3 text-[12px] text-amber-600">{data.venue_errors.join(' · ')}</div>
        ) : null}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <MiniStat label="资金费合计（两所净）" value={money(grand)} tone={grand >= 0 ? 'green' : 'red'} />
          <MiniStat label="Lighter 侧" value={money(lTot)} tone={lTot >= 0 ? 'green' : 'red'} />
          <MiniStat label="RBLighter 侧" value={money(rTot)} tone={rTot >= 0 ? 'green' : 'red'} />
          <MiniStat label="结算笔数" value={settlements} />
        </div>
        {bySymbol.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[#999] border-b border-[#eee]">
                  <Th>币种</Th><Th right>Lighter(USD)</Th><Th right>RBLighter(USD)</Th>
                  <Th right>合计(USD)</Th><Th right>结算笔数</Th>
                </tr>
              </thead>
              <tbody>
                {bySymbol.map((s) => (
                  <tr key={s.symbol} className="border-b border-[#f3f3f3]">
                    <Td className="font-medium">{s.symbol}</Td>
                    <Td right mono className={tone(Number(s.lighter) || 0)}>{money(Number(s.lighter) || 0)}</Td>
                    <Td right mono className={tone(Number(s.rblighter) || 0)}>{money(Number(s.rblighter) || 0)}</Td>
                    <Td right mono className={tone(Number(s.total) || 0)}>{money(Number(s.total) || 0)}</Td>
                    <Td right mono>{s.count}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-4 text-[13px] text-[#999]">最近 {data?.days ?? 30} 天暂无资金费结算记录。</div>
        )}
        {recent.length ? (
          <details className="mt-3">
            <summary className="text-[12px] text-[#666] cursor-pointer select-none">展开最近 {recent.length} 笔结算明细</summary>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[#999] border-b border-[#eee]">
                    <Th>时间</Th><Th>交易所</Th><Th>币种</Th><Th>方向</Th><Th right>资金费(USD)</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((f, i) => (
                    <tr key={i} className="border-b border-[#f6f6f6]">
                      <Td className="text-[#888]">{f.timestamp ? new Date(f.timestamp * 1000).toLocaleString() : '-'}</Td>
                      <Td>{f.venue}</Td>
                      <Td className="font-medium">{f.symbol}</Td>
                      <Td>{f.side === 'long' ? <span className="text-emerald-600">多</span> : f.side === 'short' ? <span className="text-red-500">空</span> : '-'}</Td>
                      <Td right mono className={tone(Number(f.change) || 0)}>{money(Number(f.change) || 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
        <div className="mt-3 text-[12px] text-[#999] leading-relaxed">
          说明：只统计<b>资金费</b>本身（账户真实结算，进账为正/倒付为负），<b>不含</b>开平仓的价差与滑点盈亏。要看含价差的整体盈亏，请看上方「资金费对冲持仓」的盈亏列。
        </div>
      </Card>
    )
  }

  // ---- Fallback: engine ledger (forward-only, sidecar 未配置) ----
  const positions = (data?.positions || []) as any[]
  const grand = Number(data?.grand_total_usd) || 0
  const openTot = Number(data?.open_total_usd) || 0
  const closedTot = Number(data?.closed_total_usd) || 0
  const settlements = Number(data?.settlements) || 0

  return (
    <Card
      title="真实资金费累计"
      subtitle="引擎在每个整点结算时，按当时实时费差 × 名义金额逐笔累加的资金费（不含价差盈亏）。配置签名边车后，将自动改为读取账户真实结算记录（含全部历史）。"
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MiniStat label="累计资金费（全部）" value={money(grand)} tone={grand >= 0 ? 'green' : 'red'} />
        <MiniStat label="持仓中累计" value={money(openTot)} tone={openTot >= 0 ? 'green' : 'red'} />
        <MiniStat label="已平仓累计" value={money(closedTot)} tone={closedTot >= 0 ? 'green' : 'red'} />
        <MiniStat label="结算次数（小时）" value={settlements} />
      </div>
      {positions.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[#999] border-b border-[#eee]">
                <Th>币种</Th><Th>方向（对冲）</Th><Th right>名义(USD)</Th><Th right>结算次数</Th>
                <Th right>均费差(bps/时)</Th><Th right>累计资金费(USD)</Th><Th>状态</Th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.task_id} className="border-b border-[#f3f3f3]">
                  <Td className="font-medium">{p.symbol}</Td>
                  <Td>
                    <span className="text-red-500">空 {p.short_venue}</span>
                    <span className="text-[#bbb]"> · </span>
                    <span className="text-emerald-600">多 {p.long_venue}</span>
                  </Td>
                  <Td right mono>{Number(p.notional_usd || 0).toFixed(2)}</Td>
                  <Td right mono>{p.settlements}</Td>
                  <Td right mono className={tone(Number(p.avg_bps_hr) || 0)}>{fmt(p.avg_bps_hr, 2)}</Td>
                  <Td right mono className={tone(Number(p.total_usd) || 0)}>{money(Number(p.total_usd) || 0)}</Td>
                  <Td>{p.is_open ? <Badge tone="green">持仓中</Badge> : <Badge tone="gray">已平仓</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="py-4 text-[13px] text-[#999] leading-relaxed">
          暂无结算记录。配置签名边车（sidecar）后，这里会直接显示账户真实资金费（含全部历史）；未配置时仅从本功能上线后、且持仓跨过整点才逐笔累加。
        </div>
      )}
      <div className="mt-3 text-[12px] text-[#999] leading-relaxed">
        说明：此处只统计<b>资金费</b>本身（真金白银进账/倒付），不含开平仓的价差与滑点盈亏。要看含价差的整体盈亏，请看上方「资金费对冲持仓」的盈亏列。
      </div>
    </Card>
  )
}

// Active funding-carry positions (reuses /tasks, filtered to strategy='funding').
// Active positions always shown in full; finished ones (CLOSED/ERROR) are paged so
// the panel stays short as history accumulates.
function FundingPositions() {
  const client = useQueryClient()
  const [page, setPage] = useState(0)
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
  const all = (data?.tasks || []) as any[]
  const tasks = all.filter((t) => t.strategy === 'funding')
  if (!tasks.length) return null
  const active = tasks.filter((t) => ACTIVE.includes(t.state))
  const history = tasks.filter((t) => !ACTIVE.includes(t.state))
  const perPage = 8
  const pageCount = Math.max(1, Math.ceil(history.length / perPage))
  const cur = Math.min(page, pageCount - 1)
  const shown = history.slice(cur * perPage, cur * perPage + perPage)

  const row = (t: any) => {
    const meta = STATE_META[t.state] || { label: t.state, tone: 'light' as const }
    const isActive = ACTIVE.includes(t.state)
    return (
      <tr key={t.id} className="border-b border-[#f3f3f3]">
        <Td className="font-medium">{t.symbol}{t.exec_mode === 'live' ? <span className="ml-1 text-[10px] text-red-500">实盘</span> : <span className="ml-1 text-[10px] text-[#bbb]">模拟</span>}</Td>
        <Td><span className="text-emerald-600">多 {t.buy_venue}</span><span className="text-[#bbb]"> · </span><span className="text-red-500">空 {t.sell_venue}</span></Td>
        <Td right mono>{t.matched_size ? Number(t.matched_size).toFixed(4) : '-'}</Td>
        <Td right mono className="text-emerald-600">{t.entry_funding_bps_hr == null ? '-' : fmt(t.entry_funding_bps_hr, 2)}</Td>
        <Td right mono className={t.pnl_usd == null ? '' : t.pnl_usd >= 0 ? 'text-emerald-600' : 'text-red-500'}>
          {t.pnl_usd == null ? '-' : Number(t.pnl_usd).toFixed(3)}
        </Td>
        <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
        <Td className="text-[#888] max-w-[420px] whitespace-normal break-words leading-snug align-top" title={t.note}>{t.note}</Td>
        <Td right>
          {isActive ? (
            <div className="flex gap-1 justify-end">
              {(t.state === 'HOLDING' || t.state === 'PAUSED') && (
                <MiniBtn onClick={() => act.mutate({ id: t.id, op: 'close' })}>平仓</MiniBtn>
              )}
              {t.state === 'PAUSED' && (
                <MiniBtn onClick={() => act.mutate({ id: t.id, op: 'resume' })}>恢复</MiniBtn>
              )}
            </div>
          ) : (
            <span className="text-[#ccc]">—</span>
          )}
        </Td>
      </tr>
    )
  }

  const header = (
    <tr className="text-left text-[#999] border-b border-[#eee]">
      <Th>币种</Th><Th>方向</Th><Th right>撮合量</Th><Th right>入场费差(bps/时)</Th>
      <Th right>盈亏(USD)</Th><Th>状态</Th><Th>说明</Th><Th right>操作</Th>
    </tr>
  )

  return (
    <Card title="资金费对冲持仓" subtitle="做多低费一边 + 做空高费一边，持仓吃费；费差收敛或到最长持仓即自动平仓。可手动平仓。持仓中优先显示，历史记录翻页查看。">
      {active.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>{header}</thead>
            <tbody>{active.map(row)}</tbody>
          </table>
        </div>
      ) : (
        <div className="py-3 text-[13px] text-[#999]">当前无持仓中的对冲仓位。</div>
      )}

      {history.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] text-[#999]">历史记录（已平仓 / 作废）· 共 {history.length} 条</div>
            <MiniBtn onClick={() => clearHistory.mutate()}>清空历史记录</MiniBtn>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>{header}</thead>
              <tbody>{shown.map(row)}</tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-end gap-2 mt-3 text-[12px]">
              <button
                onClick={() => setPage(Math.max(0, cur - 1))}
                disabled={cur === 0}
                className="px-2.5 py-1 rounded border border-[#ddd] bg-white hover:border-[#999] disabled:opacity-40"
              >上一页</button>
              <span className="text-[#999]">第 {cur + 1} / {pageCount} 页</span>
              <button
                onClick={() => setPage(Math.min(pageCount - 1, cur + 1))}
                disabled={cur >= pageCount - 1}
                className="px-2.5 py-1 rounded border border-[#ddd] bg-white hover:border-[#999] disabled:opacity-40"
              >下一页</button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

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

  // 稳健推荐：只做流动性好的深盘口币，门槛留足缓冲，杜绝小盘薄盘口滑点。
  // 载入后只写入表单，用户可再改，确认后再点“保存设置”才会生效。
  const STABLE_PRESET: Record<string, any> = {
    scan_symbols: 'SOL,ETH,BTC', // 只扫这三个深盘口币，彻底剔除小盘
    focus_symbol: '', // 三个都可开，靠“同时最多持有仓位数=1”控制单仓
    max_concurrent_tasks: 1,
    min_depth_ratio: 5, // 盘口量需 ≥ 5× 下单量，撑不住就不开
    spread_threshold_bps: 8, // 入场门槛抬高：只吃明显价差
    exit_spread_bps: 1, // 平仓收敛阈值压低：与入场留出 ~7bps 缓冲
    max_slippage_bps: 3,
    min_samples: 15, // 白名单后每轮 1-2s，样本很快满
    max_hold_ticks: 25,
    maker_close: true, // 挂单平仓，不吃对手价，少一份滑点
    maker_open: false, // 开仓仍用 taker，确保出现价差时真能建到仓
    order_notional_usd: 50,
  }
  const loadPreset = () => {
    setForm((f) => ({ ...f, ...STABLE_PRESET }))
  }

  // 美股代币资金费预设：周末/盘后代币化美股费差极大（CRCL/COIN/TSLA…）。
  // 只把高费差美股代币拉进白名单、门槛抬到 ≥10bps/时、小额 20U 手动验证，
  // 自动执行保持关闭。载入后只填表单，确认无误再点「保存设置」才生效。
  const FUNDING_STOCK_PRESET: Record<string, any> = {
    funding_symbols: 'CRCL,COIN,CRWV,BE,TSLA,AMD,AAPL,AMZN,MSFT,INTC,MU,PLTR',
    funding_enter_bps_hr: 10, // 只在费差 ≥ 10bps/时才高亮/可开
    funding_exit_bps_hr: 2, // 费差收敛到 2 以内且已覆盖成本才平
    funding_min_hold_hours: 2, // 开仓后至少持 2 小时，避免被噪声秒平
    funding_exit_confirm_hours: 2, // 费差需持续低于阈值 2 小时才平，去抖动
    funding_max_positions: 2, // 验证期最多同时 2 仓
    funding_max_hold_hours: 48, // 周末持仓上限，避免拖到周一开盘 gap
    funding_auto_execute: false, // 关键：保持手动，先验证再谈自动
    maker_open: true, // 先挂后对冲：买腿被动挂单成交后再 taker 对冲，避免单腿裸奔
    order_notional_usd: 20, // 小额试水
  }
  const loadFundingPreset = () => {
    setForm((f) => ({ ...f, ...FUNDING_STOCK_PRESET }))
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <p className="text-[13px] text-[#888]">
        账户凭据与策略配置保存在本地数据库。API 私钥保存后不会回显，重新填写才会覆盖。
      </p>
      <div className="flex items-center justify-between gap-3 flex-wrap bg-[#f0fdf4] border border-[#bbf7d0] rounded-lg px-4 py-3">
        <div className="text-[13px] text-[#166534]">
          <div className="font-medium">稳健推荐配置（SOL / ETH / BTC · 深盘口 · 门槛留缓冲）</div>
          <div className="text-[#3f7a52] mt-0.5">只做流动性好的币、门槛抬高只吃明显价差，杜绝小盘薄盘口滑点。点击仅填入表单，你可再改，确认后再点「保存设置」才生效。</div>
        </div>
        <button
          type="button"
          onClick={loadPreset}
          className="px-4 py-2 rounded-md bg-[#16a34a] text-white text-[13px] font-medium whitespace-nowrap hover:bg-[#15803d]"
        >
          载入稳健推荐
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap bg-[#eff6ff] border border-[#bfdbfe] rounded-lg px-4 py-3">
        <div className="text-[13px] text-[#1e40af]">
          <div className="font-medium">美股代币资金费预设（CRCL / COIN / TSLA… · 高费差窗口）</div>
          <div className="text-[#3b5b9a] mt-0.5">周末/盘后代币化美股费差极大。一键填入：高费差美股白名单、开仓门槛 ≥10bps/时、单笔 20U、自动执行保持关闭。⚠️ 高息=高风险（周一开盘 gap、两所脱钩、薄盘口滑点），先小额手动验证一次结算真到账再谈放大。点击仅填表单，确认后再点「保存设置」才生效。</div>
        </div>
        <button
          type="button"
          onClick={loadFundingPreset}
          className="px-4 py-2 rounded-md bg-[#2563eb] text-white text-[13px] font-medium whitespace-nowrap hover:bg-[#1d4ed8]"
        >
          载入美股代币预设
        </button>
      </div>
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

