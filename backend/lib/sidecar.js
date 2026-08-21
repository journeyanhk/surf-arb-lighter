// Node → Python 执行边车（sidecar）的桥接层。
// 边车用官方 lighter-sdk 做真实签名/下单，本文件只负责通过 localhost HTTP 调它。
//
// 环境变量：
//   ARB_SIDECAR_URL    默认 http://127.0.0.1:8787
//   ARB_SIDECAR_TOKEN  与边车 SIDECAR_TOKEN 一致的共享密钥（缺省则视为“未启用实盘”）
//
// 关键：任何函数都不会把异常抛进引擎主循环——失败一律返回 {ok:false,error}，
// 让引擎能安全回退到模拟，绝不因为边车不可用而中断后台任务。

const BASE = process.env.ARB_SIDECAR_URL || 'http://127.0.0.1:8787'
const TOKEN = process.env.ARB_SIDECAR_TOKEN || ''

// 是否配置了边车（有 token 才认为用户打算接实盘）。
function configured() {
  return !!TOKEN
}

async function call(path, { method = 'GET', body, timeoutMs = 12000 } = {}) {
  if (!TOKEN) return { ok: false, error: 'sidecar 未配置（缺 ARB_SIDECAR_TOKEN）' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'X-Sidecar-Token': TOKEN,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: j.error || `HTTP ${r.status}`, ...j }
    return j
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  } finally {
    clearTimeout(t)
  }
}

// 边车健康：两个 venue 是否就绪、是否 DRY_RUN、单笔上限。
async function health() {
  return call('/health', { timeoutMs: 6000 })
}

// 下一条订单。venue: 'lighter'|'rblighter'，side: 'buy'|'sell'。
// tif: 'ioc'(默认,吃单) | 'post_only'(maker挂单,0手续费) | 'gtt'。
// size/price 传人类可读浮点，边车按市场精度缩放成整数。
async function placeOrder({ venue, market_index, side, size, price, reduce_only = false, client_order_index = 0, tif = 'ioc' }) {
  return call('/order', {
    method: 'POST',
    body: { venue, market_index, side, size, price, reduce_only, client_order_index, tif },
    timeoutMs: 15000,
  })
}

// 查真实持仓，返回 {market_id: signed_size}，用于对账 / 计算成交量。
async function positions(venue) {
  const j = await call(`/positions?venue=${encodeURIComponent(venue)}`, { timeoutMs: 10000 })
  return j.ok ? j.positions || {} : null
}

module.exports = { configured, health, placeOrder, positions }
