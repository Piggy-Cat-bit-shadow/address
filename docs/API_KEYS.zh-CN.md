# API Key 配置

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

已有 PostgreSQL 地址池可以在没有第三方密钥时正常生成地址。只有对应的同步、翻译、地理编码或地图预览功能才需要平台凭据。

## 保存位置与优先关系

- 高德、百度、腾讯、Mappls、OneMap、Geoapify、Google Geocoding、有道及高德浏览器地图凭据统一在管理员后台配置；所有值使用 `CONFIG_MASTER_KEY` 加密后存入 PostgreSQL。
- 管理员后台保存的凭据直接加入同步服务使用的额度、冷却与轮换池。
- 普通部署保持 `config/address.env` 为空。它只保留给同步进程启动前必须存在的授权 feed URL、字段映射和许可门禁；除非未来适配器明确要求，否则不要在其中保存平台 Key。

## 平台凭据

### 高德 WebService

1. 注册并进入[高德控制台](https://console.amap.com/dev/index)。
2. 按[官方创建 Key 文档](https://lbs.amap.com/api/webservice/create-project-and-key)创建应用和 **WebService** Key。
3. 按控制台能力限制来源，只开启项目需要的服务。
4. 配置 `AMAP_API_KEY`；额外密钥使用 `AMAP_API_KEY_2` 等编号，或在“后台 → 服务凭据”逐个添加。

服务端同步 Key 不得与浏览器地图 Key 共用。

高德[基础服务价格与配额页](https://lbs.amap.com/pages/base_service_price)列出的个人认证基础搜索默认值为每月 `5,000` 次、`3 QPS`。官方[错误码表](https://lbs.amap.com/api/webservice/guide/tools/info/)中，`10003` 为日访问量超限并于次日 `00:00` 解封，`10004` 为单位时间访问超限并于下一分钟解封；`40000` 属于余额或套餐额度耗尽。系统分别记录分钟冷却、日窗口和月窗口，不会用一分钟冷却覆盖日/月额度状态。

### 高德 JavaScript 地图

1. 单独创建 **JavaScript API** Key 和安全密钥。
2. 将浏览器 Key 限制到正式域名。
3. 配置 `AMAP_JS_API_KEY` 与 `AMAP_JS_SECURITY_CODE`，或在后台的高德浏览器地图设置中保存。

浏览器 Key 按平台机制会出现在浏览器请求中；安全密钥只保留在服务端，通过同源代理使用。高德[安全密钥官方文档](https://lbs.amap.com/api/maps-javascript-api/guide/abc/jscode)推荐代理转发方式。

### 百度地图

1. 注册并进入[百度地图 API 控制台](https://lbsyun.baidu.com/apiconsole/key)。
2. 创建“服务端”应用，开启项目使用的 Place/Web API。
3. 配置适合服务器的 IP 白名单或签名校验。
4. 设置 `BAIDU_API_KEY`、`BAIDU_API_KEY_2` 等，或在后台逐个添加 AK。

请参考[百度 Web API 官方文档](https://lbsyun.baidu.com/faq/api?title=webapi%2Fguide%2Fwebservice-placeapi)。额度、无效 AK、服务未开启及 IP/签名错误只影响对应凭据。

百度[开发者权益说明](https://lbsyun.baidu.com/solutions/privilege)列出的个人地点检索默认值为每日 `100` 次、`3 QPS`。套餐或控制台显示不同值时，以当前账户控制台为准。

### 腾讯位置服务

1. 进入[腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)创建应用和 Key。
2. 只在需要时开启 **WebService API**。
3. 配置 IP 或签名限制。
4. 设置 `TENCENT_API_KEY`、编号变量，或在后台逐个添加。

腾讯[官方状态码表](https://lbs.qq.com/service/webService/webServiceGuide/status)说明：`120` 为每秒请求量上限，`121` 为每日调用量上限。响应头 `X-LIMIT` 可提供实时用量，最终以控制台为准。

腾讯[WebService 配额说明](https://lbs.qq.com/webservice_v1/guide-quota.html)列出的初始默认值为每日 `10,000` 次、`5 QPS`。若 `X-LIMIT` 或控制台返回更小或更大的实际值，系统保存该日窗口的实际值并优先采用。

### Mappls Search API

1. 在 [Mappls 控制台](https://auth.mappls.com/console/)创建应用，并为该应用开通 Nearby Places 与 Place Details。
2. 从应用的 credentials 区域复制静态 Key；现行 Nearby API 文档要求通过 `access_token` 查询参数传入。
3. 控制台支持时，将 Key 限制到生产服务器 IP。
4. 设置 `MAPPLS_API_KEY`、`MAPPLS_API_KEY_2` 等编号变量，或在管理后台逐个添加。

印度住宅适配器默认关闭。只有合同明确允许住宅分类代码、受限地址字段、坐标、缓存和再分发后才能启用。系统内置的每日 1,000 次只是本地保护值，不是官方套餐额度；实际额度必须按合同和控制台设置。参见 [Nearby API 现行文档](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-near-by-api-example/Readme)。

### 越南邮政 Vpostcode feed

1. 取得允许住宅字段、坐标、服务端缓存和再分发的 Vpostcode 批量 feed 或 API 合同。
2. 将 `ADDRESS_SYNC_VPOSTCODE_FEED_URL` 设置为 HTTPS feed，或设置为 `ADDRESS_DATA_ROOT` 下的本地文件；填写不可变的 `ADDRESS_SYNC_VPOSTCODE_FEED_VERSION` 和格式（`csv`、`json` 或 `jsonl`）。
3. 将 `ADDRESS_SYNC_VPOSTCODE_FIELD_MAP` 设置为 JSON，映射 `id`、`number`、`street`、`locality`、`admin1`、`postcode`、`longitude` 和 `latitude`。如果合同没有明确整库都是住宅，还要映射 `residentialClass` 并设置 `ADDRESS_SYNC_VPOSTCODE_RESIDENTIAL_VALUES`。
4. 检查合同和字段样本后，才设置 `ADDRESS_SYNC_VPOSTCODE_ENABLED=true`、`ADDRESS_SYNC_VPOSTCODE_LICENSE_CONFIRMED=true` 和 `ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED=true`。

适配器只接受五位邮编；在真实授权样本通过住宅质量门禁前保持关闭。合成 feed 吞吐测试不能证明 Vpostcode 的真实容量。

### 尼日利亚 NIPOST 或 ProgIS feed

1. 取得允许住宅字段、坐标、服务端缓存和再分发的 NIPOST 或 ProgIS 批量 feed 合同。
2. 将 `ADDRESS_SYNC_NG_FEED_URL` 设置为 HTTPS feed，或设置为 `ADDRESS_DATA_ROOT` 下的本地文件；填写 `ADDRESS_SYNC_NG_FEED_VERSION` 和格式（`csv`、`json` 或 `jsonl`）。
3. 将 `ADDRESS_SYNC_NG_FIELD_MAP` 设置为 JSON，映射 `id`、`number`、`street`、`district`、`locality`、`admin1`、`postcode`、`longitude` 和 `latitude`。如果合同没有明确整库都是住宅，还要映射 `residentialClass` 并设置 `ADDRESS_SYNC_NG_RESIDENTIAL_VALUES`。
4. 检查合同和字段样本后，才设置 `ADDRESS_SYNC_NG_FEED_ENABLED=true`、`ADDRESS_SYNC_NG_LICENSE_CONFIRMED=true` 和 `ADDRESS_SYNC_NG_REDISTRIBUTION_ALLOWED=true`。

适配器要求六位邮编和 district；在真实授权样本通过住宅质量门禁前保持关闭。合成 feed 吞吐测试不能证明 NIPOST 或 ProgIS 的真实容量。

### Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/) 创建账号和项目。
2. 复制项目 Key，并查看[反向地理编码文档](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)和[官方价格与额度](https://www.geoapify.com/pricing/)。
3. 在“后台 → 服务凭据 → Geoapify”逐个添加 Key。`GEOAPIFY_API_KEY`、`GEOAPIFY_API_KEY_2` 等环境变量只用于首次部署导入。

韩国 K-apt 每次核验邮编前都从加密凭据池取 Key，并分别回写认证失败、限速、额度等待和暂时失败。全部 Key 不可用时，同步等待数据库记录的最早恢复时间。同一项目或账户共享额度的 Key 必须配置相同的额度作用域。Geoapify 当前每次 Reverse Geocoding 消耗一个 credit；套餐可能变化，因此后台额度仍可编辑。`429` 响应优先遵循 `Retry-After`；平台没有返回重置时间时，按该凭据配置的时区计算本地日额度窗口。

### 新加坡 OneMap

1. 注册 [OneMap API](https://www.onemap.gov.sg/apidocs/register)。
2. 通过[官方认证接口](https://www.onemap.gov.sg/apidocs/authentication)生成 Access Token。
3. 在新加坡导入进程启动前设置 `ONEMAP_ACCESS_TOKEN`。

OneMap 官方说明 Token 有效期为 3 天。到期前更新环境变量，并重启读取该变量的同步进程。

### Google Geocoding

1. 创建或选择 Google Cloud 项目、关联结算账户并启用 Geocoding API。
2. 创建 API Key，限制可用 API 和服务器来源。
3. 设置 `GOOGLE_GEOCODING_API_KEY`，或在后台添加。

按 Google [官方配置指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)操作，并在[用量与结算页面](https://developers.google.com/maps/documentation/geocoding/usage-and-billing)检查当前价格、额度和告警设置。

### OS Data Hub

1. 登录 [OS Data Hub](https://osdatahub.os.uk/)。
2. 打开“Data → API Projects”，创建项目并添加所需 API。
3. 复制项目 Key，设置 `OS_DATA_HUB_API_KEY`。

[官方账号与 API FAQ](https://osdatahub.os.uk/support/faqs/account-and-apis#generateApiKey)也说明了重新生成 Key 的步骤。除非选用的数据策略明确要求，否则该集成为可选项。

### 有道翻译

1. 注册[有道智云](https://ai.youdao.com/)，创建应用并开通文本翻译。
2. 获取应用 ID 与应用密钥。
3. 设置 `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET`，或在“后台 → 服务凭据 → 在线翻译”保存。
4. `GOOGLE_TRANSLATION_ENABLED` 只控制 Google 在线翻译路径；关闭后，已配置的有道仍可作为翻译服务。

[官方文本翻译 API](https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html)说明了 v3 SHA-256 签名。应用密钥不得进入前端代码。

## 项目自身密钥

这些值由部署者自行生成，不是第三方 API Key：

```bash
openssl rand -base64 32   # CONFIG_MASTER_KEY
openssl rand -hex 32      # SYNC_ADMIN_TOKEN
openssl rand -base64 36   # 管理员与 PostgreSQL 密码
```

| 变量 | 用途 |
|---|---|
| `CONFIG_MASTER_KEY` | 加密平台凭据。必须稳定保存并备份；更换后旧密文无法读取。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 仅在 PostgreSQL 尚无管理员身份时创建首个管理员。 |
| `SYNC_ADMIN_TOKEN` | API 与同步控制进程之间鉴权；两个进程必须使用同一值。 |
| `POSTGRES_URL` 中的密码 | 应用连接 PostgreSQL 的密码；保留字符必须进行 URL 编码。 |

## 轮换与冷却

系统按启用状态、QPS、额度、有效期、冷却时间和最近使用时间选择凭据。一个 Key 可以同时拥有日/月多个额度窗口，任一窗口耗尽都会轮换到其他 Key。单个 Key 失败后，本轮只排除该 Key，并继续使用其他可用 Key。额度耗尽时等待平台返回的恢复时间或对应周期边界；QPS 和分钟限制只进入短冷却。全部 Key 暂不可用时，任务等待最早恢复的 Key，而不会永久停用整个平台。

官方控制台和响应头优先于文档示例。创建凭据时应在后台正确配置服务名称、周期、上限、时区边界和可选的共享额度组。

## 提交前检查

1. 运行 `npm run check:public`。
2. 检查 `git diff --cached --name-only`，确保没有 `.env`、数据库、备份、日志、原始响应、证书或私钥。
3. 只在管理后台测试凭据，不把完整值复制到日志或截图。
4. 若凭据曾被显示，立即轮换。

官方页面核对日期：2026-08-05。平台条款、套餐、额度和控制台流程可能变化。
