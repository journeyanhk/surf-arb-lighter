# surf-arb-lighter

Lighter ↔ RBLighter 跨交易所价差套利监控与执行工具。基于 Surf SDK（Vite + Express/Bun + Tailwind），
在 [RobinHoodLighter---Lighter-Arbitrage-Tool](https://github.com/lihanyu81/RobinHoodLighter---Lighter-Arbitrage-Tool)
策略逻辑基础上做的功能复刻，前端为扁平极简风格。

> ⚠️ **风险提示**：默认是**监控 + 模拟撮合**（零风险）。接实盘需启动 `signer/` 下的
> 官方 Python 签名边车，并按 [DEPLOY.md](./DEPLOY.md) 分步放开开关。签名全程由官方
> `lighter-sdk` 完成，**本项目不手写任何签名**。首次实盘务必用极小额验证。

## 功能

- **实时价差监控**：拉取 Lighter (`mainnet.zklighter.elliot.ai`) 与 RBLighter (`api.rh.lighter.xyz`)
  公开订单簿，按 bps 计算双向价差。
- **后台采样与任务执行**：服务端自调度循环，页面关闭也持续采样/推进任务。
- **策略参数可配**：价差阈值、最小样本数、滑点、名义额、扫描节奏、扫描市场数等。
- **健康指标**：后台运行状态卡片，轮询 `/monitor/health`。
- **设置页**：交易所账户 / 代理 / 通知，保存至本地数据库（密钥字段脱敏返回）。
- **任务生命周期**：ENTERING → RECONCILING → HOLDING → EXITING → CLOSED，支持暂停/恢复/平仓。
- **实盘执行（可选）**：通过 `signer/sidecar.py`（官方 lighter-sdk）下真实 IOC 单，
  按持仓变化真实对账，单腿成交自动 reduce-only 补偿。默认关闭，见 [DEPLOY.md](./DEPLOY.md)。

## 目录结构

- `frontend/` — React + TanStack Query 前端（监控面板 / 设置两个 Tab）
- `backend/` — Express/Bun 后端（routes、lib/engine、lib/runner、lib/sidecar、db/schema）
- `signer/` — 官方 `lighter-sdk` 签名验证脚本 + 实盘执行边车（sidecar.py）
- `DEPLOY.md` — VPS 部署与实盘分步上线指南

## 本地开发

```bash
cd backend  && bun install
cd frontend && bun install
# dev server 由外部托管，前端 http://localhost:5173，后端 http://localhost:3001/api
```

## 接实盘前的签名验证（务必先做）

```bash
cd signer
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
# 填好 LIGHTER_* / RBLIGHTER_* 环境变量后：
python verify_signer.py   # 只签名不发送，验证两个 venue 能否用官方 SDK 签单
```

RBLighter 能签成功，即可按 [DEPLOY.md](./DEPLOY.md) 启动执行边车接实盘（默认 DRY_RUN，零风险）。
