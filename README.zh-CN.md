<p align="center"><img src="public/favicon.svg" width="88" height="88" alt="Address Logo" /></p>
<h1 align="center">Address</h1>
<p align="center"><strong>基于 PostgreSQL 的自托管真实住宅地址生成器</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/在线演示-address.333186.xyz-1769e0" alt="在线演示" /></a>
</p>

**Address 是真实住宅地址生成器。** 发布池中的住宅基础地址来自官方开放数据、国家或地区地址登记、地图登记建筑及具有明确住宅用途证据的开放地图数据，不使用随机街道、门牌或邮编冒充真实地址。每条记录保留来源坐标，可用于 Google Maps、高德地图等覆盖相应地区的地图服务定位；具体平台的文字搜索结果取决于其地区覆盖、索引名称和更新时间。

## 核心功能

- 配置 27 个国家和地区，并按国家实际行政结构提供州省、城市、区县和邮编筛选。
- 严格筛选：所选范围没有合格记录时返回错误，不会悄悄切换到其他地区。
- 从当前筛选范围的全部合格地址中快速随机选择，不会反复读取数据库前几条。
- 支持原文、英文、简体中文、繁体中文、日语、韩语、德语、法语、西班牙语和葡萄牙语展示路径。
- 地址语言和资料语言分别记忆；浏览器首次打开默认 English，生成和切换国家不会重置选择。
- 地址收藏保存在浏览器中，支持按大洲或国家分组与筛选、拖动或序号排序、复制、删除，以及跳转 Google Maps 或高德地图。
- 每个国家可配置热门行政区、热门城市和特殊区域；美国包含无州级销售税州。
- 提供公开覆盖监控，以及管理员仪表盘、地址数据规则、同步队列与同步历史、快捷区域、平台凭据、访问控制、黑名单和 API Token 页面。
- JSON API 提供健康检查、国家、可用性、地区选项、搜索、地址/资料生成、批量生成和监控接口，并包含 Python、cURL 和 JavaScript 示例。
- 运行时完全使用 PostgreSQL，包含连接池、事务发布、地区索引和预构建随机地址索引。

## 支持范围

| 区域 | 国家和地区 |
|---|---|
| 北美 | US、CA、MX |
| 欧洲 | GB、DE、FR、IT、ES、NL、RU |
| 东亚 | CN、HK、TW、JP、KR |
| 东南亚 | SG、MY、TH、PH、VN |
| 南亚 | IN |
| 大洋洲 | AU |
| 中东 | TR、SA |
| 南美 | BR |
| 非洲 | NG、ZA |

## 真实住宅地址来源与字段

下表对应当前同步实现。除“中国室内字段”一项外，生成器不会随机补造地址组件；官方目录唯一匹配得到的邮编或行政区仍属于来源真实字段。必填字段缺失、行政区冲突、坐标越界或住宅证据不足的记录不会进入发布池。

