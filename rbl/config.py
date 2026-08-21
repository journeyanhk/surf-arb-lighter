from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def _int_or_none(name: str) -> int | None:
    value = os.getenv(name)
    return None if value in (None, "") else int(value)


@dataclass(frozen=True, slots=True)
class Settings:
    dry_run: bool = True
    live_trading_ack: bool = False
    poc_verified: bool = False
    database_url: str = "sqlite:///./arbitrage.db"
    window_size: int = 100_000
    min_entry_samples: int = 10_000
    max_quote_age_ms: int = 1500
    max_quote_skew_ms: int = 500
    execution_timeout_ms: int = 10_000
    position_sync_timeout_ms: int = 5_000
    position_sync_poll_ms: int = 100
    position_sync_confirmations: int = 2
    max_order_slippage_bps: Decimal = Decimal("20")
    position_tolerance: Decimal = Decimal("0.00000001")
    risk_data_timeout_seconds: int = 120
    risk_check_interval_seconds: int = 60
    telegram_status_interval_seconds: int = 1800
    account_query_min_interval_seconds: float = 1.0
    account_query_cache_seconds: float = 2.0
    account_query_backoff_base_seconds: float = 2.0
    account_query_backoff_max_seconds: float = 60.0
    enable_real_market_streams: bool = False
    lighter_base_url: str = "https://mainnet.zklighter.elliot.ai"
    lighter_ws_url: str = "wss://mainnet.zklighter.elliot.ai/stream"
    lighter_account_index: int | None = None
    lighter_api_key_index: int | None = None
    lighter_api_private_key: str | None = None
    rblighter_base_url: str = "https://api.rh.lighter.xyz"
    rblighter_ws_url: str = "wss://api.rh.lighter.xyz/stream"
    rblighter_account_index: int | None = None
    rblighter_api_key_index: int | None = None
    rblighter_api_private_key: str | None = None
    # Web 控制台鉴权：二选一。
    # 配置 AUTH_TOKEN 使用 Bearer；配置 AUTH_USERNAME/AUTH_PASSWORD 使用 Basic。
    # 均未配置时控制台不设鉴权（仅限本地/内网开发）。
    auth_token: str | None = None
    auth_username: str | None = None
    auth_password: str | None = None
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    # Server酱³ (ServerChan) 推送，仅需 SendKey/AppKey
    serverchan_send_key: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            dry_run=_bool("DRY_RUN", True),
            live_trading_ack=_bool("LIVE_TRADING_ACK", False),
            poc_verified=_bool("POC_VERIFIED", False),
            database_url=os.getenv("DATABASE_URL", "sqlite:///./arbitrage.db"),
            window_size=int(os.getenv("WINDOW_SIZE", "100000")),
            min_entry_samples=int(os.getenv("MIN_ENTRY_SAMPLES", "10000")),
            max_quote_age_ms=int(os.getenv("MAX_QUOTE_AGE_MS", "1500")),
            max_quote_skew_ms=int(os.getenv("MAX_QUOTE_SKEW_MS", "500")),
            execution_timeout_ms=int(os.getenv("EXECUTION_TIMEOUT_MS", "10000")),
            position_sync_timeout_ms=int(os.getenv("POSITION_SYNC_TIMEOUT_MS", "5000")),
            position_sync_poll_ms=int(os.getenv("POSITION_SYNC_POLL_MS", "100")),
            position_sync_confirmations=int(os.getenv("POSITION_SYNC_CONFIRMATIONS", "2")),
            max_order_slippage_bps=Decimal(os.getenv("MAX_ORDER_SLIPPAGE_BPS", "20")),
            position_tolerance=Decimal(os.getenv("POSITION_TOLERANCE", "0.00000001")),
            risk_data_timeout_seconds=int(os.getenv("RISK_DATA_TIMEOUT_SECONDS", "120")),
            risk_check_interval_seconds=int(os.getenv("RISK_CHECK_INTERVAL_SECONDS", "60")),
            telegram_status_interval_seconds=int(os.getenv("TELEGRAM_STATUS_INTERVAL_SECONDS", "1800")),
            account_query_min_interval_seconds=float(os.getenv("ACCOUNT_QUERY_MIN_INTERVAL_SECONDS", "1.0")),
            account_query_cache_seconds=float(os.getenv("ACCOUNT_QUERY_CACHE_SECONDS", "2.0")),
            account_query_backoff_base_seconds=float(os.getenv("ACCOUNT_QUERY_BACKOFF_BASE_SECONDS", "2.0")),
            account_query_backoff_max_seconds=float(os.getenv("ACCOUNT_QUERY_BACKOFF_MAX_SECONDS", "60.0")),
            enable_real_market_streams=_bool("ENABLE_REAL_MARKET_STREAMS", False),
            lighter_base_url=os.getenv("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai"),
            lighter_ws_url=os.getenv("LIGHTER_WS_URL", "wss://mainnet.zklighter.elliot.ai/stream"),
            lighter_account_index=_int_or_none("LIGHTER_ACCOUNT_INDEX"),
            lighter_api_key_index=_int_or_none("LIGHTER_API_KEY_INDEX"),
            lighter_api_private_key=os.getenv("LIGHTER_API_PRIVATE_KEY") or None,
            rblighter_base_url=os.getenv("RBLIGHTER_BASE_URL", "https://api.rh.lighter.xyz"),
            rblighter_ws_url=os.getenv("RBLIGHTER_WS_URL", "wss://api.rh.lighter.xyz/stream"),
            rblighter_account_index=_int_or_none("RBLIGHTER_ACCOUNT_INDEX"),
            rblighter_api_key_index=_int_or_none("RBLIGHTER_API_KEY_INDEX"),
            rblighter_api_private_key=os.getenv("RBLIGHTER_API_PRIVATE_KEY") or None,
            auth_token=os.getenv("AUTH_TOKEN") or None,
            auth_username=os.getenv("AUTH_USERNAME") or None,
            auth_password=os.getenv("AUTH_PASSWORD") or None,
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN") or None,
            telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID") or None,
            serverchan_send_key=os.getenv("SERVERCHAN_SEND_KEY") or None,
        )

    def assert_live_safe(self) -> None:
        if self.dry_run:
            raise RuntimeError("DRY_RUN=true: exchange writes are disabled")
        if not self.live_trading_ack or not self.poc_verified:
            raise RuntimeError("live trading requires LIVE_TRADING_ACK=true and POC_VERIFIED=true")
        missing = [
            name
            for name, value in {
                "LIGHTER_ACCOUNT_INDEX": self.lighter_account_index,
                "LIGHTER_API_KEY_INDEX": self.lighter_api_key_index,
                "LIGHTER_API_PRIVATE_KEY": self.lighter_api_private_key,
                "RBLIGHTER_ACCOUNT_INDEX": self.rblighter_account_index,
                "RBLIGHTER_API_KEY_INDEX": self.rblighter_api_key_index,
                "RBLIGHTER_API_PRIVATE_KEY": self.rblighter_api_private_key,
            }.items()
            if value is None
        ]
        if missing:
            raise RuntimeError("missing live configuration: " + ", ".join(missing))
        if min(
            self.position_sync_timeout_ms,
            self.position_sync_poll_ms,
            self.position_sync_confirmations,
        ) <= 0:
            raise RuntimeError("position synchronization settings must be positive")
