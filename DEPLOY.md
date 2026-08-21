# VPS 部署 & 实盘上线指南

本项目分三个进程：**前端**（构建后为静态文件）、**Node 后端**（监控 + 套利引擎）、
**Python 执行边车**（用官方 lighter-sdk 做真实签名下单）。

> ⚠️ 只有当「面板实盘开关全开」**且**「边车以 `SIDECAR_DRY_RUN=false` 运行」时才会下真实单。
> 任一条件不满足都是安全的模拟/只签名状态。**首次上线务必用极小额（如 10~15 USD）验证。**

---

## 0. 前置

- 一台 **Linux x86_64** VPS（官方 SDK 带 C 扩展，仅支持 x86_64）。
- Node 18+（或 Bun）、Python 3.10+、git。

```bash
git clone https://github.com/journeyanhk/surf-arb-lighter.git
cd surf-arb-lighter
```

---

## 1. 先跑签名验证（零资金风险，必做）

```bash
cd signer
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # 填入两个 venue 的 API 私钥等
set -a; source .env; set +a
python verify_signer.py
```

两个 venue 都出现 `[成功] sign_create_order 签名成功 ✓` 且无 `OrderExpiry` 报错，才继续。

---

## 2. 启动执行边车（默认 DRY_RUN，先不真实下单）

`signer/.env` 里保持 `SIDECAR_DRY_RUN=true`、`SIDECAR_MAX_NOTIONAL_USD=15`，
并设置一个长随机 `SIDECAR_TOKEN`。

手动试跑：
```bash
cd signer && source venv/bin/activate
set -a; source .env; set +a
python sidecar.py
# 另开终端验证（TOKEN 换成你的）：
curl -s http://127.0.0.1:8787/health -H "X-Sidecar-Token: <你的TOKEN>"
```
`health` 应返回 `dry_run:true`，两个 venue `ready:true`。

### systemd 常驻（推荐）
`/etc/systemd/system/arb-sidecar.service`：
```ini
[Unit]
Description=Arb signing sidecar
After=network-online.target

[Service]
WorkingDirectory=/root/surf-arb-lighter/signer
EnvironmentFile=/root/surf-arb-lighter/signer/.env
ExecStart=/root/surf-arb-lighter/signer/venv/bin/python sidecar.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now arb-sidecar
sudo journalctl -u arb-sidecar -f
```

---

## 3. 启动 Node 后端（连上边车）

`backend/.env`：
```
BACKEND_PORT=3001
SURF_API_KEY=            # 用本地数据库时可留空
DATABASE_URL=postgres://arb:yourpassword@127.0.0.1:5432/arb
ARB_SIDECAR_URL=http://127.0.0.1:8787
ARB_SIDECAR_TOKEN=<与 signer/.env 里 SIDECAR_TOKEN 完全一致>
```

> **数据库说明**：本项目数据（设置/任务/采样）存 Postgres。设了 `DATABASE_URL` 就用你
> VPS 本地的库，**完全自给自足、不依赖 Surf 托管库，`SURF_API_KEY` 可留空**。启动时若看到
> 一行 “DB schema sync failed / Surf …” 的告警，那是 SDK 在尝试同步它自家的托管库，**无害可忽略**
> ——你的数据走的是本地库（日志会打印 `[db] using LOCAL Postgres`）。

### 先装本地 Postgres（Ubuntu/Debian 示例）
```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE USER arb WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE arb OWNER arb;"
# 自测连通：
psql "postgres://arb:yourpassword@127.0.0.1:5432/arb" -c '\dt'
```
建表由后端启动时**自动完成**（幂等迁移），无需手动执行 SQL。

### 启动后端
```bash
cd backend && bun install     # 或 npm install
bun run server.js             # 生产可用 systemd/pm2 常驻
```

`/etc/systemd/system/arb-backend.service` 同理（`ExecStart=/usr/bin/bun run server.js`，
`EnvironmentFile=.../backend/.env`）。

验证数据库 + 边车：
```bash
curl -s http://127.0.0.1:3001/api/settings          # 返回配置 JSON = 本地库通了
curl -s http://127.0.0.1:3001/api/monitor/sidecar   # configured:true 且 venues ready:true = 边车通了
```

---

## 4. 构建并托管前端

```bash
cd frontend && bun install && bun run build
# 产物在 frontend/dist —— 用 nginx/caddy 托管，并把 /api 反代到 127.0.0.1:3001
```
nginx 片段：
```nginx
location /api/ { proxy_pass http://127.0.0.1:3001; }
location /    { root /root/surf-arb-lighter/frontend/dist; try_files $uri /index.html; }
```

---

## 5. 从模拟切到实盘（分步、可回退）

到这一步全链路都在跑，但仍是安全的（边车 DRY_RUN + 面板开关未全开）。按顺序放开：

1. **面板 → 设置**：填好两个交易所账户；`order_notional_usd` 设成 **很小**（如 12）。
2. 打开面板里的实盘开关：`live_trading_ack`、`poc_verified`、`enable_real_market_streams`，
   并把 `dry_run` 关掉。此时 `/api/monitor/scan` 的 `live_ready` 应变 `true`。
3. 但**边车仍是 DRY_RUN**，所以还不会真下单 —— 先观察引擎是否正常开/平任务（只签名）。
4. 一切正常后，改 `signer/.env`：`SIDECAR_DRY_RUN=false`，
   `sudo systemctl restart arb-sidecar`。**此刻起才会下真实单。**
5. 用 10~15 USD 名义额观察几笔：
   - 任务能 ENTERING→RECONCILING→HOLDING→EXITING→CLOSED 正常流转；
   - 出现单腿成交时，`note` 显示已 reduce-only 补偿，账户无裸敞口；
   - 边车日志 `journalctl -u arb-sidecar -f` 有真实 `tx_hash`。
6. 确认无误后再逐步调大 `order_notional_usd` 和 `SIDECAR_MAX_NOTIONAL_USD`。

### 紧急停止（kill switch）
- 最快：`sudo systemctl stop arb-sidecar` —— Node 引擎立即回退，不再有任何真实下单。
- 或面板打开 `dry_run` / 关掉 `auto_execute`。

---

## 安全边界一览
- 边车只监听 `127.0.0.1`，且每个请求校验 `SIDECAR_TOKEN`。
- 单笔名义额双重上限：面板 `order_notional_usd` + 边车 `SIDECAR_MAX_NOTIONAL_USD`。
- 下单量按市场 `min_base_amount` / 精度校验，非法直接拒绝。
- 单腿成交自动 reduce-only 平补，不留裸敞口。
- 实盘执行任何异常 → 任务置 `PAUSED` 待人工检查，绝不静默继续。
- **签名永远由官方 SDK 完成，本项目不手写任何签名。**
