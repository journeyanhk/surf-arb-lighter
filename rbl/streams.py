from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from decimal import Decimal

import websockets

from arbitrage.domain import Quote


logger = logging.getLogger("arbitrage.streams")


def parse_lighter_ticker(payload: dict, symbol: str) -> Quote | None:
    return _parse_ticker(payload, symbol, "lighter")


def parse_rblighter_ticker(payload: dict, symbol: str) -> Quote | None:
    return _parse_ticker(payload, symbol, "rblighter")


def _parse_ticker(payload: dict, symbol: str, exchange: str) -> Quote | None:
    if payload.get("type") != "update/ticker" or "ticker" not in payload:
        return None
    ticker = payload["ticker"]
    now = int(time.time() * 1000)
    return Quote(
        exchange, symbol, Decimal(ticker["b"]["price"]), Decimal(ticker["b"]["size"]),
        Decimal(ticker["a"]["price"]), Decimal(ticker["a"]["size"]), int(payload["timestamp"]), now,
        str(payload["nonce"]), True,
    )


async def lighter_quotes(url: str, market_index: int, symbol: str) -> AsyncIterator[Quote]:
    delay = 1
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                await ws.send(json.dumps({"type": "subscribe", "channel": f"ticker/{market_index}"}))
                logger.info("Lighter 行情流已连接 market_index=%s symbol=%s", market_index, symbol)
                delay = 1
                async for raw in ws:
                    quote = parse_lighter_ticker(json.loads(raw), symbol)
                    if quote:
                        yield quote
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Lighter 行情流断开，%s 秒后重连：%s", delay, exc)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


async def rblighter_quotes(url: str, market_index: int, symbol: str) -> AsyncIterator[Quote]:
    delay = 1
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                await ws.send(json.dumps({"type": "subscribe", "channel": f"ticker/{market_index}"}))
                logger.info("RBLighter 行情流已连接 market_index=%s symbol=%s", market_index, symbol)
                delay = 1
                async for raw in ws:
                    quote = parse_rblighter_ticker(json.loads(raw), symbol)
                    if quote:
                        yield quote
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("RBLighter 行情流断开，%s 秒后重连：%s", delay, exc)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
