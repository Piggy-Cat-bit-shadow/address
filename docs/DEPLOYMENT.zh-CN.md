# Address 部署文档

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

本文说明私密配置、首次数据同步、VPS 部署、反向代理、升级与备份。生产脚本面向 Linux AMD64 和 ARM64，全部运行状态位于 `/root/address`。

## 运行要求

- Linux AMD64 或 ARM64 VPS
- 完整首次导入需要 8 GB 内存（日本构建实测峰值约 6.5 GB RSS；同步任务默认在可用内存低于 2 GiB 时拒绝启动）；仅提供已初始化数据库的服务时 4 GB 足够
- 应用卷至少预留 60 GiB
- `git`、`curl`、`ca-certificates`、`xz-utils`、Python 3.10 或更新版本（生产使用 3.12）和 `venv`
- 已解析到 VPS 的域名，以及支持 HTTPS 的反向代理

安装脚本会下载项目固定的 Node.js 版本，无需在系统中预装 Node.js。

## 容量估算

PostgreSQL 生产数据保存在 `/root/postgresql/data`。首次导入会在 `/root/address/data/staging` 临时保留源文件和中间结果，发布成功后删除；建议至少预留 60 GiB，用于数据库、同步暂存、备份和恢复。实际容量取决于上游版本、地址目标量和保留快照。

首次导入受网络和 CPU 限制：普通 VPS 通常需要数小时到一天以上，且支持断点续跑——已完成国家重启后直接跳过。韩国邮编补齐受 Geoapify 每日 2,800 次上限约束，首次达标后会在后续每日同步中逐步补满目标量。

## API Key 与密钥

日常生成只查询 active PostgreSQL 中通过证据门禁的真实住宅记录。中国小区同步需要一个或多个高德、百度或腾讯服务端 Key，部署后在 `/admin/` 中配置；发布仍要求多平台一致。

