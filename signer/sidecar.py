# -*- coding: utf-8 -*-
#
# Lighter / RBLighter 实盘执行边车（sidecar）
# =================================================
# 这是接实盘的核心。用官方 lighter-sdk 起两个 SignerClient（Lighter + RBLighter），
# 对外只暴露 localhost 内网接口，供 Node 后端调用来下真实 IOC 订单、查真实持仓。
#
# 安全设计（务必理解）：
#   1. 只监听 127.0.0.1，绝不对公网开放。
#   2. 每个请求必须带 X-Sidecar-Token（与 Node 端共享的密钥），否则拒绝。
#   3. 默认 DRY_RUN=true —— 只签名不发送，零资金风险。要真实下单必须显式设
#      SIDECAR_DRY_RUN=false。
#   4. 单笔名义额上限 SIDECAR_MAX_NOTIONAL_USD，超过直接拒绝。
#   5. base_amount / price 由本进程按市场精度缩放成整数，Node 端只传人类可读的
#      浮点数量/价格，缩放集中在一处，避免各处填错精度。
#
# 依赖：见 requirements.txt（lighter-sdk, aiohttp）。只能装在 Linux x86_64。
#
# 环境变量：
#   SIDECAR_HOST                默认 127.0.0.1
#   SIDECAR_PORT                默认 8787
#   SIDECAR_TOKEN               必填，与 Node 端 ARB_SIDECAR_TOKEN 一致
#   SIDECAR_DRY_RUN             默认 true（true=只签名不发送）
#   SIDECAR_MAX_NOTIONAL_USD    默认 100，单笔名义额上限
#   LIGHTER_BASE_URL / LIGHTER_ACCOUNT_INDEX / LIGHTER_API_KEY_INDEX / LIGHTER_API_PRIVATE_KEY [/ LIGHTER_CHAIN_ID]
#   RBLIGHTER_BASE_URL / RBLIGHTER_ACCOUNT_INDEX / RBLIGHTER_API_KEY_INDEX / RBLIGHTER_API_PRIVATE_KEY [/ RBLIGHTER_CHAIN_ID]

import os
import sys
import asyncio
import logging

import aiohttp
from aiohttp import web

try:
    import lighter
except ImportError:
    print("缺少依赖：请先 pip install -r requirements.txt (lighter-sdk)")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [sidecar] %(message)s")
log = logging.getLogger("sidecar")


def env(name, default=None):
    v = os.environ.get(name, default)
    return v.strip() if isinstance(v, str) else v


def env_bool(name, default):
    v = env(name)
    if v is None:
        return default
    return str(v).lower() in ("1", "true", "yes", "on")


DRY_RUN = env_bool("SIDECAR_DRY_RUN", True)
MAX_NOTIONAL_USD = float(env("SIDECAR_MAX_NOTIONAL_USD", "100") or 100)
TOKEN = env("SIDECAR_TOKEN", "")


