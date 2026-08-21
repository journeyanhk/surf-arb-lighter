from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, ROUND_DOWN
from enum import StrEnum
from typing import Any

ZERO = Decimal("0")
BPS = Decimal("10000")


def utc_now() -> datetime:
    return datetime.now(UTC)


class TaskStatus(StrEnum):
    CREATED = "CREATED"
    WARMING_UP = "WARMING_UP"
    RUNNING = "RUNNING"
    EXECUTING = "EXECUTING"
    RECONCILING = "RECONCILING"
    PAUSED_RECONCILIATION = "PAUSED_RECONCILIATION"
    RECOVERING = "RECOVERING"
    PAUSED = "PAUSED"
    PAUSED_DATA_STALE = "PAUSED_DATA_STALE"
    RISK_EXIT = "RISK_EXIT"
    STOPPED = "STOPPED"
    ERROR = "ERROR"


class Direction(StrEnum):
    L_SHORT_R_LONG = "L_SHORT_R_LONG"
    L_LONG_R_SHORT = "L_LONG_R_SHORT"

    @property
    def lighter_side(self) -> str:
        return "SELL" if self is self.L_SHORT_R_LONG else "BUY"

    @property
    def rblighter_side(self) -> str:
        return "BUY" if self is self.L_SHORT_R_LONG else "SELL"

    @property
    def step_delta(self) -> int:
        return 1 if self is self.L_SHORT_R_LONG else -1


@dataclass(frozen=True, slots=True)
class MarketMapping:
    asset: str
    lighter_symbol: str
    lighter_market_index: int
    rblighter_symbol: str
    rblighter_market_index: int
    lighter_qty_precision: int
    lighter_price_precision: int
    lighter_min_order_qty: Decimal
    lighter_tick_size: Decimal
    rblighter_qty_precision: int
    rblighter_price_precision: int
    rblighter_min_order_qty: Decimal
    rblighter_tick_size: Decimal

    def validate_qty(self, qty: Decimal) -> None:
        minimum = max(self.lighter_min_order_qty, self.rblighter_min_order_qty)
        if qty < minimum:
            raise ValueError(f"order_qty {qty} is below cross-exchange minimum {minimum}")
        for exchange, precision in (("Lighter", self.lighter_qty_precision), ("RBLighter", self.rblighter_qty_precision)):
            quantum = Decimal(1).scaleb(-precision)
            if qty.quantize(quantum, rounding=ROUND_DOWN) != qty:
                raise ValueError(f"order_qty {qty} exceeds {exchange} quantity precision {precision}")


@dataclass(frozen=True, slots=True)
class Quote:
    exchange: str
    symbol: str
    bid_price: Decimal
    bid_size: Decimal
    ask_price: Decimal
    ask_size: Decimal
    exchange_timestamp_ms: int
    local_received_at_ms: int
    sequence: str
    connected: bool = True

    def positive(self) -> bool:
        return min(self.bid_price, self.bid_size, self.ask_price, self.ask_size) > ZERO


@dataclass(slots=True)
class Task:
    id: str
    mapping: MarketMapping
    target_profit_bps: Decimal
    order_qty: Decimal
    max_steps: int
    risk_liquidation_distance_pct: Decimal
    window_size: int = 100_000
    min_entry_samples: int = 10_000
    status: TaskStatus = TaskStatus.CREATED
    step: int = 0
    successful_trade_count: int = 0
    attempt_count: int = 0
    initial_lighter_equity: Decimal | None = None
    initial_rblighter_equity: Decimal | None = None
    baseline_lighter_position: Decimal = ZERO
    baseline_rblighter_position: Decimal = ZERO
    last_result: str | None = None
    created_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True, slots=True)
class Position:
    quantity: Decimal
    mark_price: Decimal | None = None
    liquidation_price: Decimal | None = None
    updated_at_ms: int | None = None
    # True only when an exchange explicitly reports that this position has no
    # liquidation price. This is different from an absent/broken risk field.
    no_liquidation_price: bool = False

    def liquidation_distance_pct(self) -> Decimal | None:
        if self.quantity == ZERO:
            return None
        if self.mark_price is None or self.mark_price <= ZERO or self.liquidation_price is None:
            return None
        if self.liquidation_price < ZERO:
            return None
        # Lighter returns zero for a sufficiently collateralized long whose
        # liquidation boundary is at or below zero. That is a valid 100%
        # distance, not missing risk data. A zero short liquidation boundary
        # is impossible in the adverse (upward) direction and remains invalid.
        if self.liquidation_price == ZERO and self.quantity < ZERO:
            return None
        return abs(self.mark_price - self.liquidation_price) / self.mark_price * Decimal("100")


@dataclass(frozen=True, slots=True)
class AccountSnapshot:
    """Read-only exchange account state used by the dashboard."""

    equity: Decimal
    available_balance: Decimal
    position: Position


@dataclass(frozen=True, slots=True)
class OrderRequest:
    client_order_id: str
    side: str
    quantity: Decimal
    reference_price: Decimal
    max_slippage_bps: Decimal
    reduce_only: bool = False


@dataclass(frozen=True, slots=True)
class FillReport:
    trade_id: str
    qty: Decimal
    price: Decimal
    fee: Decimal
    timestamp: datetime


@dataclass(frozen=True, slots=True)
class OrderResult:
    exchange: str
    client_order_id: str
    order_id: str | None
    status: str
    filled_qty: Decimal = ZERO
    vwap: Decimal | None = None
    fee: Decimal = ZERO
    request_sent_at: datetime | None = None
    ack_at: datetime | None = None
    first_fill_at: datetime | None = None
    fully_filled_at: datetime | None = None
    error: str | None = None
    fills: tuple[FillReport, ...] = ()

    @property
    def fully_filled(self) -> bool:
        return self.status == "FILLED" and self.filled_qty > ZERO


@dataclass(frozen=True, slots=True)
class Signal:
    direction: Direction
    spread: Decimal
    average: Decimal
    threshold: Decimal
    excess_bps: Decimal
    lighter_quote: Quote
    rblighter_quote: Quote
    opportunity_at: datetime


def decimal_json(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, dict):
        return {k: decimal_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [decimal_json(v) for v in value]
    return value