| 国家/地区 | 当前地址数据来源 | 地址组成 | 真实/来源字段 | 合成或补全字段 | 住宅真实性依据 |
|---|---|---|---|---|---|
| 美国（US） | Overture Maps、Geofabrik OSM 州级分片 | 门牌、道路、城市、州、ZIP、坐标 | 全部地址字段及坐标 | 无；仅规范格式 | OSM/Overture 明确住宅建筑或用途 |
| 加拿大（CA） | Statistics Canada 全国地址登记、Overture Maps、Geofabrik OSM | 门牌、道路、城市、省、邮编、坐标 | NAR 或地图来源的地址字段及坐标 | 无；仅规范邮编格式 | NAR 住宅建筑用途或地图来源明确住宅用途 |
| 墨西哥（MX） | INEGI 全国地址框架；同源标准化包仅补名称 | 门牌、道路、住区、市镇、州、邮编、坐标 | INEGI 原始门牌、道路、住区、行政区、邮编及坐标 | 州/城市名称可由同源记录确定性映射；不生成地址 | INEGI `TIPODOM=VIVIENDA` |
| 英国（GB） | Geofabrik OSM；Postcodes.io/ONS 仅核验 | 单元/楼宇、门牌、道路、城镇、邮编、坐标 | OSM 中存在的全部地址字段及坐标 | 无；仅规范格式 | OSM/建筑数据明确住宅用途 |
| 德国（DE） | Overture Maps、Geofabrik 16 州分片；OpenPLZ 辅助 | 门牌、道路、城市、邮编、坐标 | 全部地址字段及坐标 | 无；不补 Wohnung/Etage | 明确住宅建筑或用途 |
| 法国（FR） | CSTB BDNB 与 BAN 关联数据、Overture Maps、Geofabrik 27 区域分片 | 门牌、道路、补充号、市镇、邮编、坐标 | BDNB/BAN 或地图来源的地址字段及坐标 | 无；仅规范格式 | BDNB 住宅用途及可靠 BAN 关联，或地图来源明确住宅用途 |
| 意大利（IT） | Overture Maps、Geofabrik OSM | 门牌、道路、城市、省/大区、CAP、坐标 | 全部地址字段及坐标 | 无；不补内部号 | 明确住宅建筑或用途 |
| 西班牙（ES） | Catastro INSPIRE 地址/建筑数据、Overture Maps、Geofabrik OSM | 门牌、道路、市镇、省、邮编、坐标 | Catastro 或地图来源的地址字段及坐标 | 无；只保留来源楼梯/门号 | Catastro 住宅用途和住宅单元数，或地图来源明确住宅用途 |
| 荷兰（NL） | Kadaster BAG（PDOK）及 Overture Maps | 门牌/字母/附加号、道路、城市、省、邮编、坐标 | BAG/来源全部地址字段及坐标 | 无；仅可逆组合门牌格式 | BAG 在用 `woonfunctie` 或 Overture 明确住宅用途 |
| 俄罗斯（RU） | Geofabrik OSM | 门牌、道路、城市、联邦主体、邮编、坐标 | 全部地址字段及坐标 | 无；不补 корпус/квартира | OSM 明确住宅建筑 |
| 中国（CN） | AreaCity/StatsGov；高德、百度、腾讯住宅小区 POI | 省、市、区县、街道/道路门牌、小区、栋/单元/楼层/室、坐标 | 行政区、小区名、道路门牌和平台坐标 | 仅栋、单元、楼层、室号为合成字段并标记 `synthetic`；不生成邮编 | 严格住宅分类、行政区一致、数字门牌和机构黑名单门禁 |
| 中国香港（HK） | 房委会公屋单位、屋宇署楼宇资料、ALS | 单位/楼层、楼宇、门牌、街道、地点、18 区、地域、坐标 | 公屋单位字段或私人住宅楼宇字段及坐标；无通用邮编 | 无 | 房委会住宅库存，或屋宇署 `Residential/Composite` Tower |
| 中国台湾（TW） | 内政部实价登录、中华邮政 3+3、地方政府门牌点 | 门牌、路街段巷弄、区乡镇市、县市、邮编、坐标 | 住宅成交门牌、行政区、唯一精确匹配邮编及坐标 | 无；不以邻近点补全 | 实价登录住宅主要用途及住宅建筑型态 |
| 日本（JP） | 数字厅 ABR/Geolonia、日本邮便、PLATEAU/MLIT、Geofabrik OSM | 都道府县、市区町村、町域/丁目、街区与住居号或地番、邮编、坐标 | ABR 地址字段、唯一匹配的日本邮便邮编及来源坐标 | 无；建筑名和室号缺失时留空 | 地址点精确落入 PLATEAU/OSM 住宅建筑面 |
| 韩国（KR） | K-apt、Juso/OpenAddresses 归档、Geofabrik/Overture | 市/道、市/郡/区、邑面洞、道路、建筑号、邮编、坐标 | K-apt 地番或 Juso 道路名地址字段及坐标 | 无；不生成栋、单元或室号 | K-apt 官方共同住宅，或 Juso 点与住宅建筑相交 |
| 新加坡（SG） | HDB Property Information、Existing Building、OneMap、Geofabrik OSM | 楼栋号、道路、规划城镇、6 位邮编、坐标 | HDB 楼栋、道路、城镇；OneMap 唯一匹配的邮编和坐标 | 仅按同楼栋和道路唯一匹配补全，不生成门牌 | HDB `residential=Y` 且住宅单元数大于零，或 OSM 住宅建筑 |
| 马来西亚（MY） | Geofabrik OSM 马来西亚分片 | 单元/地块、楼宇、道路、县区、城市、州、邮编、坐标 | OSM 中存在的全部地址字段及坐标 | 无；不补单元 | OSM 明确住宅建筑并排除商业 POI |
| 泰国（TH） | DPT 官方建筑图层、Geofabrik OSM | 门牌、村、道路、分区、县区、府、邮编、坐标 | DPT 或 OSM 的地址、行政区、邮编及几何字段 | 无；仅将建筑面转换为内部点并规范格式 | DPT 住宅建筑分类或 OSM 明确住宅建筑 |
| 菲律宾（PH） | Geofabrik OSM、PHLPost；PSA PSGC 仅核验行政区 | 门牌、道路、Barangay、城市/市镇、省、邮编、坐标 | OSM 地址字段及坐标 | 缺邮编时仅按 PHLPost 省+城市/市镇唯一匹配补全 | OSM 明确住宅建筑 |
| 越南（VN） | Geofabrik OSM；Google Geocoding 补全 | 门牌、道路、坊/社、省级城市/省、邮编、坐标 | 来源字段及坐标 | 无；仅接受来源五位邮编 | OSM 明确住宅建筑 |
| 土耳其（TR） | Geofabrik OSM、伊兹密尔官方 Building Identity | 门牌、道路、区、省、邮编、坐标 | 全部来源地址字段及坐标 | 无；仅规范格式 | OSM 住宅标签或官方 `Konut` 用途 |
| 沙特阿拉伯（SA） | 全国地址点保全包、Overture、Geofabrik OSM | 楼宇/门牌、道路、区、城市、邮编、坐标 | 全国地址点的地址字段及坐标 | 无；仅规范格式 | 地址点与明确住宅建筑面精确关联 |
| 印度（IN） | Geofabrik OSM；Mappls Reverse Geocoding；Google Geocoding 补全 | 门牌、道路/地点、县区、城市、邦、PIN、坐标 | OSM 住宅建筑、门牌和道路；地理编码行政字段与 PIN | 无；不补公寓或楼层 | OSM 明确住宅建筑 |
| 澳大利亚（AU） | Overture Maps、Geofabrik OSM | 单元、门牌、道路、郊区、州、邮编、坐标 | 全部来源地址字段及坐标 | 无；不补单元 | 明确住宅建筑或用途；地址存在本身不作为住宅证据 |
| 巴西（BR） | Geofabrik OSM | 门牌、道路、街区、城市、州、CEP、坐标 | OSM 中存在的全部地址字段及坐标 | 无；不补 complemento | OSM 明确住宅建筑 |
| 尼日利亚（NG） | Geofabrik OSM；Google Geocoding 补全 | 门牌、道路、地区、城市、州、邮编、坐标 | 来源字段及坐标 | 无；不推算缺失字段 | OSM 明确住宅建筑 |
| 南非（ZA） | eThekwini 官方地址与分区、Cape Town 官方地块、Geofabrik OSM、SAPO | 单元、门牌、道路、郊区、城市、邮编、坐标 | 官方地址/地块字段、OSM 补充字段、SAPO 唯一匹配邮编及坐标 | 无；不补单元 | 官方住宅 zoning 精确关联，或 OSM 明确住宅建筑 |

