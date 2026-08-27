# Address 部署文件

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

專案只維護一種生產部署方式：Docker Compose。根目錄的 `docker-compose.yml` 統一管理應用、PostgreSQL、遷移與自動同步。

## Docker Compose 快速部署

```bash
mkdir address && cd address
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/daimon3332/address/main/docker-compose.yml
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/ready
```

Compose 的 bootstrap 服務會自動建立相對目錄與持久化內部密鑰。管理員初始密碼為 `admin`，前端密碼預設關閉。首次啟動前可直接在 `docker-compose.yml` 修改 `ADMIN_INITIAL_PASSWORD` 或 `FRONTEND_INITIAL_PASSWORD`；使用預設管理員密碼登入後，必須先修改密碼。

```bash
cat data/secrets/admin_bootstrap_password
```

登入 `/admin/` 後可修改前端密碼、管理員密碼、API 呼叫權杖、地圖平台 Key、額度與其他業務設定。

## 執行要求

- Linux AMD64 或 ARM64
- Docker Engine 與 Docker Compose v2
- 4 GB 記憶體；執行大型國家首次同步建議 8 GB 或更多
- 足以容納 PostgreSQL、地址資料、同步暫存與備份的磁碟空間
- HTTPS 反向代理

開發電腦不需要安裝 Docker。正式映像由 GitHub Actions 建置並發佈到 Docker Hub：`daimon23/address`。

## 目錄結構

```text
address/
├── docker-compose.yml    # 唯一必要的部署文件
├── config/secrets/       # 可選的舊版密鑰匯入位置
├── data/secrets/         # 自動產生的持久化密鑰
├── data/address/         # 地址池與同步暫存
├── data/postgres/        # PostgreSQL 資料
├── runtime/              # 同步執行狀態
├── backups/              # pg_dump 備份
└── logs/
```

所有掛載均為 Compose 檔案所在目錄的相對路徑，不依賴 `/root/address` 或其他固定安裝位置。不要讓兩個 PostgreSQL 容器同時掛載同一個 `data/postgres`。

## 選用部署設定

預設設定可直接啟動。可直接編輯 Compose 中的 `environment`；只有需要統一覆寫映像、連接埠或反向代理設定時才建立 `.env`：

```bash
cp ops/compose.env.example .env
```

```dotenv
ADDRESS_IMAGE=daimon23/address:latest
API_BIND_ADDRESS=127.0.0.1
API_PORT=8787
ALLOWED_ORIGINS=*
TRUST_PROXY=false
COOKIE_SECURE=false
```

HTTPS 反向代理生產環境應將 `ALLOWED_ORIGINS` 設定為一個或多個以逗號分隔的 HTTPS 來源，並將 `TRUST_PROXY`、`COOKIE_SECURE` 改為 `true`。第三方 API Key 與一般業務參數統一在管理員後台管理。

## 服務與網路

- `postgres`：PostgreSQL 16，只連接內部網路
- `bootstrap`：建立或校驗持久化內部密鑰，完成後退出
- `migrate`：每次啟動前執行一次資料庫遷移，成功後退出
- `api`：WebUI 與 API，預設只監聽 `127.0.0.1:8787`
- `sync`：自動同步服務，只連接 Compose 私有網路
- `credential-broker`：憑據加密輪換與額度協調服務，只連接 Compose 私有網路

自動同步預設啟用，佇列發現、逾時、有限重試、冷卻、來源耗盡與暫存檔清理由服務自動處理。

## 常用命令

```bash
docker compose ps
docker compose logs -f api sync
docker compose restart api sync
docker compose down
docker compose up -d
```

升級映像：

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose pull
docker compose up -d
docker compose ps
```

## 備份與還原

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose stop api sync credential-broker
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < ./backups/address-YYYYMMDDTHHMMSSZ.dump
docker compose up -d
```

備份包含地址表、控制表、加密後的憑據、同步狀態與稽核資料。`data/secrets/config_master_key` 必須與資料庫備份一起安全保存，否則無法解密後台保存的憑據。跨 PostgreSQL 主版本必須使用 `pg_dump` 與 `pg_restore`，不能直接重用資料目錄。

## Nginx 範例

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

只公開 HTTP/HTTPS，禁止公開 PostgreSQL 與同步服務連接埠。

## Docker Hub 發佈

`.github/workflows/docker-publish.yml` 在 `main` 更新、版本標籤或手動觸發時建置 AMD64/ARM64 映像。GitHub 儲存庫只需設定 `DOCKERHUB_TOKEN`，內容為具有讀寫權限的 Docker Hub Access Token；公開使用者名稱 `daimon23` 已固定在工作流程中。

Token 只保存在 GitHub Actions Secrets，禁止寫入儲存庫、Compose、截圖或日誌。