class Venue:
    """封装一个交易所：官方 SignerClient + 市场精度元数据。"""

    def __init__(self, name, base_url, account_index, api_key_index, private_key, chain_id):
        self.name = name
        self.base_url = base_url
        self.account_index = int(account_index) if account_index not in (None, "") else None
        self.api_key_index = int(api_key_index) if api_key_index not in (None, "") else None
        self.private_key = private_key
        self.chain_id = int(chain_id) if chain_id not in (None, "") else None
        self.client = None          # lighter.SignerClient
        self.ready = False
        self.err = None
        self.markets = {}           # market_id -> {size_decimals, price_decimals, min_base_amount}

    @property
    def configured(self):
        return bool(
            self.base_url and self.private_key
            and self.account_index is not None and self.api_key_index is not None
        )

    async def init(self):
        if not self.configured:
            self.err = "配置不完整（缺 base_url/account_index/api_key_index/private_key）"
            return
        try:
            kwargs = dict(
                url=self.base_url,
                account_index=self.account_index,
                api_private_keys={self.api_key_index: self.private_key},
            )
            if self.chain_id:
                kwargs["chain_id"] = self.chain_id
            self.client = lighter.SignerClient(**kwargs)
            err = self.client.check_client()
            if err is not None:
                self.err = f"check_client: {err}"
                self.ready = False
            else:
                self.ready = True
                self.err = None
                log.info("%s: SignerClient 就绪", self.name)
        except Exception as e:  # noqa
            self.err = f"init 失败: {e}"
            self.ready = False
        await self.load_markets()

    async def load_markets(self):
        """拉取每个市场的精度与最小下单量，用于把浮点数量/价格缩放成整数。"""
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.get(f"{self.base_url}/api/v1/orderBooks", timeout=15) as r:
                    j = await r.json()
            for ob in (j.get("order_books") or []):
                mid = ob.get("market_id")
                if mid is None:
                    continue
                self.markets[int(mid)] = {
                    "symbol": ob.get("symbol"),
                    "size_decimals": int(ob.get("supported_size_decimals", 0)),
                    "price_decimals": int(ob.get("supported_price_decimals", 0)),
                    "min_base_amount": float(ob.get("min_base_amount", 0) or 0),
                }
            log.info("%s: 载入 %d 个市场精度", self.name, len(self.markets))
        except Exception as e:  # noqa
            log.warning("%s: 载入市场精度失败: %s", self.name, e)

    def scale(self, market_index, size, price):
        """把人类可读的 size/price 缩放成 SDK 需要的整数。返回 (base_int, price_int, meta)。"""
        meta = self.markets.get(int(market_index))
        if not meta:
            raise ValueError(f"未知市场 {market_index}（元数据未载入）")
        if size < meta["min_base_amount"]:
            raise ValueError(
                f"下单量 {size} 小于最小下单量 {meta['min_base_amount']}（市场 {market_index}）"
            )
        base_int = int(round(size * (10 ** meta["size_decimals"])))
        price_int = int(round(price * (10 ** meta["price_decimals"])))
        if base_int <= 0 or price_int <= 0:
            raise ValueError(f"缩放后非正数 base={base_int} price={price_int}")
        return base_int, price_int, meta

    async def positions(self):
        """查真实持仓（公开账户接口，用于对账）。返回 {market_id: signed_size}。"""
        j = await self._account_json()
        out = {}
        for acc in (j.get("accounts") or []):
            for p in (acc.get("positions") or []):
                mid = p.get("market_id")
                if mid is None:
                    continue
                # position 为无符号数量字符串；方向由 sign 决定：1=多, -1=空。
                size = float(p.get("position", p.get("size", 0)) or 0)
                sign = p.get("sign", p.get("side", 1))
                try:
                    sign = int(sign)
                except Exception:  # noqa
                    sign = 1
                signed = size if sign >= 0 else -size
                out[int(mid)] = signed
        return out

    async def _account_json(self):
        url = f"{self.base_url}/api/v1/account?by=index&value={self.account_index}"
        async with aiohttp.ClientSession() as sess:
            async with sess.get(url, timeout=15) as r:
                return await r.json()

    async def account_snapshot(self):
        """账户资金/状态快照——用于排查“提交成功却没成交/没持仓”：多半是没保证金或 account_index 指错。
        同时汇总当前持仓的未实现/已实现盈亏（交易盈亏，不含资金费），供面板显示真实盈亏。"""
        def _f(x):
            try:
                return float(x)
            except Exception:  # noqa
                return 0.0
        try:
            j = await self._account_json()
            acc = (j.get("accounts") or [{}])[0]
            positions = acc.get("positions") or []
            upnl = 0.0
            rpnl = 0.0
            open_n = 0
            pos_out = []
            for p in positions:
                size = _f(p.get("position", p.get("size", 0)))
                u = _f(p.get("unrealized_pnl"))
                r = _f(p.get("realized_pnl"))
                upnl += u
                rpnl += r
                if abs(size) > 0:  # 只计入真正有敞口的仓位
                    open_n += 1
                    sign = p.get("sign", 1)
                    try:
                        sign = int(sign)
                    except Exception:  # noqa
                        sign = 1
                    pos_out.append({
                        "symbol": p.get("symbol"),
                        "market_id": p.get("market_id"),
                        "side": "long" if sign >= 0 else "short",
                        "size": size,
                        "value": _f(p.get("position_value")),
                        "avg_entry_price": _f(p.get("avg_entry_price")),
                        "unrealized_pnl": u,
                        "realized_pnl": r,
                    })
            return {
                "account_index": acc.get("account_index", self.account_index),
                "status": acc.get("status"),
                "collateral": _f(acc.get("collateral")),
                "available_balance": _f(acc.get("available_balance")),
                "total_asset_value": _f(acc.get("total_asset_value")),
                "unrealized_pnl": upnl,
                "realized_pnl": rpnl,
                "trading_pnl": upnl + rpnl,   # 交易盈亏合计（当前持仓口径，不含资金费）
                "open_positions": open_n,
                "positions": pos_out,
            }
        except Exception as e:  # noqa
            return {"error": str(e), "account_index": self.account_index}

    async def funding_history(self, start_ts=None, end_ts=None, max_rows=2000):
        """账户真实资金费结算记录（/api/v1/positionFunding，需鉴权）。
        用 SignerClient 生成短期 auth token，分页拉取并映射 market_id→symbol。
        返回 [{timestamp, market_id, symbol, change, rate, position_side}]。"""
        if not self.client:
            raise RuntimeError("client 未就绪")
        auth, err = self.client.create_auth_token_with_expiry()
        if err is not None:
            raise RuntimeError(f"create_auth_token: {err}")
        acct = lighter.AccountApi(self.client.api_client)
        rows = []
        cursor = None
        pages = 0
        while pages < 30 and len(rows) < max_rows:
            pages += 1
            kwargs = dict(account_index=int(self.account_index), limit=100, authorization=auth)
            if cursor:
                kwargs["cursor"] = cursor
            if start_ts:
                kwargs["start_timestamp"] = int(start_ts)
            if end_ts:
                kwargs["end_timestamp"] = int(end_ts)
            res = await acct.position_funding(**kwargs)
            items = getattr(res, "position_fundings", None) or []
            if not items:
                break
            stop = False
            for it in items:
                ts = int(getattr(it, "timestamp", 0) or 0)
                if start_ts and ts < int(start_ts):
                    stop = True
                    break
                mid = int(getattr(it, "market_id", -1))
                meta = self.markets.get(mid) or {}
                rows.append({
                    "timestamp": ts,
                    "market_id": mid,
                    "symbol": meta.get("symbol"),
                    "change": float(getattr(it, "change", 0) or 0),
                    "rate": float(getattr(it, "rate", 0) or 0),
                    "position_side": getattr(it, "position_side", None),
                })
            cursor = getattr(res, "next_cursor", None)
            if stop or not cursor:
                break
        return rows

    async def close(self):
        try:
            if self.client and hasattr(self.client, "close"):
                res = self.client.close()
                if asyncio.iscoroutine(res):
                    await res
        except Exception:  # noqa
            pass


