# Address API 文档

[English](API.md) · [简体中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

外部 API 位于 `/api/v1` 并返回 JSON。服务启动后，可在 `/en/api/` 或 `/zh-CN/api/` 查看交互参数说明。

## 基础地址

```text
https://YOUR_DOMAIN.example/api/v1
```

本地开发默认使用 `http://127.0.0.1:8787/api/v1`。

除 `/api/v1/health`、`/api/v1/ready` 和 `/api/v1/openapi.json` 外，外部 API 请求需要管理员创建的 Bearer Token：

```http
Authorization: Bearer YOUR_API_TOKEN
```

Token 在 `/admin/` 创建，可设置权限、限速和到期时间。鉴权失败返回 `401`；超过令牌每分钟限速返回 `429` 和 `Retry-After: 60`。

## 快速开始

### curl

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

### Python

```python
import json
from urllib.request import Request, urlopen

request = Request(
    "https://YOUR_DOMAIN.example/api/v1/generate?country=CN",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
)
with urlopen(request) as response:
    print(json.load(response))
```

### JavaScript

```javascript
const response = await fetch(
  "https://YOUR_DOMAIN.example/api/v1/generate?country=CN",
  { headers: { Authorization: "Bearer YOUR_API_TOKEN" } },
);
const payload = await response.json();
console.log(payload);
```

## 外部端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | API 基础健康检查 |
| `GET` | `/ready` | PostgreSQL 就绪检查 |
| `GET` | `/openapi.json` | OpenAPI 3.1 契约 |
| `GET` | `/countries` | 国家注册表、同步数量和严格住宅覆盖 |
| `GET` | `/availability` | 所有已配置国家的公开生成可用性 |
| `GET` | `/client-context` | 将请求 IP 或指定 IP 解析到支持地区 |
| `GET` | `/locations/search` | 搜索州省、城市和邮编选项 |
| `GET` | `/locations/hierarchy` | 按上下级关系浏览行政区和邮编选项 |
| `GET` | `/generate` | 生成通过证据门禁的真实住宅地址和相关测试资料 |
| `POST` | `/generate/batch` | 使用结构化筛选和唯一性控制批量生成最多 50 个地址 |
| `GET` | `/addresses/{id}` | 按生成结果 ID 查询当前发布地址 |
| `GET` | `/coverage` | 查询国家同步的三项完成规则 |
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
curl -fsS https://YOUR_DOMAIN.example/api/v1/countries \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

响应格式为 `{ "data": [...] }`。每个国家包含代码、本地化名称、支持的筛选条件、同步总量、真实住宅数量、住宅覆盖状态和 `generationMode`。公开生成只使用真实住宅池；同步总量仅用于迁移和健康报告。未连接数据库时，数量为 `null`。

## 生成可用性

```bash
curl -fsS -H "Authorization: Bearer YOUR_API_TOKEN" \
  https://YOUR_DOMAIN.example/api/v1/availability
```

响应说明每个已配置国家当前是否存在通过发布门禁、可用于生成的住宅记录。

## 客户端地区

解析当前请求：

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/client-context \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

解析指定 IPv4 或 IPv6：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/client-context?ip=8.8.8.8" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

响应可能包含 `publicIp`、国家、州省、城市、邮编、纬度和经度。只有受控反向代理会覆盖转发 IP 请求头时，才配置 `TRUST_PROXY=true`。

## 地区搜索

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 项目支持的国家代码 |
| `field` | `city` | `region`、`city`、`district` 或 `postcode` |
| `q` | 空 | 搜索文本 |
| `region` | 空 | 上级州省文本 |
| `regionId` | 空 | 稳定州省 ID |
| `cityId` | 空 | 稳定城市 ID |
| `residential` | `false`（目录兼容） | 传入 `true` 时只列出具备真实住宅覆盖的选项；`/generate` 始终使用住宅记录 |
| `cursor` | 空 | 上一页返回的分页游标 |
| `limit` | `100` | 请求页大小，范围为 `20` 至 `200` |

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/locations/search?country=CN&field=city&q=南京" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

响应包含 `regions`、`cities`、`postcodes` 和 `matches`。连接地区目录数据库后，还会提供 `total`、`nextCursor` 和 `source`。

## 地址与资料生成

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 国家代码；IP 模式成功解析国家时忽略 |
| `mode` | `residential` | 使用 `ip-region` 开启 IP 坐标或城市匹配 |
| `ip` | 请求 IP | `mode=ip-region` 时使用的指定 IP |
| `residential` | `true` | 旧客户端兼容参数；`true`、`false` 均可传入，但公开生成始终执行住宅证据门禁 |
| `region`、`city`、`district`、`postcode` | 空 | 可读地区筛选 |
| `regionId`、`cityId`、`districtId`、`postcodeId` | 空 | 稳定目录 ID |
| `q` | 空 | 自由文本地区提示 |
| `strategy` | `random` | 用 `random` 或 `instant` 选择合格真实记录，不合成地址字段 |
| `seed` | 自动 UUID | 确定性生成种子 |
| `requestId` | 自动 UUID | 调用方关联 ID |

美国真实住宅地址：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

中国城市筛选：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN&city=南京" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

IP 地区生成：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?mode=ip-region&ip=8.8.8.8" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

响应外层为 `{ "data": { ... } }`。生成数据包含请求 ID、模式、国家、筛选、精确 `filterMatchLevel` 或 IP `ipMatchLevel`、尝试的数据源和耗时；普通生成还返回 `eligibleCount`，表示当前精确筛选范围内通过发布门禁的数据库记录数。地址三语变体与室内字段均来自来源，缺失值保持为空；人物资料、沙盒银行卡、工作、财务和网络字段仍为合成测试数据。地区筛选严格匹配，IP 模式只接受坐标或城市匹配。

未筛选的国家请求将种子映射到 PostgreSQL 连续生成序号，使每条合格记录具有相同的选择概率；筛选请求使用覆盖完整匹配范围的有界循环索引窗口。两条路径均不使用固定子集或固定顺序。需要稳定复现合格记录选择与测试资料时传入 `seed`；未传入时服务器为每次请求生成新 UUID。该参数不会生成缺失的地址组件，地址源同步后底层住宅池仍可能变化。

## 批量生成与结构化查询

`POST /generate/batch` 接受 1 至 50 的 `count`、必填的 `filters` 对象、可选的 `options`（`unique`、`seed`、`strategy`、`requestId`），以及最多 500 个 `excludeAddressIds`。唯一合格地址不足时返回已有结果，并以 `exhausted: true` 标明。

`GET /locations/hierarchy` 使用 `country`、`parentType`、`parentId` 和 `childType` 浏览目录上下级。`GET /addresses/{id}` 重新查询当前仍在发布的同步地址。`GET /coverage` 分别返回国家总量、完整行政区覆盖率和各级节点最低数量三项规则。

## 地址翻译

`POST /address-translation` 将已生成地址的语义组件（小区/楼栋、街道、城市、区县、行政区）返回为指定显示语言；数字标识（门牌号、单元、邮编）始终原样保留。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `addressId` | 必填 | `/generate` 返回的 `result.address.id` |
| `targetLocale` | 必填 | `en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es` 或 `pt` |

响应统一使用一种语言并保留数字标识。没有可用的有效翻译时，接口返回 `fallback` 或 `unavailable`，客户端可回退展示完整原文地址。

## 数据健康

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/data-health \
  -H "Authorization: Bearer YOUR_API_TOKEN"
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

## CORS 与隐私

- 生产环境将 `ALLOWED_ORIGIN` 设置为公开 HTTPS 来源。
- API Key 和 `SYNC_ADMIN_TOKEN` 不进入查询参数、浏览器代码、截图或日志。
