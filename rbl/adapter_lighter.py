from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import replace
from decimal import Decimal, ROUND_DOWN, ROUND_UP

import httpx
import websockets

from arbitrage.config import Settings
from arbitrage.adapters.account_requests import AccountRequestGate
from arbitrage.domain import AccountSnapshot, MarketMapping, OrderRequest, OrderResult, Position, utc_now
from arbitrage.order_tracking import OrderFillTracker


logger = logging.getLogger("arbitrage.adapters.lighter")

LIGHTER_TERMINAL_STATUSES = {"filled"}


class LighterAdapter:
    name = "lighter"

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self.http = client or httpx.AsyncClient(base_url=settings.lighter_base_url, timeout=10)
        self._signer = None
        self._tracker = OrderFillTracker(self.name)
        self._account_streams: dict[int, asyncio.Task] = {}
        self._stream_ready: dict[int, asyncio.Event] = {}
        self._active_orders: dict[int, dict[str, dict]] = {}
        self._account_positions: dict[int, Position] = {}
        self._mark_streams: dict[int, asyncio.Task] = {}
        self._mark_ready: dict[int, asyncio.Event] = {}
        self._mark_prices: dict[int, Decimal] = {}
        self._mark_updated_at_ms: dict[int, int] = {}
        self._account_gate: AccountRequestGate[dict] = AccountRequestGate(
            self.name,
            min_interval_seconds=settings.account_query_min_interval_seconds,
            cache_seconds=settings.account_query_cache_seconds,
            backoff_base_seconds=settings.account_query_backoff_base_seconds,
            backoff_max_seconds=settings.account_query_backoff_max_seconds,
        )

    async def market_metadata(self) -> list[dict]:
        response = await self.http.get("/api/v1/orderBookDetails")
        response.raise_for_status()
        return response.json()["order_book_details"]

    async def _account(self, *, allow_cache: bool = True) -> dict:
        if self.settings.lighter_account_index is None:
            raise RuntimeError("LIGHTER_ACCOUNT_INDEX is required")

        async def fetch() -> dict:
            response = await self.http.get("/api/v1/account", params={"by": "index", "value": self.settings.lighter_account_index})
            response.raise_for_status()
            data = response.json()
            accounts = data.get("accounts") or ([data["account"]] if "account" in data else [])
            if not accounts:
                raise RuntimeError("Lighter account response contains no account")
            return accounts[0]

        return await self._account_gate.get(fetch, allow_cache=allow_cache)

    @staticmethod
    def _equity_from(account: dict) -> Decimal:
        value = account.get("total_asset_value") or account.get("portfolio_value")
        if value is None:
            raise RuntimeError("Lighter account response has no documented total account value field")
        return Decimal(str(value))

    @staticmethod
    def _position_from(account: dict, mapping: MarketMapping) -> Position:
        positions = account.get("positions", [])
        row = next(
            (
                p
                for p in positions
                if int(p.get("market_id", p.get("market_index", -1)))
                == mapping.lighter_market_index
            ),
            None,
        )
        if not row:
            return Position(Decimal("0"))
        quantity = Decimal(str(row.get("position", "0"))) * Decimal(str(row.get("sign", 1)))
        mark = row.get("mark_price")
        liquidation = row.get("liquidation_price")
        return Position(
            quantity,
            Decimal(str(mark)) if mark not in {None, ""} else None,
            Decimal(str(liquidation)) if liquidation not in {None, ""} else None,
        )

    @staticmethod
    def _mark_from_message(payload: dict, market_index: int) -> Decimal | None:
        stats = payload.get("market_stats")
        if not isinstance(stats, dict):
            return None
        if "mark_price" not in stats:
            stats = stats.get(str(market_index)) or stats.get(market_index)
        if not isinstance(stats, dict):
            return None
        raw_market = stats.get("market_id", market_index)
        if int(raw_market) != market_index:
            return None
        raw_mark = stats.get("mark_price")
        if raw_mark in {None, ""}:
            return None
        mark = Decimal(str(raw_mark))
        return mark if mark > 0 else None

    async def _mark_price(self, mapping: MarketMapping) -> Decimal:
        market = mapping.lighter_market_index
        task = self._mark_streams.get(market)
        if not task or task.done():
            ready = self._mark_ready[market] = asyncio.Event()
            self._mark_streams[market] = asyncio.create_task(self._mark_stream_loop(mapping, ready))
        ready = self._mark_ready[market]
        try:
            await asyncio.wait_for(ready.wait(), timeout=10)
        except TimeoutError as exc:
            raise RuntimeError(f"Lighter market_stats mark price unavailable for market {market}") from exc
        mark = self._mark_prices.get(market)
        if mark is None or mark <= 0:
            raise RuntimeError(f"Lighter market_stats returned no positive mark price for market {market}")
        return mark

    async def _mark_stream_loop(self, mapping: MarketMapping, ready: asyncio.Event) -> None:
        market = mapping.lighter_market_index
        delay = 1
        while True:
            try:
                async with websockets.connect(self.settings.lighter_ws_url, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({"type": "subscribe", "channel": f"market_stats/{market}"}))
                    delay = 1
                    async for raw in ws:
                        payload = json.loads(raw)
                        mark = self._mark_from_message(payload, market)
                        if mark is None:
                            continue
                        first = not ready.is_set()
                        self._mark_prices[market] = mark
                        self._mark_updated_at_ms[market] = int(payload.get("timestamp") or 0)
                        ready.set()
                        if first:
                            logger.info(
                                "Lighter 标记价流已连接 market_index=%s symbol=%s mark_price=%s",
                                market,
                                mapping.lighter_symbol,
                                mark,
                            )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                ready.clear()
                self._mark_prices.pop(market, None)
                self._mark_updated_at_ms.pop(market, None)
                logger.warning("Lighter 标记价流断开，%s 秒后重连：%s", delay, exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def _position_with_mark(self, account: dict, mapping: MarketMapping) -> Position:
        position = self._position_from(account, mapping)
        return await self._ensure_position_mark(position, mapping)

    async def _ensure_position_mark(self, position: Position, mapping: MarketMapping) -> Position:
        if position.quantity == 0 or position.mark_price is not None:
            return position
        mark = await self._mark_price(mapping)
        return replace(
            position,
            mark_price=mark,
            updated_at_ms=self._mark_updated_at_ms.get(mapping.lighter_market_index),
        )

    async def equity(self) -> Decimal:
        return self._equity_from(await self._account())

    async def position(self, mapping: MarketMapping) -> Position:
        if not self.settings.dry_run:
            await self._ensure_account_stream(mapping)
            cached = self._account_positions.get(mapping.lighter_market_index)
            if cached is not None:
                return await self._ensure_position_mark(cached, mapping)
        return await self._position_with_mark(await self._account(), mapping)

    async def fresh_position(self, mapping: MarketMapping) -> Position:
        """Bypass the account WebSocket cache for safety-critical decisions."""
        return await self._position_with_mark(await self._account(allow_cache=False), mapping)

    async def account_snapshot(self, mapping: MarketMapping) -> AccountSnapshot:
        account = await self._account()
        available = account.get("available_balance")
        if available is None:
            raise RuntimeError("Lighter account response has no available_balance field")
        return AccountSnapshot(
            equity=self._equity_from(account),
            available_balance=Decimal(str(available)),
            position=await self._position_with_mark(account, mapping),
        )

    async def open_orders(self, mapping: MarketMapping) -> list[dict]:
        if self.settings.lighter_account_index is None:
            return []
        if not self.settings.dry_run:
            await self._ensure_account_stream(mapping)
        signer = await self._configured_signer()
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=self.settings.lighter_api_key_index
        )
        if error or not auth:
            raise RuntimeError(f"Lighter auth token generation failed: {error or 'empty token'}")
        response = await self.http.get(
            "/api/v1/accountActiveOrders",
            params={"account_index": self.settings.lighter_account_index, "market_id": mapping.lighter_market_index},
            headers={"Authorization": auth},
        )
        response.raise_for_status()
        rows = response.json().get("orders", [])
        merged = {str(row.get("order_id") or row.get("order_index")): row for row in rows}
        merged.update(self._active_orders.get(mapping.lighter_market_index, {}))
        return list(merged.values())

    async def _auth_token(self) -> str:
        signer = await self._configured_signer()
        auth, error = signer.create_auth_token_with_expiry(api_key_index=self.settings.lighter_api_key_index)
        if error or not auth:
            raise RuntimeError(f"Lighter auth token generation failed: {error or 'empty token'}")
        return auth

    async def _ensure_account_stream(self, mapping: MarketMapping) -> None:
        market = mapping.lighter_market_index
        task = self._account_streams.get(market)
        if not task or task.done():
            ready = self._stream_ready[market] = asyncio.Event()
            self._account_streams[market] = asyncio.create_task(self._account_stream_loop(mapping, ready))
        await asyncio.wait_for(self._stream_ready[market].wait(), timeout=10)

    async def _account_stream_loop(self, mapping: MarketMapping, ready: asyncio.Event) -> None:
        delay = 1
        while True:
            try:
                auth = await self._auth_token()
                channel = f"account_market/{mapping.lighter_market_index}/{self.settings.lighter_account_index}"
                async with websockets.connect(self.settings.lighter_ws_url, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({"type": "subscribe", "channel": channel, "auth": auth}))
                    delay = 1
                    async for raw in ws:
                        payload = json.loads(raw)
                        self._apply_account_message(payload, mapping)
                        if payload.get("type") in {"update/account_market", "subscribed/account_market"}:
                            if not ready.is_set():
                                logger.info("Lighter 账户订单/成交流已订阅 market_index=%s", mapping.lighter_market_index)
                            ready.set()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                ready.clear()
                self._account_positions.pop(mapping.lighter_market_index, None)
                logger.warning("Lighter 账户流断开，%s 秒后重连：%s", delay, exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    @staticmethod
    def _rows(value: object) -> list[dict]:
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
        if isinstance(value, dict):
            if any(
                key in value
                for key in ("market_id", "market_index", "position", "order_id", "trade_id")
            ):
                return [value]
            return [row for row in value.values() if isinstance(row, dict)]
        return []

    def _apply_account_message(self, payload: dict, mapping: MarketMapping) -> None:
        if payload.get("type") not in {"update/account_market", "subscribed/account_market"}:
            return
        if "position" in payload:
            rows = self._rows(payload.get("position"))
            row = None
            for item in rows:
                raw_market = item.get("market_id", item.get("market_index"))
                # account_market/<market>/<account> already scopes a single
                # position. Some Lighter snapshots omit the market id.
                if raw_market is None and len(rows) == 1:
                    row = item
                    break
                try:
                    if int(raw_market) == mapping.lighter_market_index:
                        row = item
                        break
                except (TypeError, ValueError):
                    continue
            if row is None:
                logger.warning(
                    "忽略无法匹配市场的 Lighter 仓位推送 market_index=%s rows=%s",
                    mapping.lighter_market_index,
                    len(rows),
                )
            else:
                normalized = dict(row)
                normalized.setdefault("market_id", mapping.lighter_market_index)
                position = self._position_from({"positions": [normalized]}, mapping)
                raw_updated_at = (
                    payload.get("timestamp")
                    or row.get("timestamp")
                    or row.get("updated_at")
                )
                try:
                    updated_at_ms = int(raw_updated_at)
                except (TypeError, ValueError):
                    updated_at_ms = int(utc_now().timestamp() * 1000)
                self._account_positions[mapping.lighter_market_index] = replace(
                    position,
                    updated_at_ms=updated_at_ms,
                )
        for order in self._rows(payload.get("orders")):
            if int(order.get("market_index", order.get("market_id", -1))) != mapping.lighter_market_index:
                continue
            key = order.get("client_order_id") or order.get("client_order_index")
            if key is None:
                continue
            status = str(order.get("status", "")).lower()
            terminal = status in LIGHTER_TERMINAL_STATUSES or status.startswith("canceled")
            active_key = str(order.get("order_id") or order.get("order_index"))
            active = self._active_orders.setdefault(mapping.lighter_market_index, {})
            if terminal:
                active.pop(active_key, None)
            else:
                active[active_key] = order
            filled_qty = Decimal(str(order.get("filled_base_amount") or "0"))
            filled_quote = Decimal(str(order.get("filled_quote_amount") or "0"))
            self._tracker.apply_order(
                key,
                order_id=str(order.get("order_id") or order.get("order_index") or "") or None,
                status=status.upper(),
                filled_qty=filled_qty,
                filled_quote=filled_quote,
                terminal=terminal,
            )
        for trade in self._rows(payload.get("trades")):
            if int(trade.get("market_id", -1)) != mapping.lighter_market_index:
                continue
            account = str(self.settings.lighter_account_index)
            is_ask = str(trade.get("ask_account_id") or trade.get("ask_account_index")) == account
            key = trade.get("ask_client_id_str") if is_ask else trade.get("bid_client_id_str")
            if key is None:
                continue
            raw_order_id = trade.get("ask_id_str") if is_ask else trade.get("bid_id_str")
            self._tracker.apply_fill(
                key,
                trade_id=str(trade.get("trade_id_str") or trade.get("trade_id")),
                order_id=str(raw_order_id) if raw_order_id is not None else None,
                qty=Decimal(str(trade.get("size") or "0")),
                price=Decimal(str(trade.get("price") or "0")),
            )

    @staticmethod
    def client_order_index(client_id: str) -> int:
        return int.from_bytes(hashlib.sha256(client_id.encode()).digest()[:6], "big")

    async def _configured_signer(self):
        if self._signer is None:
            if self.settings.lighter_account_index is None:
                raise RuntimeError("LIGHTER_ACCOUNT_INDEX is required")
            if self.settings.lighter_api_key_index is None or not self.settings.lighter_api_private_key:
                raise RuntimeError("Lighter API key is required for authenticated account reads")
            try:
                import lighter
            except ImportError as exc:
                raise RuntimeError("install the 'live' extra to access authenticated Lighter data") from exc
            self._signer = lighter.SignerClient(
                url=self.settings.lighter_base_url,
                api_private_keys={self.settings.lighter_api_key_index: self.settings.lighter_api_private_key},
                account_index=self.settings.lighter_account_index,
            )
            error = self._signer.check_client()
            if error:
                self._signer = None
                raise RuntimeError(f"Lighter API key validation failed: {error}")
        return self._signer

    async def _signer_client(self):
        self.settings.assert_live_safe()
        return await self._configured_signer()

    async def prepare_live_trading(self) -> None:
        """Fail startup before accepting tasks when signer credentials are invalid."""
        await self._signer_client()

    async def place_order(self, mapping: MarketMapping, request: OrderRequest) -> OrderResult:
        sent = utc_now()
        if self.settings.dry_run:
            now = utc_now()
            return OrderResult(self.name, request.client_order_id, "dry-run", "FILLED", request.quantity, request.reference_price, request_sent_at=sent, ack_at=now, first_fill_at=now, fully_filled_at=now)
        await self._ensure_account_stream(mapping)
        signer = await self._signer_client()
        scale_qty = Decimal(10) ** mapping.lighter_qty_precision
        scale_price = Decimal(10) ** mapping.lighter_price_precision
        base_amount = int((request.quantity * scale_qty).to_integral_exact(rounding=ROUND_DOWN))
        slip = request.max_slippage_bps / Decimal("10000")
        worst = request.reference_price * (Decimal("1") + slip if request.side == "BUY" else Decimal("1") - slip)
        rounding = ROUND_UP if request.side == "BUY" else ROUND_DOWN
        price = int((worst * scale_price).to_integral_value(rounding=rounding))
        client_index = self.client_order_index(request.client_order_id)
        self._tracker.register(client_index, request.client_order_id, request.quantity, sent)
        tx, response, err = await signer.create_order(
            market_index=mapping.lighter_market_index,
            client_order_index=client_index,
            base_amount=base_amount,
            price=price,
            is_ask=request.side == "SELL",
            order_type=signer.ORDER_TYPE_MARKET,
            time_in_force=signer.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            order_expiry=signer.DEFAULT_IOC_EXPIRY,
            reduce_only=request.reduce_only,
        )
        ack = utc_now()
        if err:
            self._tracker.fail(client_index, str(err), ack)
            return OrderResult(self.name, request.client_order_id, None, "FAILED", request_sent_at=sent, ack_at=ack, error=str(err))
        if response is None or int(response.code) != 200:
            message = getattr(response, "message", None) or "empty Lighter transaction response"
            self._tracker.fail(client_index, message, ack)
            return OrderResult(self.name, request.client_order_id, None, "FAILED", request_sent_at=sent, ack_at=ack, error=message)
        self._tracker.acknowledge(client_index, None, ack)
        try:
            return await self._tracker.wait(client_index, self.settings.execution_timeout_ms / 1000)
        except TimeoutError:
            current = self._tracker.result(client_index)
            assert current is not None
            return replace(current, status="UNKNOWN", error=f"no terminal Lighter account event before timeout; tx={response.tx_hash}")

    async def cancel_order(self, mapping: MarketMapping, order_id: str) -> bool:
        signer = await self._signer_client()
        _, _, err = await signer.cancel_order(mapping.lighter_market_index, int(order_id))
        return err is None

    async def aclose(self) -> None:
        tasks = [*self._account_streams.values(), *self._mark_streams.values()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.http.aclose()