VENUES = {}


def build_venues():
    VENUES["lighter"] = Venue(
        "Lighter",
        env("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai"),
        env("LIGHTER_ACCOUNT_INDEX"),
        env("LIGHTER_API_KEY_INDEX"),
        env("LIGHTER_API_PRIVATE_KEY"),
        env("LIGHTER_CHAIN_ID"),
    )
    VENUES["rblighter"] = Venue(
        "RBLighter",
        env("RBLIGHTER_BASE_URL", "https://api.rh.lighter.xyz"),
        env("RBLIGHTER_ACCOUNT_INDEX"),
        env("RBLIGHTER_API_KEY_INDEX"),
        env("RBLIGHTER_API_PRIVATE_KEY"),
        env("RBLIGHTER_CHAIN_ID"),
    )


def venue_key(v):
    v = (v or "").lower()
    if v in ("lighter", "l"):
        return "lighter"
    if v in ("rblighter", "rb", "r"):
        return "rblighter"
    return None


# ------------------------- HTTP 处理 -------------------------

@web.middleware
async def auth_mw(request, handler):
    if request.path == "/health" and request.method == "GET":
        # health 也要 token，避免裸暴露；但放行 OPTIONS
        pass
    tok = request.headers.get("X-Sidecar-Token", "")
    if not TOKEN or tok != TOKEN:
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    return await handler(request)


