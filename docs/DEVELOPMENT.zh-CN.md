# Address 二次开发文档

[English](DEVELOPMENT.md) · [简体中文](DEVELOPMENT.zh-CN.md) · [繁體中文](DEVELOPMENT.zh-TW.md)

## 架构

```text
浏览器
  -> Astro 静态页面 + React WebUI
  -> Hono Node.js API
       -> PostgreSQL transactional 地址池
       -> PostgreSQL coordinate 坐标索引
       -> 本地格式化与本地化
       -> 仅已同步住宅地址池
  -> 同步 supervisor
       -> DuckDB 读取 Overture GeoParquet
       -> pyosmium 读取 Geofabrik/OSM PBF
       -> 验证并原子发布国家快照
```

公开生成和 IP 区域生成只查询 active PostgreSQL 中通过证据门禁的真实住宅记录。第三方平台仅由后台同步调用，公开生成请求不会访问这些平台。

地图渲染与地址真实性验证相互隔离。Google 使用坐标预览；高德使用专用 JS API Key 和同源 `/_AMapService` 代理。高德 JS 安全密钥只以密文保存在控制数据库，不进入浏览器构建产物或地图配置响应。

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/components/` | React WebUI 与同步管理界面 |
| `src/domain/` | 国家元数据、生成、格式化、本地化、资料与导出规则 |
| `src/pages/` | 本地化 WebUI 与 API 文档的 Astro 路由 |
| `server/api/` | Hono 应用、数据仓库与外部服务适配器 |
| `server/database/` | PostgreSQL Schema 与迁移入口 |
| `server/sync/` | 数据源适配、ETL、调度、快照发布与同步管理 API |
| `scripts/` | 目录生成、验证、线上探测与发布审计 |
| `ops/` | Linux VPS 安装、进程、备份、恢复与部署脚本 |
| `tests/` | Vitest 单元、集成、数据质量与 UI 结构测试 |

## 本地环境

要求 Node.js 24 或更新版本。只有源数据同步需要 Python 3.10+（3.12 已验证）和 `venv`；先执行 `pip install -r server/sync/requirements.txt`，并用 `PYTHON_BIN` 指向该解释器。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

`npm run dev` 先构建一次 WebUI，再由 `127.0.0.1:8787` 的 Hono API 提供服务。需要实时编辑 UI 时，同时运行 `npm run dev:api` 和 `npm run dev:web`：`127.0.0.1:4321` 的 Astro 开发服务器把 `/api` 代理到 Hono，把 `/sync-control` 代理到 `127.0.0.1:8791` 的本地同步服务。

新迁移的数据库只有表结构，不包含地址池。本地开发和测试套件基于空 Schema 加 `scripts/fixtures/`、`tests/fixtures/` 中的小型夹具运行；生产 PostgreSQL 数据 不会离开服务器（`data/` 被 Git 忽略，部署脚本会保留服务器数据库）。需要本地真实数据时，先导入目录（`npm run data:catalog` 加 `npm run data:catalog:import`），再导入一个小国家，例如 `npm run data:address-pool:etl -- --manual --shard SG`。

常用命令：

| 命令 | 用途 |
|---|---|
| `npm run dev` | 构建一次 WebUI，再以监听模式运行 Hono API |
| `npm run dev:web` | 只运行 Astro（端口 4321，代理 `/api`） |
| `npm run dev:api` | 只运行 Hono |
| `npm test` | 运行 Vitest 测试套件 |
| `npm run db:migrate` | 创建或迁移本地 PostgreSQL Schema |
| `npm run data:regions` | 更新内置地区元数据 |
| `npm run data:catalog` | 下载并生成位置目录种子 |
| `npm run data:catalog:import` | 把目录种子导入本地数据库（任何地址导入前必需） |
| `npm run data:address-pool:estimate` | 估算同步计划 |
| `npm run data:address-pool:sync:dry-run` | 只验证 ETL 计划，不发布数据 |
| `npm run data:address-pool:bootstrap` | 执行支持断点续跑的全部国家首次导入 |
| `npm run sync:serve` | 运行本地调度器与同步管理 API |

## 配置模型

把 `.env.example` 复制为被忽略的 `.env`。密钥始终留在服务端。只有明确用于 Astro 公开环境的变量才应进入浏览器构建；第三方服务 Key 和 `SYNC_ADMIN_TOKEN` 必须保留在 API 或同步进程环境中。`AMAP_API_KEY` 是服务端 WebService 凭据；`AMAP_JS_API_KEY` 是独立且受域名限制的浏览器加载 Key；`AMAP_JS_SECURITY_CODE` 仅由 `/_AMapService` 在服务端使用。

常规开发不需要第三方 API Key。可选同步平台参见[部署文档](DEPLOYMENT.zh-CN.md)。

## 数据库与同步

PostgreSQL 使用事务和连接池，保存地址、三语本地化、来源证据、国家状态和 坐标索引。国家发布是事务性的：候选快照通过验证后才替换 active 数据，失败的候选不会影响旧快照。

同步来源：

- Overture Maps：DuckDB 远程筛选并读取 GeoParquet。
- Geofabrik 提供的 OpenStreetMap：pyosmium 流式读取预筛选后的 PBF node 和 way。
- 本地地区与位置目录：约束选择器并验证行政区一致性。

管线会过滤机构和非地址要素、去重、检查住宅证据、验证本地化组件并执行容量门禁。API 或同步任务运行时不要手工修改 the production database。

手工执行示例：

```bash
node server/sync/address-etl.mjs --initial --all
node server/sync/address-etl.mjs --daily --all
node server/sync/address-etl.mjs --manual --shard US
```

## 扩展公开 API

1. 在 `server/api/index.ts` 定义请求校验与路由。
2. 数据库访问统一放在 `server/api/repositories/`。
3. 服务商或网络逻辑放在 `server/api/services/`，并显式设置超时。
4. 沿用 `{ data: ... }` 或 `{ error: { code, message } }` 响应结构。
5. 添加 API 测试，并同步更新三语 API 文档。

公开错误使用稳定、机器可读的错误码，不要让调用方依赖本地化 UI 文案。

## 扩展国家或地址规则

国家行为涉及元数据、格式、位置选项、本地化、邮编规则、源分片计划和测试。添加国家前需要：

1. 在 `src/domain/` 定义元数据和支持的筛选项。
2. 添加地址格式与邮编规则。
3. 添加源分片并验证许可和署名元数据。
4. 为同一地址或精确建筑关系分别验证地址存在证据与独立住宅用途证据。
5. 添加本地化、确定性选择、严格筛选、IP 坐标或城市匹配和邮编格式测试。
6. 只使用既有脚本重新生成目录。

地址与室内字段必须全部来自来源，缺失值保持为空；合成测试资料与地址来源信息保持明确分离。

## WebUI 开发

本地化页面从 `src/pages/[locale].astro` 进入并挂载 `src/components/App.tsx`。共享样式位于 `src/styles/global.css`；同步界面使用 `SyncAdmin.tsx` 和 `admin.css`。

修改结果字段时，先更新领域类型，再把生成、API 序列化、UI、导出、翻译与测试作为同一契约一起更新。保持结果区尺寸稳定，并验证英文和中文值。

地图显示包含四个独立布尔开关：中国 Google、中国高德、国外 Google、国外高德，默认 Google 开启、高德关闭。中国高德把 WGS-84 转为 GCJ-02；国外高德使用来源坐标和 `showOversea`，因此需要世界地图权限。两个平台组件必须独立失败，单个平台异常不能导致整个结果页白屏。

## 验证与发布门禁

每次提交前运行：

```bash
npm test
npm run check
npm run build
npm run check:public
```

这些命令覆盖 Vitest、Astro 诊断、TypeScript、生产构建、忽略文件策略、必需公开文件和常见密钥形态。Linux CI 还会检查 Shell 语法并编译 Python 文件。

完整数据库同步后运行：

```bash
npm run check:production
```

该命令检查数据库完整性、必需表、国家就绪状态和容量上限。线上环境探测使用独立命令，因为它们要求已有运行中的部署。

## 贡献检查清单

- 保持改动范围清晰，不引入无关依赖或格式化变更。
- 按行为影响补充相应测试。
- 地图改动需覆盖四个地区/平台开关、后台设置持久化、凭据掩码、代理目标白名单，以及浏览器响应和日志中不存在高德安全密钥。
- 英文、简体中文和繁体中文文档同步更新。
- 真实凭据、数据库、日志、含私密数据的截图和运行状态不进入 Git。
- 除项目命令外执行 `git diff --check`。
- 修改数据管线时保留来源署名和许可。
