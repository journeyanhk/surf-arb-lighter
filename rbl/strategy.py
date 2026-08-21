from __future__ import annotations

from collections import deque
from datetime import UTC, datetime
from decimal import Decimal

from arbitrage.domain import BPS, Direction, Quote, Signal, Task


class SpreadStrategy:
    def __init__(
        self,
        task: Task,
        *,
        window_size: int,
        max_quote_age_ms: int,
        max_quote_skew_ms: int,
        min_entry_samples: int | None = None,
    ) -> None:
        min_entry_samples = window_size if min_entry_samples is None else min_entry_samples
        if window_size <= 0 or min_entry_samples <= 0 or min_entry_samples > window_size:
            raise ValueError("min_entry_samples must be between 1 and window_size")
        self.task = task
        self.window_size = window_size
        self.min_entry_samples = min_entry_samples
        # Retained as accepted constructor options for configuration compatibility.
        # WebSocket quotes are event-driven and are not rejected by wall-clock age or cross-venue timestamp skew.
        self.max_quote_age_ms = max_quote_age_ms
        self.max_quote_skew_ms = max_quote_skew_ms
        self.monitor_window_l_short_r_long: deque[Decimal] = deque(maxlen=window_size)
        self.monitor_window_l_long_r_short: deque[Decimal] = deque(maxlen=window_size)
        self._monitor_total_short = Decimal("0")
        self._monitor_total_long = Decimal("0")
        self.current_l_short_r_long: Decimal | None = None
        self.current_l_long_r_short: Decimal | None = None
        self.average_l_short_r_long: Decimal | None = None
        self.average_l_long_r_short: Decimal | None = None
        self.monitor_updated_at_ms: int | None = None
        self._last_pair: tuple[str, str] | None = None
        self._last_monitor_pair: tuple[str, str] | None = None
        self._baseline_sample_count = 0
        self._baseline_average_short: Decimal | None = None
        self._baseline_average_long: Decimal | None = None

    @property
    def warmed_up(self) -> bool:
        return len(self.monitor_window_l_short_r_long) >= self.min_entry_samples

    def monitor_snapshot(self) -> dict:
        return {
            "current_l_short_r_long": self.current_l_short_r_long,
            "current_l_long_r_short": self.current_l_long_r_short,
            "average_l_short_r_long": self.average_l_short_r_long,
            "average_l_long_r_short": self.average_l_long_r_short,
            "sample_count": len(self.monitor_window_l_short_r_long),
            # Kept for API compatibility; every connected, positive WebSocket pair is now a strategy sample.
            "valid_sample_count": len(self.monitor_window_l_short_r_long),
            "window_size": self.window_size,
            "min_entry_samples": self.min_entry_samples,
            "entry_ready": self.warmed_up,
            "updated_at_ms": self.monitor_updated_at_ms,
        }

    def observe(self, lighter: Quote, rblighter: Quote) -> None:
        """Append one event-driven WebSocket pair to the rolling statistical window."""
        if not lighter.connected or not rblighter.connected or not lighter.positive() or not rblighter.positive():
            return
        pair = (lighter.sequence, rblighter.sequence)
        if pair == self._last_monitor_pair:
            return
        self._last_monitor_pair = pair
        self._baseline_sample_count = len(self.monitor_window_l_short_r_long)
        if self._baseline_sample_count:
            count = Decimal(self._baseline_sample_count)
            self._baseline_average_short = self._monitor_total_short / count
            self._baseline_average_long = self._monitor_total_long / count
        else:
            self._baseline_average_short = None
            self._baseline_average_long = None
        spread_short = lighter.bid_price - rblighter.ask_price
        spread_long = rblighter.bid_price - lighter.ask_price
        self.current_l_short_r_long = spread_short
        self.current_l_long_r_short = spread_long
        self.monitor_updated_at_ms = max(lighter.local_received_at_ms, rblighter.local_received_at_ms)
        if len(self.monitor_window_l_short_r_long) == self.window_size:
            self._monitor_total_short -= self.monitor_window_l_short_r_long[0]
            self._monitor_total_long -= self.monitor_window_l_long_r_short[0]
        self.monitor_window_l_short_r_long.append(spread_short)
        self.monitor_window_l_long_r_short.append(spread_long)
        self._monitor_total_short += spread_short
        self._monitor_total_long += spread_long
        sample_count = Decimal(len(self.monitor_window_l_short_r_long))
        self.average_l_short_r_long = self._monitor_total_short / sample_count
        self.average_l_long_r_short = self._monitor_total_long / sample_count

    def valid_pair(self, lighter: Quote, rblighter: Quote, now_ms: int) -> tuple[bool, str | None]:
        if not lighter.connected or not rblighter.connected:
            return False, "websocket_disconnected"
        if not lighter.positive() or not rblighter.positive():
            return False, "non_positive_quote"
        pair = (lighter.sequence, rblighter.sequence)
        if pair == self._last_pair:
            return False, "duplicate_pair"
        if min(lighter.bid_size, lighter.ask_size, rblighter.bid_size, rblighter.ask_size) < self.task.order_qty:
            return False, "insufficient_top_size"
        return True, None

    def evaluate(self, lighter: Quote, rblighter: Quote, *, now_ms: int | None = None) -> tuple[Signal | None, str | None]:
        now_ms = now_ms if now_ms is not None else int(datetime.now(UTC).timestamp() * 1000)
        self.observe(lighter, rblighter)
        valid, reason = self.valid_pair(lighter, rblighter, now_ms)
        if not valid:
            return None, reason
        self._last_pair = (lighter.sequence, rblighter.sequence)
        spread_short = lighter.bid_price - rblighter.ask_price
        spread_long = rblighter.bid_price - lighter.ask_price
        # The sample that reaches the threshold completes warm-up. Entry begins with the next WebSocket update,
        # whose baseline is the already-collected statistical window.
        if self._baseline_sample_count < self.min_entry_samples:
            return None, "warming_up"

        # Baselines intentionally exclude the current sample.
        if self._baseline_average_short is None or self._baseline_average_long is None:
            return None, "warming_up"
        avg_short = self._baseline_average_short
        avg_long = self._baseline_average_long
        average_midpoint = (avg_short + avg_long) / Decimal("2")
        threshold_short = avg_short + lighter.bid_price * self.task.target_profit_bps / BPS - average_midpoint
        threshold_long = avg_long + rblighter.bid_price * self.task.target_profit_bps / BPS - average_midpoint
        candidates: list[Signal] = []
        opportunity_at = datetime.now(UTC)
        if self.task.step < self.task.max_steps and spread_short >= threshold_short:
            candidates.append(Signal(Direction.L_SHORT_R_LONG, spread_short, avg_short, threshold_short, (spread_short - threshold_short) / lighter.bid_price * BPS, lighter, rblighter, opportunity_at))
        if self.task.step > -self.task.max_steps and spread_long >= threshold_long:
            candidates.append(Signal(Direction.L_LONG_R_SHORT, spread_long, avg_long, threshold_long, (spread_long - threshold_long) / rblighter.bid_price * BPS, lighter, rblighter, opportunity_at))

        if len(candidates) == 2 and candidates[0].excess_bps == candidates[1].excess_bps:
            return None, "ambiguous_dual_signal"
        return (max(candidates, key=lambda s: s.excess_bps), None) if candidates else (None, "no_signal")
