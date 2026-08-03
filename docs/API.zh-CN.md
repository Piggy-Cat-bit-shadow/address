# Address API 文档

[English](API.md) · [简体中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

外部 API 位于 `/api/v1`，其数据端点使用 `GET` 并返回 JSON。服务启动后，可在 `/en/api/` 或 `/zh-CN/api/` 查看交互参数说明。

## 基础地址

```text
https://YOUR_DOMAIN.example/api/v1
```

本地开发默认使用 `http://127.0.0.1:8787/api/v1`。

除 `/api/v1/health` 外，外部 API 请求需要管理员创建的 Bearer Token：

```http
Authorization: Bearer YOUR_API_TOKEN
```

Token 在 `/admin/` 创建，同时保存不可逆鉴权哈希和由服务端主密钥加密的密文，可设置权限、限速和到期时间，也可在管理员会话中查看、修改或撤销。WebUI 使用独立的 `/web-api/v1` 会话通道，不嵌入该 Token。鉴权失败返回 `401`；超过令牌每分钟限速返回 `429` 和 `Retry-After: 60`。

## 外部端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | API 基础健康检查 |
| `GET` | `/countries` | 国家注册表、同步数量和严格住宅覆盖 |
| `GET` | `/client-context` | 将请求 IP 或指定 IP 解析到支持地区 |
| `GET` | `/locations/search` | 搜索州省、城市和邮编选项 |
| `GET` | `/generate` | 生成通过证据门禁的真实住宅地址和相关测试资料 |
| `POST` | `/address-translation` | 将已生成地址翻译为支持的显示语言 |
| `GET` | `/data-health` | 检查地址池覆盖和就绪状态 |

## 健康检查

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/health
```

```json
{"status":"ok"}
```

## 国家注册表

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/countries
```

响应格式为 `{ "data": [...] }`。每个国家包含代码、本地化名称、支持的筛选条件、同步总量、真实住宅数量、住宅覆盖状态和 `generationMode`。公开生成只使用真实住宅池；同步总量仅用于迁移和健康报告。未连接数据库时，数量为 `null`。

## 客户端地区

解析当前请求：

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/client-context
```

解析指定 IPv4 或 IPv6：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/client-context?ip=8.8.8.8"
```

响应可能包含 `publicIp`、国家、州省、城市、邮编、纬度和经度。只有受控反向代理会覆盖转发 IP 请求头时，才配置 `TRUST_PROXY=true`。

## 地区搜索

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 项目支持的国家代码 |
| `field` | `city` | `region`、`city` 或 `postcode` |
| `q` | 空 | 搜索文本 |
| `region` | 空 | 上级州省文本 |
| `regionId` | 空 | 稳定州省 ID |
| `cityId` | 空 | 稳定城市 ID |
| `residential` | `false`（目录兼容） | 传入 `true` 时只列出具备真实住宅覆盖的选项；`/generate` 始终使用住宅记录 |
| `cursor` | 空 | 上一页返回的分页游标 |
| `limit` | `100` | 请求页大小 |

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/locations/search?country=CN&field=city&q=南京"
```

响应包含 `regions`、`cities`、`postcodes` 和 `matches`。连接地区目录数据库后，还会提供 `total`、`nextCursor` 和 `source`。

## 地址与资料生成

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 国家代码；IP 模式成功解析国家时忽略 |
| `mode` | `residential` | 使用 `ip-region` 开启 IP 坐标或城市匹配 |
| `ip` | 请求 IP | `mode=ip-region` 时使用的指定 IP |
| `residential` | `true` | 旧客户端兼容参数；`true`、`false` 均可传入，但公开生成始终执行住宅证据门禁 |
| `region`、`city`、`postcode` | 空 | 可读地区筛选 |
| `regionId`、`cityId`、`postcodeId` | 空 | 稳定目录 ID |
| `q` | 空 | 自由文本地区提示 |
| `strategy` | `random` | 用 `random` 或 `instant` 选择合格真实记录，不合成地址字段 |
| `seed` | 自动 UUID | 确定性生成种子 |
| `requestId` | 自动 UUID | 调用方关联 ID |

美国真实住宅地址：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US"
```

中国城市筛选：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN&city=南京"
```

IP 地区生成：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?mode=ip-region&ip=8.8.8.8"
```

响应外层为 `{ "data": { ... } }`。生成数据包含请求 ID、模式、国家、筛选、精确 `filterMatchLevel` 或 IP `ipMatchLevel`、尝试的数据源和耗时；普通生成还返回 `eligibleCount`，表示当前精确筛选范围内通过发布门禁的数据库记录数。地址三语变体与室内字段均来自来源，缺失值保持为空；人物资料、沙盒银行卡、工作、财务和网络字段仍为合成测试数据。地区筛选严格匹配，IP 模式只接受坐标或城市匹配。

普通请求从当前筛选范围的完整合格数据库候选集中选择，不使用固定候选窗口或固定顺序。需要稳定复现合格记录选择与测试资料时传入 `seed`；未传入时服务器为每次请求生成新 UUID。该参数不会生成缺失的地址组件，地址源同步后底层住宅池仍可能变化。

## 地址翻译

`POST /address-translation` 将已生成地址的语义组件（小区/楼栋、街道、城市、区县、行政区）返回为指定显示语言；数字标识（门牌号、单元、邮编）始终原样保留。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `addressId` | 必填 | `/generate` 返回的 `result.address.id` |
| `targetLocale` | 必填 | `en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es` 或 `pt` |

显示链路为：已存储变体 → 按需翻译 → 原文。仅当每个语义组件均已符合目标文字时才直接使用已存储变体；否则依次执行本地文字转换（中文目标使用 OpenCC，中文来源的英文目标以拼音兜底）和已配置的翻译服务商，并对每个候选做文字与数字保真校验。响应始终为单一语言的完整地址：任何环节都无有效结果时返回 `fallback` 或 `unavailable`，客户端应回退展示完整原文地址，绝不混排。

## WebUI 地图配置

地图显示属于 WebUI 配置，不改变 `/generate` 的地址证据。受会话保护的 `/web-api/v1` 通道只返回显示开关，以及启用高德时浏览器加载所需的专用 JS API Key；不会返回高德 JS 安全密钥或任何同步 Key。

Google 与高德分别提供中国和国外开关，默认均为 Google 开启、高德关闭。中国高德标记使用 GCJ-02 坐标；高德国外地图需要账号已开通世界地图权限。高德服务请求统一使用同源 `/_AMapService` 前缀，由服务器读取加密安全密钥并附加后再转发到固定高德上游。

## 数据健康

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/data-health
```

该端点返回配置国家、无效配置、热点池覆盖、低水位槽位和就绪状态，适合监控和部署检查。

## 错误格式

```json
{
  "error": {
    "code": "INVALID_COUNTRY",
    "message": "Unknown country code: ZZ"
  }
}
```

常见代码包括 `INVALID_COUNTRY`、`INVALID_FIELD`、`INVALID_LOCATION`、`INVALID_RESIDENTIAL`、`IP_LOCATION_UNAVAILABLE`、`NO_POOL_COVERAGE` 和 IP 参数校验错误。调用方应判断 `error.code`，不要依赖界面翻译文本。

## 同步管理 API

同步服务默认只监听 `127.0.0.1:8791`。任务端点要求 `Authorization: Bearer SYNC_ADMIN_TOKEN`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/healthz` | `8791` 端口的本地同步服务健康检查 |
| `POST` | `/api/v1/sync/jobs` | 创建 `initial` 或 `manual` 任务 |
| `GET` | `/api/v1/sync/jobs/latest` | 查询最近任务 |
| `GET` | `/api/v1/sync/jobs/{id}` | 查询指定任务 |

```bash
curl -fsS -X POST http://127.0.0.1:8791/api/v1/sync/jobs \
  -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"manual","shards":["CN"]}'
```

任务接受后返回 HTTP `202`、任务对象和 `Location` 请求头。已有任务运行时返回 `409`；JSON、模式或分片标识无效时返回 `400`。

主 API 默认隐藏 `/sync-control/*`。保持 `SYNC_CONTROL_PUBLIC=false`，通过本地端口或额外的私有访问边界进行管理。

## CORS 与隐私

- 生产环境将 `ALLOWED_ORIGIN` 设置为公开 HTTPS 来源。
- API Key 和 `SYNC_ADMIN_TOKEN` 不进入查询参数、浏览器代码、截图或日志。
- 浏览器渲染应使用专用且受域名限制的高德 JS API Key。JS Key 按平台机制会出现在浏览器请求中；配套安全密钥和所有 WebService 同步 Key 始终留在服务器。