更详细的数据源版本、坐标系、去重和发布门禁见[数据源文档](docs/data-sources.md)及[各国家/地区策略](docs/strategies/)。

## 界面截图

<table>
  <tr><th>美国生成界面</th><th>中国生成界面</th></tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="美国生成界面" /></td>
    <td><img src="image/webui-cn-overview.png" alt="中国生成界面" /></td>
  </tr>
</table>

### 数据监控

<img src="image/webui-monitor.png" alt="公开地址数量与行政区覆盖监控" />

### 管理员界面

<table>
  <tr><th>仪表盘</th><th>地址数据</th></tr>
  <tr>
    <td><img src="image/admin-dashboard.png" alt="管理员仪表盘" /></td>
    <td><img src="image/admin-address-data.png" alt="地址数据管理" /></td>
  </tr>
  <tr><th>同步队列</th><th>快捷区域</th></tr>
  <tr>
    <td><img src="image/admin-sync-queue.png" alt="同步队列及完成规则" /></td>
    <td><img src="image/admin-quick-locations.png" alt="带可用地址数量的快捷区域搜索" /></td>
  </tr>
</table>

<img src="image/admin-map-keys.png" alt="已完全遮罩的地图密钥和额度管理" />

## 架构

```text
Astro 静态页面 + React 界面
             │
             ▼
       Hono Node.js API
        ├─ PostgreSQL 地址与控制数据
        ├─ 从 PostgreSQL 构建的随机/筛选内存索引
        └─ 本地格式化、资料生成与可选翻译

同步监督进程
        ├─ 可续跑的批量/API 适配器
        ├─ 按国家执行验证与住宅证据门禁
        ├─ PostgreSQL 事务发布
        └─ 覆盖统计与有界同步队列
```

