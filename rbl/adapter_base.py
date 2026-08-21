from __future__ import annotations

from typing import Protocol

from arbitrage.domain import AccountSnapshot, MarketMapping, OrderRequest, OrderResult, Position


class ExchangeAdapter(Protocol):
    name: str

    async def equity(self) -> object: ...
    async def position(self, mapping: MarketMapping) -> Position: ...
    async def fresh_position(self, mapping: MarketMapping) -> Position: ...
    async def account_snapshot(self, mapping: MarketMapping) -> AccountSnapshot: ...
    async def open_orders(self, mapping: MarketMapping) -> list[dict]: ...
    async def place_order(self, mapping: MarketMapping, request: OrderRequest) -> OrderResult: ...
    async def cancel_order(self, mapping: MarketMapping, order_id: str) -> bool: ...


async def read_fresh_position(adapter: ExchangeAdapter, mapping: MarketMapping) -> Position:
    """Read exchange truth without relying on an account WebSocket cache.

    The fallback keeps third-party/test adapters compatible while production
    adapters implement ``fresh_position`` explicitly.
    """
    reader = getattr(adapter, "fresh_position", None)
    if reader is not None:
        return await reader(mapping)
    snapshot = await adapter.account_snapshot(mapping)
    return snapshot.position
