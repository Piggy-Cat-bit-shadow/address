# Address 部署文档

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

项目只维护一种生产部署方式：Docker Compose。应用、PostgreSQL、迁移和自动同步均由仓库根目录的 `docker-compose.yml` 管理。

## Docker Compose 快速部署

```bash
mkdir address && cd address
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/daimon3332/address/main/docker-compose.yml
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/ready
```

Compose 的 bootstrap 服务会自动创建相对目录和持久化内部密钥。管理员初始密码为 `admin`，前端密码默认关闭。首次启动前可直接在 `docker-compose.yml` 修改 `ADMIN_INITIAL_PASSWORD` 或 `FRONTEND_INITIAL_PASSWORD`；使用默认管理员密码登录后，必须先修改密码。

```bash
cat data/secrets/admin_bootstrap_password
```

登录 `/admin/` 后可修改前端密码、管理员密码、API 调用令牌、地图平台 Key、额度与其他业务设置。

## 运行要求

- Linux AMD64 或 ARM64
- Docker Engine 与 Docker Compose v2
- 4 GB 内存；执行大型国家首次同步建议 8 GB 或更多
- 足够容纳 PostgreSQL、地址数据、同步暂存和备份的磁盘空间
- HTTPS 反向代理

开发电脑无需安装 Docker。正式镜像由 GitHub Actions 构建并发布到 Docker Hub：`daimon23/address`。

## 目录结构

```text
address/
├── docker-compose.yml    # 唯一必需的部署文件
├── config/secrets/       # 可选的旧版密钥导入位置
├── data/secrets/         # 自动生成的持久化密钥
├── data/address/         # 地址池与同步暂存
├── data/postgres/        # PostgreSQL 数据
├── runtime/              # 同步运行状态
├── backups/              # pg_dump 备份
└── logs/
```

所有挂载均为 Compose 文件所在目录的相对路径，不依赖 `/root/address` 或其他固定安装位置。不要让两个 PostgreSQL 容器同时挂载同一个 `data/postgres`。

## 可选部署配置

默认配置可以直接启动。可直接编辑 Compose 中的 `environment`；只有需要统一覆盖镜像、端口或反向代理设置时才创建 `.env`：

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

HTTPS 反向代理生产环境应将 `ALLOWED_ORIGINS` 设置为一个或多个以逗号分隔的 HTTPS 来源，并将 `TRUST_PROXY`、`COOKIE_SECURE` 改为 `true`。第三方 API Key 和常规业务参数统一在管理员后台管理。

## 服务与网络

- `postgres`：PostgreSQL 16，只连接内部网络
- `bootstrap`：创建或校验持久化内部密钥，完成后退出
- `migrate`：每次启动前执行一次数据库迁移，成功后退出
- `api`：WebUI 与 API，默认只监听 `127.0.0.1:8787`
- `sync`：自动同步服务，只连接 Compose 私有网络
- `credential-broker`：凭据加密轮换与额度协调服务，只连接 Compose 私有网络

自动同步默认启用，队列发现、超时、有限重试、冷却、来源耗尽与临时文件清理由服务自动处理。

## 常用命令

```bash
docker compose ps
docker compose logs -f api sync
docker compose restart api sync
docker compose down
docker compose up -d
```

升级镜像：

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose pull
docker compose up -d
docker compose ps
```

## 备份与恢复

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose stop api sync credential-broker
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < ./backups/address-YYYYMMDDTHHMMSSZ.dump
docker compose up -d
```

备份包含地址表、控制表、加密后的凭据、同步状态和审计数据。`data/secrets/config_master_key` 必须与数据库备份一起安全保存，否则无法解密后台保存的凭据。跨 PostgreSQL 主版本必须使用 `pg_dump` 与 `pg_restore`，不能直接复用数据目录。

## Nginx 示例

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

只公开 HTTP/HTTPS，禁止公开 PostgreSQL 和同步服务端口。

## Docker Hub 发布

`.github/workflows/docker-publish.yml` 在 `main` 更新、版本标签或手动触发时构建 AMD64/ARM64 镜像。GitHub 仓库只需配置 `DOCKERHUB_TOKEN`，内容为具有读写权限的 Docker Hub Access Token；公开用户名 `daimon23` 已固定在工作流中。

Token 只保存在 GitHub Actions Secrets，禁止写入仓库、Compose、截图或日志。
