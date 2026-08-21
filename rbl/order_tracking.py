from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from arbitrage.domain import FillReport, OrderResult, ZERO, utc_now


@dataclass(slots=True)
class _TrackedOrder:
    exchange: str
    client_order_id: str
    requested_qty: Decimal
    request_sent_at: datetime
    order_id: str | None = None
    ack_at: datetime | None = None
    status: str = "PENDING"
    order_filled_qty: Decimal = ZERO
    order_filled_quote: Decimal = ZERO
    fill_qty: Decimal = ZERO
    fill_quote: Decimal = ZERO
    fee: Decimal = ZERO
    first_fill_at: datetime | None = None
    terminal_at: datetime | None = None
    error: str | None = None
    require_fill: bool = False
    fills: dict[str, FillReport] = field(default_factory=dict)
    event: asyncio.Event = field(default_factory=asyncio.Event)


class OrderFillTracker:
    """Correlates exchange order/fill events with a locally generated client id."""

    def __init__(self, exchange: str) -> None:
        self.exchange = exchange
        self._orders: dict[str, _TrackedOrder] = {}
        self._aliases: dict[str, str] = {}

    def register(self, client_key: str | int, client_order_id: str, requested_qty: Decimal, sent_at: datetime, *, require_fill: bool = False) -> None:
        key = str(client_key)
        self._orders[key] = _TrackedOrder(self.exchange, client_order_id, requested_qty, sent_at, require_fill=require_fill)
        self._aliases[client_order_id] = key

    def _get(self, client_key: str | int) -> _TrackedOrder | None:
        key = str(client_key).rstrip("\x00")
        return self._orders.get(key) or self._orders.get(self._aliases.get(key, ""))

    def acknowledge(self, client_key: str | int, order_id: str | None, at: datetime | None = None) -> None:
        order = self._get(client_key)
        if not order:
            return
        if order_id:
            order.order_id = str(order_id)
        order.ack_at = order.ack_at or at or utc_now()

    def apply_order(
        self,
        client_key: str | int,
        *,
        order_id: str | None,
        status: str,
        filled_qty: Decimal = ZERO,
        filled_quote: Decimal = ZERO,
        fee: Decimal = ZERO,
        terminal: bool,
        at: datetime | None = None,
        error: str | None = None,
    ) -> None:
        order = self._get(client_key)
        if not order:
            return
        now = at or utc_now()
        self.acknowledge(client_key, order_id, now)
        order.status = status
        order.order_filled_qty = max(order.order_filled_qty, filled_qty)
        if filled_qty >= order.order_filled_qty and filled_quote > ZERO:
            order.order_filled_quote = filled_quote
        order.fee = max(order.fee, fee)
        if max(order.order_filled_qty, order.fill_qty) > ZERO:
            order.first_fill_at = order.first_fill_at or now
        if error:
            order.error = error
        if terminal:
            order.terminal_at = now
            if not order.require_fill or max(order.order_filled_qty, order.fill_qty) == ZERO or order.fills:
                order.event.set()

    def apply_fill(
        self,
        client_key: str | int,
        *,
        trade_id: str,
        order_id: str | None,
        qty: Decimal,
        price: Decimal,
        fee: Decimal = ZERO,
        at: datetime | None = None,
    ) -> None:
        order = self._get(client_key)
        if not order or trade_id in order.fills:
            return
        now = at or utc_now()
        order.fills[trade_id] = FillReport(trade_id, qty, price, fee, now)
        order.order_id = str(order_id) if order_id else order.order_id
        order.ack_at = order.ack_at or now
        order.fill_qty += qty
        order.fill_quote += qty * price
        order.fee += fee
        order.first_fill_at = order.first_fill_at or now
        if order.terminal_at:
            order.event.set()

    def fail(self, client_key: str | int, error: str, at: datetime | None = None) -> None:
        self.apply_order(client_key, order_id=None, status="FAILED", terminal=True, at=at, error=error)

    def result(self, client_key: str | int) -> OrderResult | None:
        order = self._get(client_key)
        if not order:
            return None
        qty = max(order.order_filled_qty, order.fill_qty)
        quote = order.fill_quote if order.fill_qty >= order.order_filled_qty and order.fill_quote > ZERO else order.order_filled_quote
        vwap = quote / qty if qty > ZERO and quote > ZERO else None
        if order.terminal_at:
            if qty >= order.requested_qty:
                status = "FILLED"
            elif qty > ZERO:
                status = "PARTIALLY_FILLED"
            elif order.status == "FAILED":
                status = "FAILED"
            else:
                status = "CANCELED"
        else:
            status = "ACCEPTED" if order.ack_at else "PENDING"
        return OrderResult(
            order.exchange,
            order.client_order_id,
            order.order_id,
            status,
            qty,
            vwap,
            order.fee,
            order.request_sent_at,
            order.ack_at,
            order.first_fill_at,
            order.terminal_at if status == "FILLED" else None,
            order.error,
            tuple(order.fills.values()),
        )

    async def wait(self, client_key: str | int, timeout: float) -> OrderResult:
        order = self._get(client_key)
        if not order:
            raise KeyError(f"unregistered client order {client_key}")
        await asyncio.wait_for(order.event.wait(), timeout)
        result = self.result(client_key)
        assert result is not None
        return result
