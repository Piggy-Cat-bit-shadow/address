<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="Address Logo" />
</p>

<h1 align="center">Address</h1>

<p align="center">面向 27 个国家和地区的自托管地址与合成测试资料生成器</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/daimon3332/address/releases"><img src="https://img.shields.io/github/v/release/daimon3332/address" alt="Release" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/Live_Demo-address.333186.xyz-0f766e" alt="在线演示" /></a>
</p>

Address 把真实开放数据中的道路、行政区、坐标和邮编与明确标记的合成室内字段结合，提供原文、英文和简体中文地址，并生成适合表单与软件测试的关联资料。

> 生成结果属于测试资料，不代表地址可投递、真实居住、身份、支付账户有效性或所有权关系。

## 🚀 使用流程

选择国家和地区 → 选择普通或住宅证据模式 → 生成地址与测试资料 → 复制单项字段或导出结果。

## ✨ 核心功能

- 覆盖 27 个国家和地区，支持州省、城市和邮编筛选。
- 精确 → 附近 → 同州省 → 全国分级回退，已同步国家持续有结果。
- 支持根据 IP 坐标就近生成，并使用本地 SQLite RTree 兜底。
- 地址提供原文、英文和简体中文三种表示。
- 来源支持的地址组件与明确标记的合成室内字段相互分离。
- 同时生成基本资料、沙盒银行卡、工作、财务、网络与扩展信息。
- 提供 Google 坐标预览、地址搜索和中国高德网页链接。
- 自定义黑名单热加载，并保留证据与来源署名。
- 首次导入支持断点续跑，日常轮转包含质量和容量门禁。

## 🧭 地址来源与字段真实性

默认同步地址池按下表使用对应来源。只有在启用相应模式和凭据时才会调用实时服务；实时服务不会替代默认离线地址池。

