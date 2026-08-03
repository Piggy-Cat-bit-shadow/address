# API Key 配置

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

已有 PostgreSQL 地址池可以在没有第三方密钥时正常生成地址。只有对应的同步、翻译、地理编码或地图预览功能才需要平台凭据。

## 保存位置与优先关系

- 启动值只能写入被 Git 忽略的 `.env` 或 `/root/address/runtime/address.env`，后者权限应设为 `600`。不要把真实值写入示例文件。
- 管理后台支持保存高德、百度、腾讯、OneMap、Geoapify、Google Geocoding、有道及高德浏览器地图凭据；所有值使用 `CONFIG_MASTER_KEY` 加密后存入 PostgreSQL。
- 进程启动时会导入尚未保存的环境变量密钥；后台记录与其共同参与轮换，修改示例文件不会覆盖已有密文记录。
- 韩国批量同步进程目前在启动时直接读取 `GEOAPIFY_API_KEY`；新加坡 OneMap 辅助导入直接读取 `ONEMAP_ACCESS_TOKEN`。

## 平台凭据

### 高德 WebService

1. 注册并进入[高德控制台](https://console.amap.com/dev/index)。
2. 按[官方创建 Key 文档](https://lbs.amap.com/api/webservice/create-project-and-key)创建应用和 **WebService** Key。
3. 按控制台能力限制来源，只开启项目需要的服务。
4. 配置 `AMAP_API_KEY`；额外密钥使用 `AMAP_API_KEY_2` 等编号，或在“后台 → 服务凭据”逐个添加。

服务端同步 Key 不得与浏览器地图 Key 共用。

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

### 腾讯位置服务

1. 进入[腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)创建应用和 Key。
2. 只在需要时开启 **WebService API**。
3. 配置 IP 或签名限制。
4. 设置 `TENCENT_API_KEY`、编号变量，或在后台逐个添加。

腾讯[官方状态码表](https://lbs.qq.com/service/webService/webServiceGuide/status)说明：`120` 为每秒请求量上限，`121` 为每日调用量上限。响应头 `X-LIMIT` 可提供实时用量，最终以控制台为准。

### Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/) 创建账号和项目。
2. 复制项目 Key，并查看[官方价格与额度](https://www.geoapify.com/pricing/)。
3. 设置 `GEOAPIFY_API_KEY`；API 侧需要轮换时也可以在后台添加。

韩国 K-apt 首次导入需要该环境变量来核验邮编。不要在配置文档中写死额度，套餐和接口 credits 可能变化。

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

系统按启用状态、QPS、额度、有效期、冷却时间和最近使用时间选择凭据。单个 Key 失败后，本轮只排除该 Key，并继续使用其他可用 Key。额度耗尽时等待平台返回的恢复时间或配置周期边界；短暂错误使用有上限的指数冷却。全部 Key 暂不可用时，任务等待最早恢复的 Key，而不会永久停用整个平台。

官方控制台和响应头优先于文档示例。创建凭据时应在后台正确配置服务名称、周期、上限、时区边界和可选的共享额度组。

## 提交前检查

1. 运行 `npm run check:public`。
2. 检查 `git diff --cached --name-only`，确保没有 `.env`、数据库、备份、日志、原始响应、证书或私钥。
3. 只在管理后台测试凭据，不把完整值复制到日志或截图。
4. 若凭据曾被显示，立即轮换。

官方页面核对日期：2026-08-03。平台条款、套餐、额度和控制台流程可能变化。