## 全自动同步规则

一个国家只有在所有已启用规则都满足时才算完成：

1. 合格地址总量达到目标；
2. 最低行政层覆盖率和每节点最低数量达到目标；
3. 已配置的一级、二级行政区最低数量达到目标；
4. 所有单节点覆盖目标达到要求。

仅达到国家总量不能标记完成。若数据源已经被证明耗尽，则该国家继续显示未完成，但不会反复进入执行队列；只有来源或版本指纹变化后才重新评估。

队列包含有限重试、指数退避、额度/冷却恢复时间、可续跑 checkpoint、无增长锁存和连续失败暂停机制，因此不会对同一个没有变化的数据源无限循环。同步历史记录每个来源、耗时、结果和地址增量，过期同步产物由系统自动清理。中国在仍具备同步条件时拥有最高自动优先级。

## 部署

```bash
git clone https://github.com/daimon3332/address.git
cd address
sh ops/init-compose.sh
docker compose up -d
```

完整说明见[部署文档](docs/DEPLOYMENT.zh-CN.md)。

## 配置与 API Key

- 前端密码、管理员密码、API Token、平台密钥、额度和快捷区域均在管理员后台设置。
- 平台密钥默认可选；只有所选同步策略需要时才必须配置。
- 多个 Key 独立轮换。当前 Key 失败时先冷却并尝试其他 Key；全部不可用时等待最早恢复时间。
- 各平台用途、官方申请入口和后台配置名称见独立的 [API Key 配置文档](docs/API_KEYS.zh-CN.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [API 文档](docs/API.zh-CN.md) | Bearer 鉴权、生成、筛选、错误和监控 |
| [API Key](docs/API_KEYS.zh-CN.md) | 平台用途、申请入口、所需产品和后台配置 |
| [部署文档](docs/DEPLOYMENT.zh-CN.md) | PostgreSQL、VPS 目录、进程、Nginx、备份、恢复和升级 |
| [开发文档](docs/DEVELOPMENT.zh-CN.md) | 架构、本地检查、扩展点和发布门禁 |
| [地址格式](docs/address-formats.md) | 各国格式与字段行为 |
| [国家策略](docs/strategies/) | 数据源、证据、坐标、去重、验证和更新策略 |

## 社区

- [linux.do](https://linux.do): **Learn AI at L-Site!!!**

## 许可证

项目源码使用 [MIT](LICENSE)。上游数据集保留各自的许可与署名要求。
