from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import asdict, replace
from decimal import Decimal

from arbitrage.adapters.base import ExchangeAdapter, read_fresh_position
from arbitrage.adapters.account_requests import AccountReadUnavailable
from arbitrage.database import Repository
from arbitrage.domain import BPS, Direction, OrderRequest, OrderResult, Quote, Signal, Task, TaskStatus, decimal_json, utc_now


logger = logging.getLogger("arbitrage.execution")


class ExecutionCoordinator:
    def __init__(
        self,
        lighter: ExchangeAdapter,
        rblighter: ExchangeAdapter,
        repository: Repository | None,
        *,
        timeout_ms: int,
        max_slippage_bps: Decimal,
        tolerance: Decimal,
        position_sync_timeout_ms: int = 5_000,
        position_sync_poll_ms: int = 100,
        position_sync_confirmations: int = 2,
    ) -> None:
        self.lighter = lighter
        self.rblighter = rblighter
        self.repository = repository
        self.timeout = timeout_ms / 1000
        self.max_slippage_bps = max_slippage_bps
        self.tolerance = tolerance
        self.position_sync_timeout = position_sync_timeout_ms / 1000
        self.position_sync_poll = position_sync_poll_ms / 1000
        self.position_sync_confirmations = position_sync_confirmations
        self.lock = asyncio.Lock()
        self.last_dispatched_sequences: dict[str, dict[str, str]] = {}

    async def execute(
        self,
        task: Task,
        signal: Signal,
        latest_quote_provider: Callable[[], tuple[Quote, Quote] | None] | None = None,
    ) -> bool:
        if self.lock.locked() or task.status is not TaskStatus.RUNNING:
            return False
        async with self.lock:
            if task.status is not TaskStatus.RUNNING:
                return False
            try:
                before_l, before_p = await asyncio.gather(
                    read_fresh_position(self.lighter, task.mapping),
                    read_fresh_position(self.rblighter, task.mapping),
                )
            except AccountReadUnavailable as exc:
                first_failure = task.last_result != "PRE_TRADE_ACCOUNT_READ_FAILED"
                task.last_result = "PRE_TRADE_ACCOUNT_READ_FAILED"
                if self.repository and first_failure:
                    await self.repository.save_task(task)
                    await self.repository.event(
                        "PRE_TRADE_ACCOUNT_READ_FAILED",
                        {
                            "exchange": exc.exchange,
                            "status_code": exc.status_code,
                            "retry_after_seconds": exc.retry_after_seconds,
                        },
                        task.id,
                    )
                if first_failure:
                    logger.warning(
                        "下单前账户读取失败，本次不发单 task=%s exchange=%s status=%s retry_after=%.1fs",
                        task.id,
                        exc.exchange,
                        exc.status_code,
                        exc.retry_after_seconds,
                    )
                return False
            if task.last_result == "PRE_TRADE_ACCOUNT_READ_FAILED":
                task.last_result = None
            expected_before_l = task.baseline_lighter_position - Decimal(task.step) * task.order_qty
            expected_before_p = task.baseline_rblighter_position + Decimal(task.step) * task.order_qty
            if (
                abs(before_l.quantity - expected_before_l) > self.tolerance
                or abs(before_p.quantity - expected_before_p) > self.tolerance
            ):
                task.status = TaskStatus.PAUSED_RECONCILIATION
                task.last_result = "PRE_TRADE_POSITION_MISMATCH"
                if self.repository:
                    await self.repository.save_task(task)
                    await self.repository.event(
                        "PRE_TRADE_POSITION_MISMATCH",
                        {
                            "lighter_actual": before_l.quantity,
                            "lighter_expected": expected_before_l,
                            "rblighter_actual": before_p.quantity,
                            "rblighter_expected": expected_before_p,
                        },
                        task.id,
                    )
                logger.error(
                    "下单前真实仓位不一致，已禁止下单 task=%s lighter=%s/%s rblighter=%s/%s",
                    task.id,
                    before_l.quantity,
                    expected_before_l,
                    before_p.quantity,
                    expected_before_p,
                )
                return False
            initial_signal = signal
            revalidated_at = utc_now()
            if latest_quote_provider is not None:
                latest_pair = latest_quote_provider()
                signal, revalidation_reason = self._revalidate_signal(
                    task,
                    initial_signal,
                    latest_pair,
                )
                if signal is None:
                    task.last_result = "PRE_TRADE_SIGNAL_EXPIRED"
                    if self.repository:
                        await self.repository.save_task(task)
                        await self.repository.event(
                            "PRE_TRADE_SIGNAL_EXPIRED",
                            {
                                "reason": revalidation_reason,
                                "direction": initial_signal.direction.value,
                                "original_lighter_sequence": initial_signal.lighter_quote.sequence,
                                "original_rblighter_sequence": initial_signal.rblighter_quote.sequence,
                                "threshold": initial_signal.threshold,
                            },
                            task.id,
                        )
                    logger.info(
                        "仓位预检后最新 BBO 已不满足信号，取消本次下单 task=%s direction=%s reason=%s",
                        task.id,
                        initial_signal.direction.value,
                        revalidation_reason,
                    )
                    return False
            execution_id = uuid.uuid4().hex
            lighter_client_id = f"l-{execution_id[:28]}"
            rblighter_client_id = f"p-{execution_id[:28]}"
            before_step = task.step
            task.attempt_count += 1
            task.status = TaskStatus.EXECUTING
            self.last_dispatched_sequences[task.id] = {
                "lighter": signal.lighter_quote.sequence,
                "rblighter": signal.rblighter_quote.sequence,
            }
            logger.info(
                "发现套利信号 task=%s execution=%s direction=%s spread=%s threshold=%s excess_bps=%s",
                task.id,
                execution_id,
                signal.direction.value,
                signal.spread,
                signal.threshold,
                signal.excess_bps,
            )
            dispatch_at = utc_now()
            if self.repository:
                opportunity = {
                    "lighter": asdict(signal.lighter_quote),
                    "rblighter": asdict(signal.rblighter_quote),
                    "initial_lighter": asdict(initial_signal.lighter_quote),
                    "initial_rblighter": asdict(initial_signal.rblighter_quote),
                    "initial_opportunity_at": initial_signal.opportunity_at,
                    "revalidated_at": revalidated_at,
                }
                await self.repository.execute(
                    """INSERT INTO executions(execution_id,task_id,direction,state,opportunity_at,dispatch_at,
                       before_step,opportunity_json,averages_json,thresholds_json,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (execution_id, task.id, signal.direction.value, "DISPATCHED", signal.opportunity_at.isoformat(), dispatch_at.isoformat(), before_step,
                     json.dumps(decimal_json(opportunity)),
                     json.dumps({"selected": str(signal.average)}), json.dumps({"selected": str(signal.threshold)}), dispatch_at.isoformat(), dispatch_at.isoformat()),
                )
            lighter_ref = signal.lighter_quote.bid_price if signal.direction is Direction.L_SHORT_R_LONG else signal.lighter_quote.ask_price
            rblighter_ref = signal.rblighter_quote.ask_price if signal.direction is Direction.L_SHORT_R_LONG else signal.rblighter_quote.bid_price
            requests = (
                OrderRequest(lighter_client_id, signal.direction.lighter_side, task.order_qty, lighter_ref, self.max_slippage_bps),
                OrderRequest(rblighter_client_id, signal.direction.rblighter_side, task.order_qty, rblighter_ref, self.max_slippage_bps),
            )
            try:
                lighter_result, rblighter_result = await asyncio.wait_for(
                    asyncio.gather(self.lighter.place_order(task.mapping, requests[0]), self.rblighter.place_order(task.mapping, requests[1]), return_exceptions=True),
                    # Adapters use the configured interval to wait for terminal account events.
                    # The coordinator grace prevents canceling a coroutine just after broadcast.
                    timeout=self.timeout * 2 + 2,
                )
            except TimeoutError:
                lighter_result = rblighter_result = TimeoutError("execution timeout")
            results = [self._coerce(self.lighter.name, requests[0], lighter_result), self._coerce(self.rblighter.name, requests[1], rblighter_result)]
            await self._save_legs(execution_id, requests, results)
            task.status = TaskStatus.RECONCILING
            actual_expected_l = before_l.quantity + self._signed_fill(requests[0], results[0])
            actual_expected_p = before_p.quantity + self._signed_fill(requests[1], results[1])
            terminal_known = all(
                result.status in {"FILLED", "PARTIALLY_FILLED", "CANCELED", "FAILED"}
                for result in results
            )
            fills_ok = all(r.fully_filled and abs(r.filled_qty - task.order_qty) <= self.tolerance for r in results)
            if not terminal_known:
                await self._pause_uncertain(
                    execution_id,
                    task,
                    "order outcome is not terminal; automatic compensation is unsafe",
                    result="ORDER_OUTCOME_UNCERTAIN",
                    reconciliation_status="ORDER_OUTCOME_UNCERTAIN",
                )
                return False
            positions_synced = await self._wait_for_positions(
                task,
                execution_id,
                actual_expected_l,
                actual_expected_p,
            )
            if not positions_synced:
                # Complete fill reports are authoritative enough to advance the
                # theoretical step, which keeps manual reconcile/emergency-exit
                # expectations aligned. We still do not call it a success until
                # exchange positions become observable.
                if fills_ok:
                    task.step += signal.direction.step_delta
                await self._pause_uncertain(
                    execution_id,
                    task,
                    "terminal fills received but exchange positions did not synchronize before timeout",
                    result="POSITION_SYNC_TIMEOUT_FILLED" if fills_ok else "POSITION_SYNC_TIMEOUT_PARTIAL",
                    reconciliation_status="POSITION_SYNC_TIMEOUT",
                )
                return False
            if fills_ok:
                task.step += signal.direction.step_delta
                task.successful_trade_count += 1
                task.status = TaskStatus.RUNNING
                task.last_result = "SUCCEEDED"
                if self.repository and results[0].vwap and results[1].vwap:
                    if signal.direction is Direction.L_SHORT_R_LONG:
                        gross = (results[0].vwap - results[1].vwap) / results[1].vwap * Decimal("10000")
                        denominator = results[1].vwap * task.order_qty
                    else:
                        gross = (results[1].vwap - results[0].vwap) / results[0].vwap * Decimal("10000")
                        denominator = results[0].vwap * task.order_qty
                    # Exchanges do not use a uniform fee sign convention. A
                    # negative fee in a fill report is still a trading cost.
                    fee_bps = (abs(results[0].fee) + abs(results[1].fee)) / denominator * Decimal("10000") if denominator else Decimal("0")
                    await self.repository.execute("UPDATE executions SET gross_edge_bps=?,net_edge_bps=? WHERE execution_id=?", (str(gross), str(gross-fee_bps), execution_id))
                await self._finish(execution_id, "SUCCEEDED", task, results)
                logger.info("执行及对账成功 task=%s execution=%s step=%s", task.id, execution_id, task.step)
                return True
            task.last_result = "RECONCILING_FAILED"
            logger.warning("执行后对账失败 task=%s execution=%s，开始补偿", task.id, execution_id)
            await self._recover(task, execution_id, before_l.quantity, before_p.quantity, results)
            return False

    @staticmethod
    def _revalidate_signal(
        task: Task,
        signal: Signal,
        latest_pair: tuple[Quote, Quote] | None,
    ) -> tuple[Signal | None, str | None]:
        if latest_pair is None:
            return None, "latest_bbo_unavailable"
        lighter, rblighter = latest_pair
        if (
            lighter.exchange != "lighter"
            or rblighter.exchange != "rblighter"
            or not lighter.connected
            or not rblighter.connected
        ):
            return None, "latest_bbo_disconnected"
        if not lighter.positive() or not rblighter.positive():
            return None, "latest_bbo_non_positive"
        if min(lighter.bid_size, lighter.ask_size, rblighter.bid_size, rblighter.ask_size) < task.order_qty:
            return None, "latest_bbo_insufficient_top_size"
        if signal.direction is Direction.L_SHORT_R_LONG:
            spread = lighter.bid_price - rblighter.ask_price
            denominator = lighter.bid_price
        else:
            spread = rblighter.bid_price - lighter.ask_price
            denominator = rblighter.bid_price
        if spread < signal.threshold:
            return None, "latest_bbo_below_threshold"
        return (
            replace(
                signal,
                spread=spread,
                excess_bps=(spread - signal.threshold) / denominator * BPS,
                lighter_quote=lighter,
                rblighter_quote=rblighter,
            ),
            None,
        )

    @staticmethod
    def _signed_fill(request: OrderRequest, result: OrderResult) -> Decimal:
        return result.filled_qty if request.side == "BUY" else -result.filled_qty

    async def _wait_for_positions(
        self,
        task: Task,
        execution_id: str,
        expected_l: Decimal,
        expected_p: Decimal,
    ) -> bool:
        started = asyncio.get_running_loop().time()
        deadline = started + self.position_sync_timeout
        confirmations = 0
        attempts = 0
        last_l = last_p = None
        last_error: str | None = None
        while True:
            attempts += 1
            try:
                last_l, last_p = await asyncio.gather(
                    read_fresh_position(self.lighter, task.mapping),
                    read_fresh_position(self.rblighter, task.mapping),
                )
                last_error = None
                matched = (
                    abs(last_l.quantity - expected_l) <= self.tolerance
                    and abs(last_p.quantity - expected_p) <= self.tolerance
                )
                confirmations = confirmations + 1 if matched else 0
                if confirmations >= self.position_sync_confirmations:
                    logger.info(
                        "成交后仓位已同步 task=%s execution=%s elapsed_ms=%.3f attempts=%s lighter=%s rblighter=%s",
                        task.id,
                        execution_id,
                        (asyncio.get_running_loop().time() - started) * 1000,
                        attempts,
                        last_l.quantity,
                        last_p.quantity,
                    )
                    return True
            except Exception as exc:
                confirmations = 0
                last_error = str(exc)
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                logger.error(
                    "成交后仓位同步超时 task=%s execution=%s elapsed_ms=%.3f attempts=%s expected_lighter=%s observed_lighter=%s expected_rblighter=%s observed_rblighter=%s error=%s",
                    task.id,
                    execution_id,
                    (asyncio.get_running_loop().time() - started) * 1000,
                    attempts,
                    expected_l,
                    last_l.quantity if last_l is not None else None,
                    expected_p,
                    last_p.quantity if last_p is not None else None,
                    last_error,
                )
                return False
            await asyncio.sleep(min(self.position_sync_poll, remaining))

    async def _pause_uncertain(
        self,
        execution_id: str,
        task: Task,
        reason: str,
        *,
        result: str,
        reconciliation_status: str,
    ) -> None:
        task.status = TaskStatus.PAUSED_RECONCILIATION
        task.last_result = result
        now = utc_now().isoformat()
        if self.repository:
            await self.repository.execute(
                "UPDATE executions SET state=?,after_step=?,reconciliation_status=?,failure_reason=?,updated_at=? WHERE execution_id=?",
                (
                    "RECONCILIATION_UNCERTAIN",
                    task.step,
                    reconciliation_status,
                    reason,
                    now,
                    execution_id,
                ),
            )
            await self.repository.save_task(task)
            await self.repository.event(
                "EXECUTION_RECONCILIATION_UNCERTAIN",
                {
                    "execution_id": execution_id,
                    "result": result,
                    "reason": reason,
                    "step": task.step,
                },
                task.id,
            )
        logger.error(
            "执行结果不确定，任务已安全暂停 task=%s execution=%s reason=%s",
            task.id,
            execution_id,
            reason,
        )

    @staticmethod
    def _coerce(exchange: str, request: OrderRequest, value: object) -> OrderResult:
        if isinstance(value, OrderResult):
            return value
        # A raised/cancelled adapter call can have crossed the network write
        # boundary. Without an exchange terminal event it is never safe to
        # classify the order as a definitive failure and compensate the peer.
        return OrderResult(exchange, request.client_order_id, None, "UNKNOWN", error=str(value))

    async def _save_legs(self, execution_id: str, requests, results: list[OrderResult]) -> None:
        if not self.repository:
            return
        for request, result in zip(requests, results, strict=True):
            await self.repository.execute(
                """INSERT INTO execution_legs(execution_id,exchange,client_order_id,order_id,side,requested_qty,
                   filled_qty,vwap,fee,status,request_sent_at,ack_at,first_fill_at,fully_filled_at,error)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (execution_id, result.exchange, result.client_order_id, result.order_id, request.side, str(request.quantity), str(result.filled_qty),
                 str(result.vwap) if result.vwap is not None else None, str(result.fee), result.status,
                 result.request_sent_at.isoformat() if result.request_sent_at else None, result.ack_at.isoformat() if result.ack_at else None,
                 result.first_fill_at.isoformat() if result.first_fill_at else None, result.fully_filled_at.isoformat() if result.fully_filled_at else None, result.error),
            )
            reports = result.fills
            if reports:
                for fill in reports:
                    await self.repository.execute(
                        "INSERT INTO fills(execution_id,exchange,trade_id,qty,price,fee,timestamp) VALUES(?,?,?,?,?,?,?)",
                        (execution_id, result.exchange, fill.trade_id, str(fill.qty), str(fill.price), str(fill.fee), fill.timestamp.isoformat()),
                    )
            elif result.filled_qty > 0 and result.vwap is not None:
                await self.repository.execute(
                    "INSERT INTO fills(execution_id,exchange,trade_id,qty,price,fee,timestamp) VALUES(?,?,?,?,?,?,?)",
                    (execution_id, result.exchange, result.order_id, str(result.filled_qty), str(result.vwap), str(result.fee),
                     (result.first_fill_at or result.ack_at or utc_now()).isoformat()),
                )

    async def _finish(self, execution_id: str, state: str, task: Task, results: list[OrderResult], compensation: str | None = None) -> None:
        if self.repository:
            await self.repository.execute(
                "UPDATE executions SET state=?,after_step=?,reconciliation_status=?,compensation_result=?,updated_at=? WHERE execution_id=?",
                (state, task.step, state, compensation, utc_now().isoformat(), execution_id),
            )
            await self.repository.save_task(task)

    async def _recover(self, task: Task, execution_id: str, target_l: Decimal, target_p: Decimal, results: list[OrderResult]) -> None:
        task.status = TaskStatus.RECOVERING
        # Both legs are taker market orders. Their terminal account events are awaited by the
        # adapters; the normal and partial-fill paths therefore never submit an active cancel.
        recovered = True
        for adapter, target in ((self.lighter, target_l), (self.rblighter, target_p)):
            adapter_recovered = False
            # Compensation itself may partially fill. Re-query truth and retry a bounded number of times.
            for _ in range(20):
                position = await read_fresh_position(adapter, task.mapping)
                difference = position.quantity - target
                if abs(difference) <= self.tolerance:
                    adapter_recovered = True
                    break
                if position.mark_price is None or position.mark_price <= 0:
                    logger.error("补偿缺少有效标记价 exchange=%s task=%s", adapter.name, task.id)
                    break
                request = OrderRequest(f"c-{uuid.uuid4().hex[:28]}", "SELL" if difference > 0 else "BUY", abs(difference), position.mark_price, self.max_slippage_bps, True)
                raw_result = await adapter.place_order(task.mapping, request)
                result = self._coerce(adapter.name, request, raw_result)
                await self._save_legs(execution_id, (request,), [result])
                if result.status not in {"FILLED", "PARTIALLY_FILLED", "CANCELED", "FAILED"}:
                    logger.error("补偿结果不确定，禁止盲目重试 exchange=%s task=%s", adapter.name, task.id)
                    break
                if result.status in {"FILLED", "PARTIALLY_FILLED"} or result.filled_qty > self.tolerance:
                    expected_after = position.quantity + self._signed_fill(request, result)
                    synchronized = await self._wait_for_single_position(
                        adapter,
                        task,
                        expected_after,
                        execution_id,
                    )
                    if not synchronized:
                        logger.error(
                            "补偿成交后仓位未收敛，禁止盲目重试 exchange=%s task=%s",
                            adapter.name,
                            task.id,
                        )
                        break
                    # The next iteration uses newly confirmed exchange truth.
                    # This safely handles a definitive partial fill without
                    # resubmitting against a stale pre-fill position.
                    continue
            recovered &= adapter_recovered
        if recovered:
            # A compensated execution is a serious market-quality signal. Keep
            # the task paused so the same quote cannot immediately trigger a
            # new pair before an operator reviews the cause.
            task.status = TaskStatus.PAUSED
            task.last_result = "COMPENSATED"
            await self._finish(execution_id, "COMPENSATED", task, results, "positions restored")
            logger.warning("补偿完成 task=%s execution=%s", task.id, execution_id)
        else:
            task.status = TaskStatus.ERROR
            task.last_result = "KILL_SWITCH"
            await self._finish(execution_id, "FAILED", task, results, "kill switch: compensation failed")
            logger.error("补偿失败并触发停止 task=%s execution=%s", task.id, execution_id)

    async def _wait_for_single_position(
        self,
        adapter: ExchangeAdapter,
        task: Task,
        target: Decimal,
        execution_id: str,
    ) -> bool:
        deadline = asyncio.get_running_loop().time() + self.position_sync_timeout
        confirmations = 0
        while True:
            try:
                position = await read_fresh_position(adapter, task.mapping)
                if abs(position.quantity - target) <= self.tolerance:
                    confirmations += 1
                    if confirmations >= self.position_sync_confirmations:
                        return True
                else:
                    confirmations = 0
            except Exception as exc:
                confirmations = 0
                logger.warning(
                    "补偿仓位读取失败 task=%s execution=%s exchange=%s error=%s",
                    task.id,
                    execution_id,
                    adapter.name,
                    exc,
                )
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(self.position_sync_poll, remaining))
