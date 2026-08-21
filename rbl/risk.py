from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from decimal import Decimal

from arbitrage.adapters.base import ExchangeAdapter, read_fresh_position
from arbitrage.adapters.account_requests import AccountReadUnavailable
from arbitrage.database import Repository
from arbitrage.domain import OrderRequest, OrderResult, Position, Task, TaskStatus, decimal_json, utc_now


logger = logging.getLogger("arbitrage.risk")


class RiskManager:
    def __init__(
        self,
        lighter: ExchangeAdapter,
        rblighter: ExchangeAdapter,
        repository: Repository | None,
        *,
        tolerance: Decimal,
        slippage_bps: Decimal,
        data_timeout_seconds: int = 120,
        position_sync_timeout_ms: int = 5_000,
        position_sync_poll_ms: int = 100,
        position_sync_confirmations: int = 2,
    ) -> None:
        self.lighter = lighter
        self.rblighter = rblighter
        self.repository = repository
        self.tolerance = tolerance
        self.slippage_bps = slippage_bps
        self.data_timeout_seconds = data_timeout_seconds
        self.position_sync_timeout = position_sync_timeout_ms / 1000
        self.position_sync_poll = position_sync_poll_ms / 1000
        self.position_sync_confirmations = position_sync_confirmations
        self._missing_since: dict[tuple[str, str], float] = {}
        self.blocked_tasks: set[str] = set()
        self.exit_lock = asyncio.Lock()
        self._check_locks: dict[str, asyncio.Lock] = {}
        self.last_exit_reports: dict[str, dict] = {}

    def reset_task(self, task_id: str) -> None:
        """Clear transient risk state after a verified flat start/exit."""
        self.blocked_tasks.discard(task_id)
        for key in [key for key in self._missing_since if key[0] == task_id]:
            self._missing_since.pop(key, None)

    async def check(self, task: Task) -> bool:
        lock = self._check_locks.setdefault(task.id, asyncio.Lock())
        async with lock:
            return await self._check_locked(task)

    async def _check_locked(self, task: Task) -> bool:
        if task.status in {
            TaskStatus.STOPPED,
            TaskStatus.ERROR,
            TaskStatus.EXECUTING,
            TaskStatus.RECONCILING,
            TaskStatus.PAUSED_RECONCILIATION,
            TaskStatus.RECOVERING,
            TaskStatus.RISK_EXIT,
        }:
            return False
        try:
            positions = await asyncio.gather(
                read_fresh_position(self.lighter, task.mapping),
                read_fresh_position(self.rblighter, task.mapping),
            )
        except AccountReadUnavailable as exc:
            self.blocked_tasks.add(task.id)
            task.status = TaskStatus.PAUSED_DATA_STALE
            task.last_result = "RISK_ACCOUNT_READ_FAILED"
            if self.repository:
                await self.repository.save_task(task)
            logger.warning(
                "风控账户读取失败，暂停新交易 task=%s exchange=%s status=%s retry_after=%.1fs",
                task.id,
                exc.exchange,
                exc.status_code,
                exc.retry_after_seconds,
            )
            return False
        if task.last_result == "RISK_ACCOUNT_READ_FAILED":
            task.last_result = None
        if task.status in {
            TaskStatus.STOPPED,
            TaskStatus.ERROR,
            TaskStatus.EXECUTING,
            TaskStatus.RECONCILING,
            TaskStatus.PAUSED_RECONCILIATION,
            TaskStatus.RECOVERING,
            TaskStatus.RISK_EXIT,
        }:
            return False
        triggered = False
        any_missing = False
        for adapter, position in zip((self.lighter, self.rblighter), positions, strict=True):
            distance = position.liquidation_distance_pct()
            status = (
                "N/A"
                if position.quantity == 0
                else "NO_LIQUIDATION"
                if position.no_liquidation_price
                else "MISSING"
                if distance is None
                else "TRIGGERED"
                if distance <= task.risk_liquidation_distance_pct
                else "OK"
            )
            if self.repository:
                await self.repository.execute(
                    "INSERT INTO risk_checks(task_id,exchange,position_qty,mark_price,liquidation_price,distance_pct,status,checked_at) VALUES(?,?,?,?,?,?,?,?)",
                    (task.id, adapter.name, str(position.quantity), str(position.mark_price) if position.mark_price is not None else None,
                     str(position.liquidation_price) if position.liquidation_price is not None else None, str(distance) if distance is not None else None, status, utc_now().isoformat()),
                )
            key = (task.id, adapter.name)
            if status == "MISSING":
                any_missing = True
                task.status = TaskStatus.PAUSED_DATA_STALE
                missing_since = self._missing_since.setdefault(key, time.monotonic())
                triggered |= time.monotonic() - missing_since >= self.data_timeout_seconds
            else:
                self._missing_since.pop(key, None)
            triggered |= status == "TRIGGERED"
            if status in {"MISSING", "TRIGGERED"}:
                logger.warning(
                    "风险数据异常 task=%s exchange=%s status=%s position=%s distance_pct=%s",
                    task.id,
                    adapter.name,
                    status,
                    position.quantity,
                    distance,
                )
        if any_missing:
            self.blocked_tasks.add(task.id)
        else:
            self.blocked_tasks.discard(task.id)
        if triggered:
            logger.error("触发紧急退出 task=%s", task.id)
            await self.emergency_exit(task)
        elif self.repository:
            await self.repository.save_task(task)
        return triggered

    async def emergency_exit(self, task: Task) -> bool:
        async with self.exit_lock:
            started_at = utc_now()
            execution_id = f"risk-{uuid.uuid4().hex}"
            task.status = TaskStatus.RISK_EXIT
            self.blocked_tasks.add(task.id)
            if self.repository:
                await self.repository.save_task(task)
                now = started_at.isoformat()
                await self.repository.execute(
                    """INSERT INTO executions(execution_id,task_id,direction,state,opportunity_at,dispatch_at,
                       before_step,opportunity_json,averages_json,thresholds_json,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        execution_id,
                        task.id,
                        "RISK_EXIT",
                        "DISPATCHED",
                        now,
                        now,
                        task.step,
                        "{}",
                        "{}",
                        "{}",
                        now,
                        now,
                    ),
                )

            attempts: list[dict] = []
            definitive = True
            success: bool | None = None
            verification: dict = {}
            for attempt in range(1, 4):
                try:
                    positions = await asyncio.gather(
                        read_fresh_position(self.lighter, task.mapping),
                        read_fresh_position(self.rblighter, task.mapping),
                    )
                except Exception as exc:
                    attempts.append({"attempt": attempt, "error": f"fresh position read failed: {exc}"})
                    definitive = False
                    break
                order_specs = []
                for adapter, position, baseline in zip(
                    (self.lighter, self.rblighter),
                    positions,
                    (task.baseline_lighter_position, task.baseline_rblighter_position),
                    strict=True,
                ):
                    difference = position.quantity - baseline
                    if abs(difference) <= self.tolerance:
                        attempts.append(
                            {
                                "attempt": attempt,
                                "exchange": adapter.name,
                                "actual": str(position.quantity),
                                "baseline": str(baseline),
                                "action": "ALREADY_AT_BASELINE",
                            }
                        )
                        continue
                    if position.mark_price is None or position.mark_price <= 0:
                        attempts.append(
                            {
                                "attempt": attempt,
                                "exchange": adapter.name,
                                "actual": str(position.quantity),
                                "baseline": str(baseline),
                                "error": "fresh position has no positive mark price",
                            }
                        )
                        definitive = False
                        continue
                    request = OrderRequest(
                        f"risk-{uuid.uuid4().hex[:26]}",
                        "SELL" if difference > 0 else "BUY",
                        abs(difference),
                        position.mark_price,
                        self.slippage_bps,
                        True,
                    )
                    order_specs.append((adapter, request, position, baseline))
                if not definitive:
                    break
                if not order_specs:
                    break
                raw_results = await asyncio.gather(
                    *(adapter.place_order(task.mapping, request) for adapter, request, _, _ in order_specs),
                    return_exceptions=True,
                )
                coerced_results: list[OrderResult] = []
                for (adapter, request, position, baseline), raw in zip(order_specs, raw_results, strict=True):
                    result = self._coerce(adapter.name, request, raw)
                    coerced_results.append(result)
                    await self._save_exit_leg(execution_id, request, result)
                    attempts.append(
                        {
                            "attempt": attempt,
                            "exchange": adapter.name,
                            "actual": str(position.quantity),
                            "baseline": str(baseline),
                            "side": request.side,
                            "quantity": str(request.quantity),
                            "client_order_id": request.client_order_id,
                            "order_id": result.order_id,
                            "status": result.status,
                            "filled_qty": str(result.filled_qty),
                            "error": result.error,
                        }
                    )
                    if result.status not in {"FILLED", "PARTIALLY_FILLED", "CANCELED", "FAILED"}:
                        definitive = False
                if not definitive:
                    break

                # A reported fill may reach the REST position endpoint later.
                # Never issue another reduce-only request against the same
                # observed position while that authoritative fill is settling.
                if any(
                    result.filled_qty > self.tolerance
                    or result.status in {"FILLED", "PARTIALLY_FILLED"}
                    for result in coerced_results
                ):
                    success, verification = await self._confirm_exit(task)
                    if not success:
                        definitive = False
                        verification.setdefault(
                            "error",
                            "terminal fill received but final account truth did not converge; no blind retry",
                        )
                    break

            if success is None:
                if definitive:
                    success, verification = await self._confirm_exit(task)
                else:
                    success = False
                    verification = verification or {"error": "order outcome is uncertain"}
            report = {
                "execution_id": execution_id,
                "success": success,
                "started_at": started_at.isoformat(),
                "completed_at": utc_now().isoformat(),
                "attempts": attempts,
                "verification": verification,
            }
            self.last_exit_reports[task.id] = report
            if not success:
                task.status = TaskStatus.ERROR
                task.last_result = "RISK_EXIT_FAILED_KILL_SWITCH"
                logger.error("紧急退出失败 task=%s", task.id)
            else:
                task.step = 0
                task.status = TaskStatus.STOPPED
                task.last_result = "RISK_EXIT_SUCCEEDED"
                self.reset_task(task.id)
            if self.repository:
                await self.repository.save_task(task)
                await self.repository.execute(
                    """UPDATE executions SET state=?,after_step=?,reconciliation_status=?,
                       failure_reason=?,updated_at=? WHERE execution_id=?""",
                    (
                        "SUCCEEDED" if success else "FAILED",
                        task.step,
                        task.last_result,
                        None if success else json.dumps(decimal_json(report), ensure_ascii=False),
                        utc_now().isoformat(),
                        execution_id,
                    ),
                )
                await self.repository.event(
                    "RISK_EXIT_SUCCEEDED" if success else "RISK_EXIT_FAILED",
                    report,
                    task.id,
                )
            if success:
                logger.warning("紧急退出成功 task=%s", task.id)
            return success

    @staticmethod
    def _coerce(exchange: str, request: OrderRequest, value: object) -> OrderResult:
        if isinstance(value, OrderResult):
            return value
        return OrderResult(exchange, request.client_order_id, None, "UNKNOWN", error=str(value))

    async def _save_exit_leg(self, execution_id: str, request: OrderRequest, result: OrderResult) -> None:
        if not self.repository:
            return
        await self.repository.execute(
            """INSERT INTO execution_legs(execution_id,exchange,client_order_id,order_id,side,requested_qty,
               filled_qty,vwap,fee,status,request_sent_at,ack_at,first_fill_at,fully_filled_at,error)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                execution_id,
                result.exchange,
                result.client_order_id,
                result.order_id,
                request.side,
                str(request.quantity),
                str(result.filled_qty),
                str(result.vwap) if result.vwap is not None else None,
                str(result.fee),
                result.status,
                result.request_sent_at.isoformat() if result.request_sent_at else None,
                result.ack_at.isoformat() if result.ack_at else None,
                result.first_fill_at.isoformat() if result.first_fill_at else None,
                result.fully_filled_at.isoformat() if result.fully_filled_at else None,
                result.error,
            ),
        )
        for fill in result.fills:
            await self.repository.execute(
                "INSERT INTO fills(execution_id,exchange,trade_id,qty,price,fee,timestamp) VALUES(?,?,?,?,?,?,?)",
                (execution_id, result.exchange, fill.trade_id, str(fill.qty), str(fill.price), str(fill.fee), fill.timestamp.isoformat()),
            )
        if not result.fills and result.filled_qty > 0 and result.vwap is not None:
            await self.repository.execute(
                "INSERT INTO fills(execution_id,exchange,trade_id,qty,price,fee,timestamp) VALUES(?,?,?,?,?,?,?)",
                (
                    execution_id,
                    result.exchange,
                    result.order_id,
                    str(result.filled_qty),
                    str(result.vwap),
                    str(result.fee),
                    (result.first_fill_at or result.ack_at or utc_now()).isoformat(),
                ),
            )

    async def _confirm_exit(self, task: Task) -> tuple[bool, dict]:
        started = asyncio.get_running_loop().time()
        deadline = started + self.position_sync_timeout
        confirmations = 0
        attempts = 0
        last: dict = {}
        while True:
            attempts += 1
            try:
                lighter, rblighter, lighter_orders, rblighter_orders = await asyncio.gather(
                    read_fresh_position(self.lighter, task.mapping),
                    read_fresh_position(self.rblighter, task.mapping),
                    self.lighter.open_orders(task.mapping),
                    self.rblighter.open_orders(task.mapping),
                )
                last = {
                    "lighter_actual": str(lighter.quantity),
                    "lighter_baseline": str(task.baseline_lighter_position),
                    "rblighter_actual": str(rblighter.quantity),
                    "rblighter_baseline": str(task.baseline_rblighter_position),
                    "lighter_open_orders": len(lighter_orders),
                    "rblighter_open_orders": len(rblighter_orders),
                    "attempts": attempts,
                }
                matched = (
                    abs(lighter.quantity - task.baseline_lighter_position) <= self.tolerance
                    and abs(rblighter.quantity - task.baseline_rblighter_position) <= self.tolerance
                    and not lighter_orders
                    and not rblighter_orders
                )
                confirmations = confirmations + 1 if matched else 0
                if confirmations >= self.position_sync_confirmations:
                    last["confirmations"] = confirmations
                    return True, last
            except Exception as exc:
                confirmations = 0
                last = {"error": str(exc), "attempts": attempts}
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                last["confirmations"] = confirmations
                return False, last
            await asyncio.sleep(min(self.position_sync_poll, remaining))