async def handle_health(request):
    venues = {}
    snaps = await asyncio.gather(
        *[v.account_snapshot() if v.configured else _noop_snap() for v in VENUES.values()]
    )
    for (k, v), snap in zip(VENUES.items(), snaps):
        venues[k] = {
            "configured": v.configured,
            "ready": v.ready,
            "err": v.err,
            "markets": len(v.markets),
            "account": snap,
        }
    return web.json_response({
        "ok": True,
        "dry_run": DRY_RUN,
        "max_notional_usd": MAX_NOTIONAL_USD,
        "venues": venues,
    })


async def _noop_snap():
    return None


async def handle_order(request):
    try:
        body = await request.json()
    except Exception:  # noqa
        return web.json_response({"ok": False, "error": "bad json"}, status=400)

    vk = venue_key(body.get("venue"))
    if not vk:
        log.warning("[order 400] unknown venue: %r", body.get("venue"))
        return web.json_response({"ok": False, "error": "unknown venue"}, status=400)
    v = VENUES[vk]
    if not v.ready:
        log.warning("[order 409] venue %s not ready: %s", vk, v.err)
        return web.json_response({"ok": False, "error": f"venue not ready: {v.err}"}, status=409)

    try:
        market_index = int(body["market_index"])
        size = float(body["size"])
        price = float(body["price"])
        side = str(body.get("side", "buy")).lower()
        reduce_only = bool(body.get("reduce_only", False))
        client_order_index = int(body.get("client_order_index", 0))
        tif = str(body.get("tif", "ioc")).lower()
    except Exception as e:  # noqa
        log.warning("[order 400] bad params: %s body=%r", e, body)
        return web.json_response({"ok": False, "error": f"bad params: {e}"}, status=400)

    notional = size * price
    if notional > MAX_NOTIONAL_USD:
        log.warning("[order 400] %s 名义额 %.4f 超过上限 %.2f (size=%s price=%s market=%s)",
                    vk, notional, MAX_NOTIONAL_USD, size, price, market_index)
        return web.json_response(
            {"ok": False, "error": f"名义额 {notional:.2f} 超过上限 {MAX_NOTIONAL_USD}"},
            status=400,
        )

    try:
        base_int, price_int, meta = v.scale(market_index, size, price)
    except Exception as e:  # noqa
        log.warning("[order 400] %s scale 失败: %s (size=%s price=%s market=%s)",
                    vk, e, size, price, market_index)
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    is_ask = side in ("sell", "ask", "short")
    c = v.client

    # tif -> (time_in_force, order_expiry)
    #   ioc:       立即成交剩余取消（吃单），expiry=0
    #   post_only: 只做 maker 挂单，若会立即成交则被拒（0 手续费平仓用），28天到期
    #   gtt:       挂到成交或到期
    if tif in ("post_only", "postonly", "maker", "post"):
        tif_val = getattr(c, "ORDER_TIME_IN_FORCE_POST_ONLY", 2)
        expiry_val = getattr(c, "DEFAULT_28_DAY_ORDER_EXPIRY", -1)
    elif tif in ("gtt", "gtc"):
        tif_val = getattr(c, "ORDER_TIME_IN_FORCE_GOOD_TILL_TIME", 1)
        expiry_val = getattr(c, "DEFAULT_28_DAY_ORDER_EXPIRY", -1)
    else:
        tif_val = c.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
        expiry_val = 0

    # DRY_RUN：只签名不发送
    if DRY_RUN:
        try:
            result = c.sign_create_order(
                market_index=market_index,
                client_order_index=client_order_index,
                base_amount=base_int,
                price=price_int,
                is_ask=is_ask,
                order_type=c.ORDER_TYPE_LIMIT,
                time_in_force=tif_val,
                reduce_only=reduce_only,
                order_expiry=expiry_val,
            )
            err = result[3] if isinstance(result, (list, tuple)) and len(result) >= 4 else None
            return web.json_response({
                "ok": err is None, "dry_run": True, "err": err,
                "base_int": base_int, "price_int": price_int,
                "symbol": meta.get("symbol"),
            })
        except Exception as e:  # noqa
            return web.json_response({"ok": False, "dry_run": True, "error": str(e)}, status=500)

    # LIVE：真实提交 IOC 限价单（吃单）
    # 注意：create_order 返回 (CreateOrder, RespSendTx, err)。err=None 只代表
    # “交易已被定序器接收”，并【不代表已成交】——IOC 是否撮合成功要靠随后的持仓/
    # 成交查询确认。这里把定序器的返回码/tx_hash 记录下来，便于事后追踪。
    try:
        _tx, resp, err = await c.create_order(
            market_index=market_index,
            client_order_index=client_order_index,
            base_amount=base_int,
            price=price_int,
            is_ask=is_ask,
            order_type=c.ORDER_TYPE_LIMIT,
            time_in_force=tif_val,
            reduce_only=reduce_only,
            order_expiry=expiry_val,
        )
        # resp 是 RespSendTx（可能是 pydantic 模型），逐字段安全取值
        def g(o, k):
            try:
                return getattr(o, k)
            except Exception:  # noqa
                try:
                    return o.get(k)
                except Exception:  # noqa
                    return None
        code = g(resp, "code")
        message = g(resp, "message")
        txh = g(resp, "tx_hash")
        pexec = g(resp, "predicted_execution_time_ms")
        if err is not None:
            log.warning("[order] %s 提交失败 market=%s side=%s base=%s price=%s err=%s",
                        vk, market_index, side, base_int, price_int, err)
        else:
            log.info("[order] %s 已提交(未必成交) market=%s side=%s base=%s price=%s code=%s tx=%s 预计执行=%sms",
                     vk, market_index, side, base_int, price_int, code, txh, pexec)
        return web.json_response({
            "ok": err is None, "dry_run": False,
            "tx_hash": str(txh) if txh is not None else None,
            "code": code, "message": message, "predicted_execution_time_ms": pexec,
            "err": str(err) if err else None,
            "base_int": base_int, "price_int": price_int,
            "symbol": meta.get("symbol"),
        })
    except Exception as e:  # noqa
        log.warning("[order 500] %s create_order 异常: %s", vk, e)
        return web.json_response({"ok": False, "dry_run": False, "error": str(e)}, status=500)


