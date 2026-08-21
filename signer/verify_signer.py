# Lighter / RBLighter 签名地基验证脚本
#
# 目的：在 VPS 上验证"能否用官方 SDK 为某个 venue 的私钥签出合法订单"。
# 关键：这里只调用 sign_create_order —— 只签名，不发送，全程零资金风险。
#
# 这是接实盘前的第一步。重点验证 RBLighter(api.rh.lighter.xyz) 是否
# 能用官方 SDK 签名——如果这里失败，套利第二条腿就无法实盘。
#
# 用法（在 Linux x86_64 VPS 上）：
#   python3 -m venv venv && source venv/bin/activate
#   pip install -r requirements.txt
#   # 填好下面的环境变量后：
#   python verify_signer.py
#
# 需要的环境变量（两边分别一套，不能混用）：
#   LIGHTER_BASE_URL, LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_INDEX, LIGHTER_API_PRIVATE_KEY
#   RBLIGHTER_BASE_URL, RBLIGHTER_ACCOUNT_INDEX, RBLIGHTER_API_KEY_INDEX, RBLIGHTER_API_PRIVATE_KEY
#   （可选）VERIFY_MARKET_INDEX  用于测试签名的市场，默认 1
#   （可选）LIGHTER_CHAIN_ID / RBLIGHTER_CHAIN_ID  链 ID，一般留空由 SDK 自动获取
#
# 注意：官方 SDK 新版构造函数用 api_private_keys={key_index: 私钥} 字典，
#       不再是 private_key=字符串。本脚本已适配。

import os
import sys
import asyncio

try:
    import lighter
except ImportError:
    print("缺少依赖：请先 pip install -r requirements.txt (lighter-sdk)")
    sys.exit(1)


def env(name, default=None):
    v = os.environ.get(name, default)
    return v.strip() if isinstance(v, str) else v


async def verify_venue(name, base_url, account_index, api_key_index, private_key, market_index, chain_id):
    print(f"\n=== 验证 {name} ({base_url}) ===")
    if not (base_url and private_key and account_index is not None and api_key_index is not None):
        print(f"  [跳过] {name} 配置不完整")
        return False

    key_index = int(api_key_index)
    try:
        # 新版官方 SDK：api_private_keys 是 {key_index: 私钥字符串} 字典
        kwargs = dict(
            url=base_url,
            account_index=int(account_index),
            api_private_keys={key_index: private_key},
        )
        if chain_id:
            kwargs["chain_id"] = int(chain_id)
        client = lighter.SignerClient(**kwargs)
    except Exception as e:
        print(f"  [失败] 初始化 SignerClient 出错：{e}")
        return False

    # 1) 校验 API Key 与账户是否匹配（官方 SDK 提供 check_client）
    try:
        err = client.check_client()
        if err is not None:
            print(f"  [警告] check_client 返回：{err}")
        else:
            print("  [OK] API Key 与账户校验通过")
    except Exception as e:
        print(f"  [警告] check_client 不可用或出错：{e}")

    # 2) 关键：只签名不发送，验证该 venue 能否签出合法订单
    try:
        # IOC 订单必须 order_expiry=0（DEFAULT_IOC_EXPIRY）；默认 -1 是 28 天限价单用的，
        # 传给 IOC 会被原生签名器拒为 "OrderExpiry is invalid"。
        result = client.sign_create_order(
            market_index=int(market_index),
            client_order_index=0,
            base_amount=1,          # 极小值，仅用于签名，不会发送
            price=1,                # 任意值，仅用于签名
            is_ask=True,
            order_type=client.ORDER_TYPE_LIMIT,
            time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=False,
            order_expiry=0,
        )
        # sign_create_order 返回 4 元组 (tx_type, tx_info, tx_hash, err)；err 在 index 3。
        # 成功时 err 为 None；失败时 SDK 不抛异常而是把错误塞进 err 字段。
        err = result[3] if isinstance(result, (tuple, list)) and len(result) >= 4 else None
        if err:
            print(f"  [失败] sign_create_order 返回错误：{err}")
            print(f"         => {name} 该腿签名未通过（实盘不可行，先排查参数/密钥）")
            return False
        print(f"  [成功] sign_create_order 签名成功 ✓  该 venue 可用官方 SDK 签名")
        # 注意已知问题 #98：部分版本 sign_create_order 会忽略 market_index，
        # 请核对返回 tx 里的 MarketIndex 是否等于你传入的值。
        preview = str(result[1])
        print(f"  tx 预览: {preview[:180]}{'...' if len(preview) > 180 else ''}")
        return True
    except Exception as e:
        print(f"  [失败] sign_create_order 抛出异常：{e}")
        print(f"         => {name} 可能无法用官方 SDK 签名（实盘该腿不可行）")
        return False
    finally:
        # 关闭 SDK 内部的 aiohttp 会话，避免 "Unclosed client session" 告警
        try:
            close = getattr(client, "close", None)
            if close:
                res = close()
                if asyncio.iscoroutine(res):
                    await res
        except Exception:
            pass


async def main():
    market_index = env("VERIFY_MARKET_INDEX", "1")

    lighter_ok = await verify_venue(
        "Lighter",
        env("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai"),
        env("LIGHTER_ACCOUNT_INDEX"),
        env("LIGHTER_API_KEY_INDEX"),
        env("LIGHTER_API_PRIVATE_KEY"),
        market_index,
        env("LIGHTER_CHAIN_ID"),
    )

    rblighter_ok = await verify_venue(
        "RBLighter",
        env("RBLIGHTER_BASE_URL", "https://api.rh.lighter.xyz"),
        env("RBLIGHTER_ACCOUNT_INDEX"),
        env("RBLIGHTER_API_KEY_INDEX"),
        env("RBLIGHTER_API_PRIVATE_KEY"),
        market_index,
        env("RBLIGHTER_CHAIN_ID"),
    )

    print("\n================ 结论 ================")
    print(f"  Lighter   可签名: {'是 ✓' if lighter_ok else '否 ✗'}")
    print(f"  RBLighter 可签名: {'是 ✓' if rblighter_ok else '否 ✗'}")
    if lighter_ok and rblighter_ok:
        print("  两条腿都能签名 → 可以进入下一步：搭建下单执行 sidecar")
    elif lighter_ok and not rblighter_ok:
        print("  只有 Lighter 能签名 → RBLighter 腿无法用官方 SDK 实盘，套利不可行")
        print("  需先确认 RBLighter 是否有独立签名方案，否则不要继续接实盘")
    else:
        print("  签名验证未通过 → 请先检查账户/API Key/私钥/BASE_URL 配置")
    print("=====================================")


if __name__ == "__main__":
    asyncio.run(main())