| 变量 | 是否必需 | 功能 | 获取方式 |
|---|---|---|---|
| `CONFIG_MASTER_KEY` | 必需 | 加密 PostgreSQL 控制表中的地图凭据 | 使用 `openssl rand -base64 32` 生成，只保留在服务器。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 首次必需 | 初始化管理员身份 | 设置强密码；初始化完成后不再读取其明文。 |
| `AMAP_API_KEY` / 其他高德 WebService Key | 中国同步，仅服务端 | 小区 POI 导入 | 创建“Web 服务”Key 后，通过被忽略的运行配置导入首个值，或在 `/admin/` 添加；不要复用浏览器 JS Key。 |
| `AMAP_JS_API_KEY` | 可选首次导入 | 浏览器高德地图渲染 | 创建专用“Web 端（JS API）”Key，在控制台限制生产域名和本地测试来源，再通过被忽略的运行配置或 `/admin/` 导入。 |
| `AMAP_JS_SECURITY_CODE` | 与 JS Key 配套 | 鉴权高德 JS 服务请求 | 随 JS API Key 获取，只保留在服务器；应用加密保存并通过 `/_AMapService` 使用。 |
| 百度 Key | 中国同步 | 小区 POI 导入和交叉验证 | 创建服务端 Place API Key 后在 `/admin/` 添加。 |
| 腾讯 Key | 中国同步 | 小区 POI 导入和交叉验证 | 创建 WebService API Key 后在 `/admin/` 添加。 |
| `GEOAPIFY_API_KEY` | KR 首次导入必需 | K-apt 邮编反查（无有效邮编的记录会被丢弃）；也用于中国以外实时地理编码 | 按 [Geoapify 官方指南](https://www.geoapify.com/get-started-with-maps-api/)创建项目和 Key；免费额度足够覆盖导出器每日 2,800 次请求。 |
| `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET` | 成对可选 | 在线翻译备用通道 | 在[有道智云](https://ai.youdao.com/)创建自然语言翻译应用。 |
| `ONEMAP_ACCESS_TOKEN` | 可选 | 扩大新加坡 HDB 建筑匹配范围，以及地址存在性、邮编和坐标核验 | 按 [OneMap 认证文档](https://www.onemap.gov.sg/apidocs/authentication)获取；Token 有效期为 3 天并需要续期，OneMap 单独结果不构成住宅用途证据。 |
| `GOOGLE_GEOCODING_API_KEY`、`OS_DATA_HUB_API_KEY` | 可选 | API 运行期实时查询（不参与批量导入） | 分别在 Google Cloud 控制台和 OS Data Hub 获取。 |
| `SYNC_ADMIN_TOKEN` | VPS 必需 | 保护同步控制写操作 | 在本机随机生成，不属于第三方凭据。 |

### 各国凭据需求

- 无需任何凭据（Overture、Geofabrik/OSM 和官方开放数据）：US、CA、MX、GB、DE、FR、IT、ES、NL、RU、JP、HK、TW、TH、PH、VN、MY、SA、IN、AU、TR、BR、NG、ZA，以及 SG（HDB 源无 Token 即可完成，`ONEMAP_ACCESS_TOKEN` 仅用于扩大覆盖）。
- KR：必需 `GEOAPIFY_API_KEY`；缺少时 K-apt 住宅源无法通过质量门禁，首次初始化无法完成。
- CN：不经过批量 ETL。中国小区数据由 API 进程使用高德（可选百度、腾讯交叉验证）服务端 Key 同步，在 `/admin/` 配置。

公开生成和 IP 区域生成只查询 active PostgreSQL 住宅池。第三方平台密钥由后台同步使用，不会注入公开生成请求；IP 模式无覆盖时返回 `IP_REGION_NO_RESULT`，不替换成州省或全国地址。除非后台同步明确需要在线翻译，否则保留 `GOOGLE_TRANSLATION_ENABLED=false`。

## 密钥保护

仓库只提供占位模板：

| 模板 | 用途 |
|---|---|
| `.env.example` | 本地 WebUI 与 API 开发 |
| `server/sync/.env.example` | 同步参数参考 |
| `ops/address.env.example` | VPS 组合运行配置 |
| `ops/deploy.env.example` | 私密 SSH 部署配置 |

`.env`、`.deploy.env`、数据库、日志、运行状态、缓存、私钥和 `plan.md` 均被 Git 忽略。真实值只写入被忽略的私密文件，不要放入浏览器变量、源码、截图、Issue、命令输出或 CI 日志。

高德 JS API Key 按平台机制属于浏览器加载参数，会出现在浏览器请求中，因此必须使用专用 Key 并设置域名限制，不能把它当作服务端通用凭据。配套安全密钥、全部 WebService Key 和 `CONFIG_MASTER_KEY` 始终留在服务器。生产环境按[高德官方安全密钥方案](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)设置 `serviceHost=/_AMapService`，由 Node 服务读取密文安全密钥并只转发到固定高德上游。

VPS 使用权限为 `600` 的运行配置：

```bash
mkdir -p /root/address/runtime
cp /root/address/app/ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
```

生成主密钥和同步 Token，过程中不输出具体值：

```bash
token="$(openssl rand -hex 32)"
master_key="$(openssl rand -base64 32)"
sed -i "s/GENERATE_A_RANDOM_VALUE/$token/" /root/address/runtime/address.env
sed -i "s/GENERATE_32_BYTE_BASE64_VALUE/$master_key/" /root/address/runtime/address.env
unset token master_key
chmod 600 /root/address/runtime/address.env
```

至少需要替换 `YOUR_DOMAIN.example`、生成 `CONFIG_MASTER_KEY` 和 `SYNC_ADMIN_TOKEN`、设置一次性管理员密码并检查 `TRUST_PROXY`。地图 Key 统一在 `/admin/` 添加，不写入 Git 跟踪文件。

## 运行配置

| 变量 | 生产默认值 | 作用 |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `/web-api` | 浏览器使用的会话鉴权 API 前缀 |
| `API_HOST` | `127.0.0.1` | Hono 监听地址 |
| `API_PORT` | `8787` | Hono 监听端口 |
| `STATIC_ROOT` | `/root/address/app/dist` | Astro 构建结果 |
| `POSTGRES_URL` | `postgresql://address:...@127.0.0.1:5432/address` | PostgreSQL 连接串，仅保存在服务器运行配置 |
| `POSTGRES_POOL_MAX` / `POSTGRES_POOL_MIN` | `64` / `4` | 应用连接池上下限 |
| `CONFIG_MASTER_KEY` | 仅服务器保存的随机值 | 地图凭据和高德 JS 安全配置的 AES-256-GCM 主密钥 |
| `AMAP_JS_API_KEY` | 空 | 专用浏览器 JS API Key 的可选首次导入值 |
| `AMAP_JS_SECURITY_CODE` | 空 | 仅服务器使用的 JS 安全密钥可选首次导入值 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 一次性强密码 | 创建初始管理员身份 |
| `COOKIE_SECURE` | `true` | 仅通过 HTTPS 发送认证 Cookie |
| `ALLOWED_ORIGIN` | 公开 HTTPS 来源 | CORS 白名单 |
| `TRUST_PROXY` | 代理后为 `true` | 是否信任转发的客户端 IP 请求头 |
| `SYNC_HOST` | `127.0.0.1` | 同步管理监听地址 |
| `SYNC_PORT` | `8791` | 同步管理端口 |
| `SYNC_CONTROL_PUBLIC` | `false` | 禁止主 API 公开同步管理入口 |
| `SYNC_SCHEDULER_ENABLED` | `true` | 允许同步服务自动补齐首次初始化并执行每日更新 |
| `SYNC_UTC_HOUR` | `3` | 每日调度检查时间，UTC 小时 |

只有受控反向代理会覆盖转发 IP 请求头时才启用 `TRUST_PROXY`。端口 `8791` 始终保持私有。

地图显示开关保存在控制数据库并通过 `/admin/` 管理。Google 与高德分别具有中国和国外开关，默认均为 Google 开启、高德关闭。启用高德国外地图前需要申请[世界地图](https://lbs.amap.com/api/javascript-api-v2/guide/map/world-map)权限；未开通时保持国外高德关闭。

AreaCity 数据需先下载并解压 `ok_data_level4.csv` 到 `/root/address/data/imports/`，再在 `/admin/` 的“中国同步 → 导入 AreaCity”中填写 `imports/ok_data_level4.csv` 和发布版本。也可填写 HTTPS JSON/CSV 地址；本地路径仅允许位于数据目录内。

## 首次部署

### 1. 准备 VPS

```bash
apt-get update
apt-get install -y git curl ca-certificates xz-utils python3 python3-venv nginx
mkdir -p /root/address
git clone https://github.com/daimon3332/address.git /root/address/app
cd /root/address/app
./ops/install-runtime.sh
```

`install-runtime.sh` 会把固定 Node.js、Python 虚拟环境、Python 依赖和 npm 依赖安装到 `/root/address` 内。

### 2. 创建私密配置

```bash
mkdir -p /root/address/runtime
cp ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
editor /root/address/runtime/address.env
```

填写 `ALLOWED_ORIGIN=https://YOUR_DOMAIN.example`，生成 `SYNC_ADMIN_TOKEN`，然后只添加需要的可选服务凭据。

### 3. 构建 WebUI

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
npm run build
```

### 4. 导入位置目录

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
. ops/env.sh
npm run data:catalog
npm run data:catalog:import
```

`data:catalog` 下载开放的地区/城市/邮编参考数据（countries-states-cities-database 加 GeoNames，数百 MB），生成 `.data-cache/catalog-seed.sql`；`data:catalog:import` 将其写入 `POSTGRES_URL` 指向的数据库。此步骤必须在首次地址导入前完成：ETL 依赖目录表做导入期反向地理编码，目录为空会显著降低接受率。

### 5. 初始化全部国家

`SYNC_SCHEDULER_ENABLED=true`（模板默认值）时，直接启动服务即可——同步服务会自动执行支持断点续跑的首次导入，失败按退避自动重试：

```bash
/root/address/app/ops/start.sh
```

如需先在前台执行首次导入（要求 supervisor 已停止），使用：

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

每个国家独立验证和发布，重启后可复用已完成缓存。耗时取决于 VPS CPU、磁盘、网络和上游状态（通常数小时到一天以上）。导入进行期间，API 会先提供已发布国家的数据。

### 6. 验证服务

```bash
/root/address/app/ops/status.sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/data-health
```

## Nginx 与 HTTPS

沿用现有证书流程，把公开域名代理到 API 进程：

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN.example;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

防火墙只公开 HTTP/HTTPS，API 和同步管理均监听回环地址。TLS 生效后，`ALLOWED_ORIGIN` 使用完全一致的 HTTPS 来源。

## 同步与运维

- 首次任务覆盖 26 个 ETL 国家（中国由 API 进程单独同步），支持断点续跑。
- 稳态调度要求 `SYNC_SCHEDULER_ENABLED=true`：每天 03:00 UTC 检查，每天最多更新一个到期国家。
- 国家同步成功后，下一周期为 30 天。
- 新快照失败时继续保留旧 active 数据。
- 发布成功后默认删除原始源文件，除非明确开启保留。

```bash
# 服务启停与状态
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# 创建 PostgreSQL 自定义格式备份
/root/address/app/ops/backup.sh

# 恢复 /root/address/backups 下的备份
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.dump
```

备份注意事项：

- `backup.sh` 使用 `pg_dump --format=custom`；恢复脚本使用 `pg_restore --clean --if-exists`。
- 任何备份都应排除 `data/staging`（`ADDRESS_SYNC_CACHE_DIR`）：其中只有可重新下载的源产物，导入期间可达数十 GiB。
- 单个备份包含地址表、控制表、凭据密文、同步状态和审计数据。备份文件必须保持权限 `600`，并定期使用 `pg_restore --list` 验证可读性。
- PostgreSQL 服务器使用 `max_connections=256`；应用池默认最大 64、最小 4，可通过 `POSTGRES_POOL_MAX` 和 `POSTGRES_POOL_MIN` 调整。

项目 supervisor（`ops/supervisor.mjs`，由 `ops/start.sh` 启动）运行并守护两个进程：API 服务（`server/api/server.ts`，端口 `8787`）和同步服务（`server/sync/index.mjs`，端口 `8791`）。它基于进程管理，不安装 systemd 服务或 cron。需要 VPS 重启后自动启动时，把 `ops/start.sh` 接入主机已有的启动机制。

## 部署后续提交

在开发机执行：

```bash
cp ops/deploy.env.example .deploy.env
chmod 600 .deploy.env
editor .deploy.env
bash ops/deploy.sh --dist
```

部署脚本会归档当前 `HEAD`，通过 SSH 上传，保留 VPS 数据库、私密运行配置和服务器黑名单，重启 supervisor 并执行健康检查。纯文档变更可使用 `--no-restart`。

## 生产检查清单

- DNS 与 HTTPS 已生效。
- `ALLOWED_ORIGIN` 是完全一致的公开 HTTPS 来源。
- `TRUST_PROXY=true` 只用于受控代理后方。
- `SYNC_ADMIN_TOKEN` 随机且私密，Git 历史中没有具体值。
- `SYNC_CONTROL_PUBLIC=false`，端口 `8791` 未公开。
- 可选服务 Key 已在服务商侧设置限制和用量告警。
- 高德 JS Key 为专用且已限制域名；安全密钥未出现在浏览器响应、日志或 Git 中。
- 仅在确认世界地图权限后启用国外高德，并已测试四个地图开关。
- 数据库初始化后，`npm run check:production` 通过。
- 已生成当前备份并验证恢复流程。
- 应用卷至少 60 GiB，并启用剩余空间监控。