async def handle_positions(request):
    vk = venue_key(request.query.get("venue"))
    if not vk:
        return web.json_response({"ok": False, "error": "unknown venue"}, status=400)
    v = VENUES[vk]
    if not v.configured:
        return web.json_response({"ok": False, "error": "venue not configured"}, status=409)
    try:
        pos = await v.positions()
        return web.json_response({"ok": True, "positions": pos})
    except Exception as e:  # noqa
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_funding(request):
    """账户真实资金费结算记录（positionFunding，需鉴权）。"""
    vk = venue_key(request.query.get("venue"))
    if not vk:
        return web.json_response({"ok": False, "error": "unknown venue"}, status=400)
    v = VENUES[vk]
    if not v.configured:
        return web.json_response({"ok": False, "error": "venue not configured"}, status=409)
    if not v.ready:
        return web.json_response({"ok": False, "error": f"venue not ready: {v.err}"}, status=409)
    try:
        start = request.query.get("start")
        end = request.query.get("end")
        rows = await v.funding_history(
            start_ts=int(start) if start else None,
            end_ts=int(end) if end else None,
        )
        return web.json_response({"ok": True, "fundings": rows})
    except Exception as e:  # noqa
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_cancel(request):
    """撤单：用于 maker 开仓的重新挂单（requote）。cancel_all_orders 是账户级撤单，
    本工具同一时刻每个交易对只有一个活动任务，故可安全使用。DRY_RUN 下空转。"""
    try:
        body = await request.json()
    except Exception:  # noqa
        body = {}
    vk = venue_key(body.get("venue"))
    if not vk:
        return web.json_response({"ok": False, "error": "unknown venue"}, status=400)
    v = VENUES[vk]
    if not v.ready:
        return web.json_response({"ok": False, "error": f"venue not ready: {v.err}"}, status=409)
    if DRY_RUN:
        return web.json_response({"ok": True, "dry_run": True})
    c = v.client
    # cancel_all_orders 在不同 SDK 版本签名略有差异，逐个尝试，全部失败再报错。
    tif_imm = getattr(c, "CANCEL_ALL_TIF_IMMEDIATE", 0)
    attempts = (
        lambda: c.cancel_all_orders(time_in_force=tif_imm, time=0),
        lambda: c.cancel_all_orders(tif_imm, 0),
        lambda: c.cancel_all_orders(),
    )
    last = None
    for make in attempts:
        try:
            res = await make()
            err = res[2] if isinstance(res, (list, tuple)) and len(res) >= 3 else None
            if err is None:
                return web.json_response({"ok": True})
            last = str(err)
        except TypeError as e:  # noqa - wrong signature, try next
            last = f"TypeError: {e}"
            continue
        except Exception as e:  # noqa
            last = str(e)
            break
    log.warning("[cancel] %s cancel_all_orders 失败: %s", vk, last)
    return web.json_response({"ok": False, "error": last or "cancel failed"}, status=500)


