# 地址数据同步

同步服务使用同一 PostgreSQL 数据库和国家级事务。

## 运行前提

- Node.js 24+，Python 3.10+（3.12 已验证）。先执行 `pip install -r server/sync/requirements.txt`（建议 venv），并通过 `PYTHON_BIN` 指向该解释器（默认 `python3`，Windows 为 `python`）。
- 首次同步前必须先导入位置目录：`npm run data:catalog` 下载参考数据并生成 `.data-cache/catalog-seed.sql`，`npm run data:catalog:import` 写入 `POSTGRES_URL` 指向的数据库。导入期反向地理编码依赖 `catalog_regions` / `catalog_cities`，目录为空会显著降低接受率。
- Overture 导出首次运行时 DuckDB 会联网安装 `httpfs` 与 `spatial` 扩展。

## 凭据需求

- 无需任何凭据：US、CA、MX、GB、DE、FR、IT、ES、NL、RU、JP、HK、TW、TH、PH、VN、MY、SA、IN、AU、TR、BR、NG、ZA（Overture、Geofabrik、官方开放数据）。
- SG：无凭据即可完成；`ONEMAP_ACCESS_TOKEN` 可选，用于扩大 HDB 建筑匹配（Token 3 天过期）。
- KR：`GEOAPIFY_API_KEY` 必需。K-apt 导出通过 Geoapify 反查邮编，缺少有效邮编的记录会被丢弃，无 Key 时该国首次初始化无法达标（每日上限 2,800 次，目标量分多日补齐）。
- CN：不经过本 ETL，由主 API 进程的中国小区同步使用高德（可选百度、腾讯交叉验证）Key，在 `/admin/` 配置。

## 运行模式

- `node server/sync/address-etl.mjs --initial --all`：断点完成 26 个 ETL 国家的首次初始化（CN 单独走中国小区同步）。
- `node server/sync/address-etl.mjs --daily --all`：选择失败优先或最早到期的一个国家。
- `node server/sync/address-etl.mjs --manual --shard US`：手动同步指定国家。
- `node server/sync/index.mjs`：启动同步管理 API；当 `SYNC_SCHEDULER_ENABLED=true` 时自动补跑未完成的初始化并按 `SYNC_UTC_HOUR` 每日调度。

成功国家的 `next_sync_at` 为完成时间加 30 天。失败不会替换现有 active dataset。同步目录达到 40GB 后停止 shadow 扩容，预计达到 45GB 时中止写入。`run-address-sync` 在可用内存低于 `ADDRESS_SYNC_MIN_FREE_MEMORY_BYTES`（默认 2 GiB）时拒绝启动；日本构建实测峰值约 6.5 GB RSS。

## 数据处理

Overture 通过 DuckDB 远程读取 GeoParquet 并按国家、城市限量。Geofabrik PBF 通过 pyosmium `FileProcessor` 在 C++ 层预过滤并流式读取 node/way；初始化时可复用一天内已完整下载的旧版本，避免跨日重复下载，成功发布后删除原始文件。两类来源都经过机构过滤、去重、住宅证据校验和三语组件校验，再在单个国家事务中发布。Geofabrik 国家额外维护最多 1,000 条明确住宅 building reservoir，并以每城市约 10 条的分层样本扩大地区覆盖。

管理接口要求 `Authorization: Bearer <SYNC_ADMIN_TOKEN>`：

```text
POST /api/v1/sync/jobs
GET  /api/v1/sync/jobs/latest
GET  /api/v1/sync/jobs/{jobId}
```

独立同步服务仅监听 `127.0.0.1:8791`。主 API 默认不公开 `/sync-control/*`；只有显式设置 `SYNC_CONTROL_PUBLIC=true` 才会代理该路径，且必须配置 `SYNC_ADMIN_TOKEN`。