| 国家/地区 | 默认来源 | 真实/来源地址字段 | 生成/虚构地址字段 |
|---|---|---|---|
| 美国（US） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、州、ZIP、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成 `Apt`/房间号 |
| 加拿大（CA） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成 `Unit`/房间号 |
| 墨西哥（MX） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、市镇、州、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 英国（GB） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城镇、Postcode、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成 `Flat` |
| 德国（DE） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 法国（FR） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 意大利（IT） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、大区、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 西班牙（ES） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 荷兰（NL） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 俄罗斯（RU） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、联邦主体、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 中国（CN） | [AreaCity](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov) + 高德/百度/腾讯 POI | 省/直辖市、城市、区县、乡镇街道、地图登记小区名和地址、平台坐标 | 1–3栋、1–3单元、2–6层、每层01–04室 |
| 中国香港（HK） | [Geofabrik OSM](https://download.geofabrik.de/) | 大厦/道路、分区、地区、来源几何坐标 | 缺失的楼层/单位/房间信息可能生成 |
| 中国台湾（TW） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、县市、区、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 日本（JP） | [Overture Maps](https://overturemaps.org/) | 番地、道路、自治体、都道府县、邮编、来源几何坐标 | 普通地址无；公寓缺少房间信息时可能生成房间号 |
| 韩国（KR） | [Geofabrik OSM](https://download.geofabrik.de/) | 道路、建筑号、区、市/道、邮编、来源几何坐标 | 缺失的楼栋/单元/房间信息可能生成 |
| 新加坡（SG） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、地区、邮编、来源几何坐标 | 缺失的公寓单元可能生成 |
| 越南（VN） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、区、城市、省、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 泰国（TH） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 菲律宾（PH） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、描笼涯/区、城市、大区、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 马来西亚（MY） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、县/区、城市、州、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 印度（IN） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、县区、城市、州、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 澳大利亚（AU） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、郊区、州、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 土耳其（TR） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 沙特阿拉伯（SA） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 巴西（BR） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、州、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 尼日利亚（NG） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、州、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |
| 南非（ZA） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、郊区、邮编、来源几何坐标 | 普通地址无；公寓缺少室内信息时可能生成室内字段 |

“普通地址无”表示街道级地址字段没有被编造；如果是公寓记录且来源没有正式室内信息，仍可能生成测试用室内字段。

### 真实字段与合成字段

| 字段 | 来源说明 |
|---|---|
| 国家、地区、城市、区县和道路 | 来自地址记录并经过规范化；缺失的行政区名称可能由本地目录补全。 |
| 门牌号 | 存在来源或地图登记值时保留；中国不再替换为生成门牌号。 |
| 邮编 | 优先使用有效来源邮编；缺失或格式错误时可能使用最近的目录邮编补全。 |
| 坐标 | 复制来源几何位置，可能是地址点、建筑点或 OSM 道路/建筑 way 的几何中心。 |
| 建筑或小区 | 有来源值时优先使用。中国住宅模式只使用高德、百度或腾讯同步的小区，不使用内置词库回退。 |
| 公寓、楼栋、单元和房间 | 有正式或来源标记值时保留；中国以及其他国家的公寓记录在缺少室内信息时可能生成测试字段。 |
| 姓名、电话、邮箱、工作、财务、网络和沙盒银行卡 | 合成测试资料。 |

因此，中国地址应理解为：**经 AreaCity 校验的行政区，加地图平台真实小区、登记地址和坐标，仅室内层级为生成数据**。其他国家保留来源门牌号，但缺少公寓/单元信息时仍可能补全。`verified` 表示通过来源证据和项目质量检查，不代表地址当前存在、有人居住或可以投递。

### Google 地图与高德地图说明

- **Google 坐标预览**直接打开来源几何位置的 `latitude,longitude`，这是位置预览，不是 Google 对投递或居住状态的证明。
- **Google 地址搜索**会包含中国地图平台登记地址和真实小区名，但排除生成的楼栋、单元和房间。
- **高德地图**只为中国生成链接，打开前会把来源 WGS-84 坐标转换为 GCJ-02。
- 地图点可能是地址点、建筑中心或 way 的几何中心，不保证是入口或具体房间。默认生成流程也不宣称每条记录都经过 Google Geocoding 独立认证。

字段示例和来源细节请参阅[地址格式](docs/address-formats.md)、[数据来源](docs/data-sources.md)和 [API 文档](docs/API.zh-CN.md)。

## 🖼️ Webui Preview (Webui 预览)

<details>
<summary>展开查看美国与中国完整 WebUI 预览</summary>

<br />

<table>
  <tr>
    <th width="50%">美国</th>
    <th width="50%">中国</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="美国 WebUI 总览" /></td>
    <td><img src="image/webui-cn-overview.png" alt="中国 WebUI 总览" /></td>
  </tr>
  <tr>
    <th>生成器</th>
    <th>生成器</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-generator.png" alt="美国地址生成器" /></td>
    <td><img src="image/webui-cn-generator.png" alt="中国地址生成器" /></td>
  </tr>
  <tr>
    <th>地址</th>
    <th>地址</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-address.png" alt="美国地址结果" /></td>
    <td><img src="image/webui-cn-address.png" alt="中国地址结果" /></td>
  </tr>
  <tr>
    <th>基本资料</th>
    <th>基本资料</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-profile.png" alt="美国基本测试资料" /></td>
    <td><img src="image/webui-cn-profile.png" alt="中国基本测试资料" /></td>
  </tr>
  <tr>
    <th>银行卡测试资料</th>
    <th>银行卡测试资料</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-test-card.png" alt="美国银行卡测试资料" /></td>
    <td><img src="image/webui-cn-test-card.png" alt="中国银行卡测试资料" /></td>
  </tr>
  <tr>
    <th>工作信息</th>
    <th>工作信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-employment.png" alt="美国工作信息" /></td>
    <td><img src="image/webui-cn-employment.png" alt="中国工作信息" /></td>
  </tr>
  <tr>
    <th>财务信息</th>
    <th>财务信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-finance.png" alt="美国财务信息" /></td>
    <td><img src="image/webui-cn-finance.png" alt="中国财务信息" /></td>
  </tr>
  <tr>
    <th>网络与扩展信息</th>
    <th>网络与扩展信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-network.png" alt="美国网络与扩展信息" /></td>
    <td><img src="image/webui-cn-network.png" alt="中国网络与扩展信息" /></td>
  </tr>
  <tr>
    <th>Google 地图</th>
    <th>Google 地图</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-map.png" alt="美国 Google 地图预览" /></td>
    <td><img src="image/webui-cn-map.png" alt="中国 Google 地图预览" /></td>
  </tr>
</table>

</details>

## 📚 项目文档

| 文档 | 内容 |
|---|---|
| [API 文档](docs/API.zh-CN.md) | 公开端点、参数、错误、同步管理、CORS 与示例 |
| [部署文档](docs/DEPLOYMENT.zh-CN.md) | API Key、私密配置、VPS、Nginx、同步、备份与容量 |
| [二次开发文档](docs/DEVELOPMENT.zh-CN.md) | 架构、本地环境、数据管线、扩展点、测试与发布门禁 |

## ⚡ 快速开始

要求 Node.js 24 或更新版本。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

新数据库只有表结构。执行 `npm run data:address-pool:bootstrap` 可开始支持断点续跑的 27 国导入。生产 VPS 部署前请阅读[部署文档](docs/DEPLOYMENT.zh-CN.md)。

## 🔑 配置摘要

小区同步完成后，日常生成只查询服务器 SQLite，不调用地图平台。在 `/admin/` 中配置多个高德、百度和腾讯 Key；它们使用服务器专有的 `CONFIG_MASTER_KEY` 加密保存到 `control.sqlite`。主密钥和初始化密码只写入被忽略的 `.env`、`.deploy.env` 或 `/root/address/runtime/address.env`，不要放入源码、浏览器代码、截图、Issue 或 CI 日志。

## 💾 数据库大小

以下数据于 2026-07-23、提交 `084805e`、27 国同步完成后实测：

| 内容 | 实测值 |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| 完整 `data/` 目录 | 7.89 GiB |
| 首次导入峰值 | 约 11.2 GiB |

实际大小会随上游版本和 WAL 活跃度变化。生产环境建议应用卷至少预留 **60 GiB**，用于同步、备份和恢复空间。

## 🌍 支持范围

美国、加拿大、墨西哥、英国、德国、法国、意大利、西班牙、荷兰、俄罗斯、中国、香港、台湾、日本、韩国、新加坡、越南、泰国、菲律宾、马来西亚、印度、澳大利亚、土耳其、沙特阿拉伯、巴西、尼日利亚和南非。

## 数据、隐私与许可

- [Overture Maps](https://overturemaps.org/) 提供部分地址记录，并保留具体来源元数据与条款。
- [OpenStreetMap](https://www.openstreetmap.org/copyright) 和 [Geofabrik](https://download.geofabrik.de/) 根据 ODbL 1.0 提供其他源数据。
- 客户端 IP 只用于用户请求的定位查询，不写入地址数据库。
- 室内字段、人物资料和银行卡字段均为合成测试数据。

项目代码使用 [MIT License](LICENSE)。重新分发的数据仍遵循对应来源的许可、署名和相同方式共享要求。仓库与 Release 不包含生产数据库或私密凭据。

## 社区

- [linux.do](https://linux.do)：**学AI，上L站！！！**
- [Nodeseek.com](https://www.nodeseek.com)：**Nodeseek是一个为热爱web开发、托管、vps /服务器和其他极客事物的人提供的地方。**
