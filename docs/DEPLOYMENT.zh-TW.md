# Address 部署文檔

[English](DEPLOYMENT.md) · [簡體中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

本文說明私密配置、首次數據同步、VPS 部署、反向代理、升級與備份。生產腳本面向 Linux AMD64 和 ARM64，全部運行狀態位於 `/root/address`。

## 運行要求

- Linux AMD64 或 ARM64 VPS
- 完整首次導入需要 8 GB 內存（日本構建實測峰值約 6.5 GB RSS；同步任務默認在可用內存低於 2 GiB 時拒絕啟動）；僅提供已初始化數據庫的服務時 4 GB 足夠
- 應用卷至少預留 60 GiB
- `git`、`curl`、`ca-certificates`、`xz-utils`、Python 3.10 或更新版本（生產使用 3.12）和 `venv`
- 已解析到 VPS 的域名，以及支持 HTTPS 的反向代理

安裝腳本會下載項目固定的 Node.js 版本，無需在系統中預裝 Node.js。

## 容量估算

PostgreSQL 生產數據保存在 `/root/postgresql/data`。首次導入會在 `/root/address/data/staging` 臨時保留源文件和中間結果，發佈成功後刪除；建議至少預留 60 GiB，用於數據庫、同步暫存、備份和恢復。實際容量取決於上游版本、地址目標量和保留快照。

首次導入受網絡和 CPU 限制：普通 VPS 通常需要數小時到一天以上，且支持斷點續跑——已完成國家重啟後直接跳過。韓國郵編補齊受 Geoapify 每日 2,800 次上限約束，首次達標後會在後續每日同步中逐步補滿目標量。

## API Key 與密鑰

日常生成只查詢 active PostgreSQL 中通過證據門禁的真實住宅記錄。中國小區同步需要一個或多個高德、百度或騰訊服務端 Key，部署後在 `/admin/` 中配置；發佈仍要求多平台一致。

| 變量 | 是否必需 | 功能 | 獲取方式 |
|---|---|---|---|
| `CONFIG_MASTER_KEY` | 必需 | 加密 PostgreSQL 控制表中的地圖憑據 | 使用 `openssl rand -base64 32` 生成，只保留在伺服器。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 首次必需 | 初始化管理員身份 | 設置強密碼；初始化完成後不再讀取其明文。 |
| `AMAP_API_KEY` / 其他高德 WebService Key | 中國同步，僅伺服端 | 小區 POI 導入 | 創建“Web 服務”Key 後，透過被忽略的執行配置導入首個值，或在 `/admin/` 添加；不要復用瀏覽器 JS Key。 |
| `AMAP_JS_API_KEY` | 可選首次導入 | 瀏覽器高德地圖渲染 | 創建專用“Web 端（JS API）”Key，在控制台限制生產域名和本地測試來源，再通過被忽略的運行配置或 `/admin/` 導入。 |
| `AMAP_JS_SECURITY_CODE` | 與 JS Key 配套 | 鑑權高德 JS 服務請求 | 隨 JS API Key 獲取，只保留在伺服器；應用加密保存並通過 `/_AMapService` 使用。 |
| 百度 Key | 中國同步 | 小區 POI 導入和交叉驗證 | 創建服務端 Place API Key 後在 `/admin/` 添加。 |
| 騰訊 Key | 中國同步 | 小區 POI 導入和交叉驗證 | 創建 WebService API Key 後在 `/admin/` 添加。 |
| `GEOAPIFY_API_KEY` | KR 首次導入必需 | K-apt 郵編反查（無有效郵編的記錄會被丟棄）；也用於中國以外實時地理編碼 | 按 [Geoapify 官方指南](https://www.geoapify.com/get-started-with-maps-api/)創建項目和 Key；免費額度足夠覆蓋導出器每日 2,800 次請求。 |
| `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET` | 成對可選 | 在線翻譯備用通道 | 在[有道智雲](https://ai.youdao.com/)創建自然語言翻譯應用。 |
| `ONEMAP_ACCESS_TOKEN` | 可選 | 擴大新加坡 HDB 建築匹配範圍，以及地址存在性、郵編和座標核驗 | 按 [OneMap 認證文檔](https://www.onemap.gov.sg/apidocs/authentication)獲取；Token 有效期為 3 天並需要續期，OneMap 單獨結果不構成住宅用途證據。 |
| `GOOGLE_GEOCODING_API_KEY`、`OS_DATA_HUB_API_KEY` | 可選 | API 運行期實時查詢（不參與批量導入） | 分別在 Google Cloud 控制台和 OS Data Hub 獲取。 |
| `SYNC_ADMIN_TOKEN` | VPS 必需 | 保護同步控制寫操作 | 在本機隨機生成，不屬於第三方憑據。 |

### 各國憑據需求

- 無需任何憑據（Overture、Geofabrik/OSM 和官方開放數據）：US、CA、MX、GB、DE、FR、IT、ES、NL、RU、JP、HK、TW、TH、PH、VN、MY、SA、IN、AU、TR、BR、NG、ZA，以及 SG（HDB 源無 Token 即可完成，`ONEMAP_ACCESS_TOKEN` 僅用於擴大覆蓋）。
- KR：必需 `GEOAPIFY_API_KEY`；缺少時 K-apt 住宅源無法通過質量門禁，首次初始化無法完成。
- CN：不經過批量 ETL。中國小區數據由 API 進程使用高德（可選百度、騰訊交叉驗證）服務端 Key 同步，在 `/admin/` 配置。

公開生成和 IP 區域生成只查詢 active PostgreSQL 住宅池。第三方平台密鑰由後台同步使用，不會注入公開生成請求；IP 模式無覆蓋時返回 `IP_REGION_NO_RESULT`，不替換成州省或全國地址。除非後台同步明確需要在線翻譯，否則保留 `GOOGLE_TRANSLATION_ENABLED=false`。

## 密鑰保護

倉庫只提供佔位模板：

| 模板 | 用途 |
|---|---|
| `.env.example` | 本地 WebUI 與 API 開發 |
| `server/sync/.env.example` | 同步參數參考 |
| `ops/address.env.example` | VPS 組合運行配置 |
| `ops/deploy.env.example` | 私密 SSH 部署配置 |

`.env`、`.deploy.env`、數據庫、日誌、運行狀態、緩存、私鑰和 `plan.md` 均被 Git 忽略。真實值只寫入被忽略的私密文件，不要放入瀏覽器變量、源碼、截圖、Issue、命令輸出或 CI 日誌。

高德 JS API Key 按平台機制屬於瀏覽器加載參數，會出現在瀏覽器請求中，因此必須使用專用 Key 並設置域名限制，不能把它當作伺服器端通用憑據。配套安全密鑰、全部 WebService Key 和 `CONFIG_MASTER_KEY` 始終留在伺服器。生產環境按[高德官方安全密鑰方案](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)設置 `serviceHost=/_AMapService`，由 Node 服務讀取密文安全密鑰並只轉發到固定高德上游。

VPS 使用權限為 `600` 的運行配置：

```bash
mkdir -p /root/address/runtime
cp /root/address/app/ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
```

生成主密鑰和同步 Token，過程中不輸出具體值：

```bash
token="$(openssl rand -hex 32)"
master_key="$(openssl rand -base64 32)"
sed -i "s/GENERATE_A_RANDOM_VALUE/$token/" /root/address/runtime/address.env
sed -i "s/GENERATE_32_BYTE_BASE64_VALUE/$master_key/" /root/address/runtime/address.env
unset token master_key
chmod 600 /root/address/runtime/address.env
```

至少需要替換 `YOUR_DOMAIN.example`、生成 `CONFIG_MASTER_KEY` 和 `SYNC_ADMIN_TOKEN`、設置一次性管理員密碼並檢查 `TRUST_PROXY`。地圖 Key 統一在 `/admin/` 添加，不寫入 Git 跟蹤文件。

## 運行配置

| 變量 | 生產默認值 | 作用 |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `/web-api` | 瀏覽器使用的會話鑑權 API 前綴 |
| `API_HOST` | `127.0.0.1` | Hono 監聽地址 |
| `API_PORT` | `8787` | Hono 監聽端口 |
| `STATIC_ROOT` | `/root/address/app/dist` | Astro 構建結果 |
| `POSTGRES_URL` | `postgresql://address:...@127.0.0.1:5432/address` | PostgreSQL 連接串，只保存在伺服器運行配置 |
| `POSTGRES_POOL_MAX` / `POSTGRES_POOL_MIN` | `64` / `4` | 應用連接池上下限 |
| `CONFIG_MASTER_KEY` | 僅伺服器保存的隨機值 | 地圖憑據和高德 JS 安全配置的 AES-256-GCM 主密鑰 |
| `AMAP_JS_API_KEY` | 空 | 專用瀏覽器 JS API Key 的可選首次導入值 |
| `AMAP_JS_SECURITY_CODE` | 空 | 僅伺服器使用的 JS 安全密鑰可選首次導入值 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 一次性強密碼 | 創建初始管理員身份 |
| `COOKIE_SECURE` | `true` | 僅通過 HTTPS 發送認證 Cookie |
| `ALLOWED_ORIGIN` | 公開 HTTPS 來源 | CORS 白名單 |
| `TRUST_PROXY` | 代理後為 `true` | 是否信任轉發的客戶端 IP 請求頭 |
| `SYNC_HOST` | `127.0.0.1` | 同步管理監聽地址 |
| `SYNC_PORT` | `8791` | 同步管理端口 |
| `SYNC_CONTROL_PUBLIC` | `false` | 禁止主 API 公開同步管理入口 |
| `SYNC_SCHEDULER_ENABLED` | `true` | 允許同步服務自動補齊首次初始化並執行每日更新 |
| `SYNC_UTC_HOUR` | `3` | 每日調度檢查時間，UTC 小時 |

只有受控反向代理會覆蓋轉發 IP 請求頭時才啟用 `TRUST_PROXY`。端口 `8791` 始終保持私有。

地圖顯示開關保存在控制數據庫並通過 `/admin/` 管理。Google 與高德分別具有中國和國外開關，默認均為 Google 開啟、高德關閉。啟用高德國外地圖前需要申請[世界地圖](https://lbs.amap.com/api/javascript-api-v2/guide/map/world-map)權限；未開通時保持國外高德關閉。

AreaCity 數據需先下載並解壓 `ok_data_level4.csv` 到 `/root/address/data/imports/`，再在 `/admin/` 的「中國同步 → 導入 AreaCity」中填寫 `imports/ok_data_level4.csv` 和發佈版本。也可填寫 HTTPS JSON/CSV 地址；本地路徑僅允許位於數據目錄內。

## 首次部署

### 1. 準備 VPS

```bash
apt-get update
apt-get install -y git curl ca-certificates xz-utils python3 python3-venv nginx
mkdir -p /root/address
git clone https://github.com/daimon3332/address.git /root/address/app
cd /root/address/app
./ops/install-runtime.sh
```

`install-runtime.sh` 會把固定 Node.js、Python 虛擬環境、Python 依賴和 npm 依賴安裝到 `/root/address` 內。

### 2. 創建私密配置

```bash
mkdir -p /root/address/runtime
cp ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
editor /root/address/runtime/address.env
```

填寫 `ALLOWED_ORIGIN=https://YOUR_DOMAIN.example`，生成 `SYNC_ADMIN_TOKEN`，然後只添加需要的可選服務憑據。

### 3. 構建 WebUI

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
npm run build
```

### 4. 導入位置目錄

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
. ops/env.sh
npm run data:catalog
npm run data:catalog:import
```

`data:catalog` 下載開放的地區/城市/郵編參考數據（countries-states-cities-database 加 GeoNames，數百 MB），生成 `.data-cache/catalog-seed.sql`；`data:catalog:import` 將其寫入 `POSTGRES_URL` 指向的數據庫。此步驟必須在首次地址導入前完成：ETL 依賴目錄表做導入期反向地理編碼，目錄為空會顯著降低接受率。

### 5. 初始化全部國家

`SYNC_SCHEDULER_ENABLED=true`（模板默認值）時，直接啟動服務即可——同步服務會自動執行支持斷點續跑的首次導入，失敗按退避自動重試：

```bash
/root/address/app/ops/start.sh
```

如需先在前台執行首次導入（要求 supervisor 已停止），使用：

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

每個國家獨立驗證和發佈，重啟後可複用已完成緩存。耗時取決於 VPS CPU、磁盤、網絡和上游狀態（通常數小時到一天以上）。導入進行期間，API 會先提供已發佈國家的數據。

### 6. 驗證服務

```bash
/root/address/app/ops/status.sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/data-health
```

## Nginx 與 HTTPS

沿用現有證書流程，把公開域名代理到 API 進程：

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

防火牆只公開 HTTP/HTTPS，API 和同步管理均監聽迴環地址。TLS 生效後，`ALLOWED_ORIGIN` 使用完全一致的 HTTPS 來源。

## 同步與運維

- 首次任務覆蓋 26 個 ETL 國家（中國由 API 進程單獨同步），支持斷點續跑。
- 穩態調度要求 `SYNC_SCHEDULER_ENABLED=true`：每天 03:00 UTC 檢查，每天最多更新一個到期國家。
- 國家同步成功後，下一週期為 30 天。
- 新快照失敗時繼續保留舊 active 數據。
- 發佈成功後默認刪除原始源文件，除非明確開啟保留。

```bash
# 服務啟停與狀態
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# 創建 PostgreSQL 自定義格式備份
/root/address/app/ops/backup.sh

# 恢復 /root/address/backups 下的備份
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.dump
```

備份注意事項：

- `backup.sh` 使用 `pg_dump --format=custom`；恢復腳本使用 `pg_restore --clean --if-exists`。
- 任何備份都應排除 `data/staging`（`ADDRESS_SYNC_CACHE_DIR`）：其中只有可重新下載的源產物，導入期間可達數十 GiB。
- 單個備份包含地址表、控制表、憑據密文、同步狀態和審計數據。備份文件必須保持權限 `600`，並定期使用 `pg_restore --list` 驗證可讀性。
- PostgreSQL 伺服器使用 `max_connections=256`；應用池默認最大 64、最小 4，可通過 `POSTGRES_POOL_MAX` 和 `POSTGRES_POOL_MIN` 調整。

項目 supervisor（`ops/supervisor.mjs`，由 `ops/start.sh` 啟動）運行並守護兩個進程：API 服務（`server/api/server.ts`，端口 `8787`）和同步服務（`server/sync/index.mjs`，端口 `8791`）。它基於進程管理，不安裝 systemd 服務或 cron。需要 VPS 重啟後自動啟動時，把 `ops/start.sh` 接入主機已有的啟動機制。

## 部署後續提交

在開發機執行：

```bash
cp ops/deploy.env.example .deploy.env
chmod 600 .deploy.env
editor .deploy.env
bash ops/deploy.sh --dist
```

部署腳本會歸檔當前 `HEAD`，通過 SSH 上傳，保留 VPS 數據庫、私密運行配置和服務器黑名單，重啟 supervisor 並執行健康檢查。純文檔變更可使用 `--no-restart`。

## 生產檢查清單

- DNS 與 HTTPS 已生效。
- `ALLOWED_ORIGIN` 是完全一致的公開 HTTPS 來源。
- `TRUST_PROXY=true` 只用於受控代理後方。
- `SYNC_ADMIN_TOKEN` 隨機且私密，Git 歷史中沒有具體值。
- `SYNC_CONTROL_PUBLIC=false`，端口 `8791` 未公開。
- 可選服務 Key 已在服務商側設置限制和用量告警。
- 高德 JS Key 為專用且已限制域名；安全密鑰未出現在瀏覽器響應、日誌或 Git 中。
- 僅在確認世界地圖權限後啟用國外高德，並已測試四個地圖開關。
- 數據庫初始化後，`npm run check:production` 通過。
- 已生成當前備份並驗證恢復流程。
- 應用卷至少 60 GiB，並啟用剩餘空間監控。