async def on_startup(app):
    if not TOKEN:
        log.error("SIDECAR_TOKEN 未设置，拒绝启动（防止裸暴露）")
        raise SystemExit(1)
    build_venues()
    await asyncio.gather(*[v.init() for v in VENUES.values()])
    mode = "DRY_RUN(只签名不发送)" if DRY_RUN else "LIVE(真实下单)"
    log.info("边车启动完成，模式=%s，单笔上限=%.2f USD", mode, MAX_NOTIONAL_USD)
    for k, v in VENUES.items():
        log.info("  %s: ready=%s err=%s", k, v.ready, v.err)
        if v.configured:
            snap = await v.account_snapshot()
            log.info("  %s 账户: index=%s status=%s 总权益=%s 保证金=%s 可用=%s 持仓数=%s",
                     k, snap.get("account_index"), snap.get("status"),
                     snap.get("total_asset_value"), snap.get("collateral"),
                     snap.get("available_balance"), snap.get("open_positions"))
            # status!=1 或 保证金≈0 → 该账户无法开仓（未激活/资金不在交易保证金里）
            try:
                if int(snap.get("status") or 0) != 1 or float(snap.get("collateral") or 0) < 1:
                    log.warning("  ⚠️ %s 账户不可交易：status=%s 保证金=%s（需 status=1 且资金在交易保证金里）",
                                k, snap.get("status"), snap.get("collateral"))
            except Exception:  # noqa
                pass


async def on_cleanup(app):
    await asyncio.gather(*[v.close() for v in VENUES.values()])


def make_app():
    app = web.Application(middlewares=[auth_mw])
    app.router.add_get("/health", handle_health)
    app.router.add_post("/order", handle_order)
    app.router.add_post("/cancel", handle_cancel)
    app.router.add_get("/positions", handle_positions)
    app.router.add_get("/funding", handle_funding)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    host = env("SIDECAR_HOST", "127.0.0.1")
    port = int(env("SIDECAR_PORT", "8787") or 8787)
    web.run_app(make_app(), host=host, port=port)
