# VPS 部署 & 实盘上线指南

本项目跑两个进程：**Node 后端**（监控 + 套利引擎，并托管前端静态页）、
**Python 执行边车**（用官方 lighter-sdk 做真实签名下单）。前端构建后由后端进程一起托管，
Caddy 只需反代一个端口。

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
LOCAL_DB_PATH=./data/arb # 嵌入式数据库（推荐，最省事）
ARB_SIDECAR_URL=http://127.0.0.1:8787
ARB_SIDECAR_TOKEN=<与 signer/.env 里 SIDECAR_TOKEN 完全一致>
```

> **数据库说明**：本项目数据（设置/任务/采样）存 Postgres，有三种方式：
> - **A. 嵌入式（推荐）**：设 `LOCAL_DB_PATH=./data/arb` 即可。用的是 PGlite（进程内
>   Postgres，WASM），**免安装、免密码、免建库**，数据落在该文件夹。`SURF_API_KEY` 可留空。
> - **B. 自建 Postgres 服务**：设 `DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/库名`
>   （设了它会优先）。见文末附录。
> - **C. 都不设**：使用 Surf 托管库（工作室内默认）。
>
> 启动时若看到一行 “DB schema sync failed / Surf …” 的告警，那是 SDK 在尝试同步它自家的
> 托管库，**无害可忽略** —— 你的数据走本地库（日志会打印 `[db] using EMBEDDED Postgres`
> 或 `LOCAL Postgres server`）。建表由后端启动时**自动幂等完成**，无需手动执行 SQL。

### 启动后端
```bash
cd backend && bun install     # 或 npm install
mkdir -p data                 # 嵌入式方式：确保数据目录存在
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

## 4. 构建前端（前后端合并为一个服务）

后端进程会**同时托管前端静态页和 API**，所以 Caddy 只要反代到一个端口即可。

```bash
# 用绝对根路径构建（BASE_PATH=/ 让前端的 /api 请求打到同源的绝对路径）
cd frontend && bun install && BASE_PATH=/ bun run build
# 产物在 frontend/dist —— 后端启动时会自动检测并托管它
```

> ⚠️ 一定要带 `BASE_PATH=/`。默认是 `./`（相对路径，工作室里用），合并部署时必须用绝对
> 根路径，否则子路由刷新会 404。

构建完后**重启后端**（第 3 步那个进程），它会打印 `[web] serving frontend from …/frontend/dist`，
此时访问 `http://127.0.0.1:3001/` 就能直接看到面板。

### Caddy 配置（推荐，一行反代）
`/etc/caddy/Caddyfile`：
```caddy
yourdomain.com {
    reverse_proxy 127.0.0.1:3001
}
```
```bash
sudo systemctl reload caddy
```
Caddy 自动签 HTTPS 证书，前端和 `/api/*` 全走这一个反代，无需分开配置。

> 如果暂时没有域名、只想本机/内网访问，把 `yourdomain.com` 换成 `:80` 即可。

### 备选：前后端分开托管（nginx）
若你更想让 nginx 直接托管静态文件、只反代 API（此时构建同样用 `BASE_PATH=/`）：
```nginx
location /api/ { proxy_pass http://127.0.0.1:3001; }
location /     { root /root/surf-arb-lighter/frontend/dist; try_files $uri /index.html; }
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

---

## 附录：改用自建 Postgres 服务（方式 B，可选，长期 7×24 运行强烈推荐）

> **为什么推荐？**「跑一段时间报 `stack depth limit exceeded`、重启才好」是嵌入式
> PGlite 的固有局限：它是进程内 WASM Postgres，**没有 autovacuum 后台回收进程**，而本
> 工具每 8 秒高频增删采样表，死元组只增不减，数小时后把 WASM 实例撑爆，所有查询报错，
> 只能靠重启换新实例。代码已内置定时 `VACUUM FULL` 自动压缩 + 检测到该错误立即自愈来缓解，
> **但根治办法是换成自建 PostgreSQL 服务**——它有 autovacuum、用的是操作系统 8MB 栈
> （PGlite 是固定 2MB），从根上消除这个问题。

**迁移只是改配置，不改代码**（`DATABASE_URL` 分支早已内置）：

```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE USER arb WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE arb OWNER arb;"
```
然后在 `backend/.env` 设 `DATABASE_URL=postgres://arb:yourpassword@127.0.0.1:5432/arb`
（它优先于 `LOCAL_DB_PATH`），重启后端即可。启动日志会打印
`[db] using LOCAL Postgres server (DATABASE_URL)`，建表由后端**自动幂等完成**，无需手动 SQL。

> **数据会不会丢？** 切换后是一套全新的空库，旧的本地任务/采样历史不会自动搬过去，
> 但**这对你几乎无影响**：设置项重填一次即可；「真实资金费累计」「真实盈亏总览」都是直接
> 读取交易所账户的真实数据（不依赖本地库），历史照样在。想保留旧任务记录再迁移也行，
> 但一般没必要。


**「password authentication failed」怎么办**：多半是 `pg_hba.conf` 用了 `peer`/`ident`
认证。改用密码认证：
```bash
# 找到配置文件
sudo -u postgres psql -c 'SHOW hba_file;'
# 编辑它，把本地 IPv4 行的认证方式改成 md5（或 scram-sha-256）：
#   host  all  all  127.0.0.1/32   md5
sudo systemctl restart postgresql
# 用 TCP 方式连（走 127.0.0.1 而非 unix socket）自测：
psql "postgres://arb:yourpassword@127.0.0.1:5432/arb" -c '\dt'
```
懒得折腾就用嵌入式（方式 A），`LOCAL_DB_PATH=./data/arb` 一行搞定，无需密码。
