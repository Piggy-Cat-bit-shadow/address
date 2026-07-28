<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="Address Logo" />
</p>

<h1 align="center">Address</h1>

<p align="center">面向 27 个国家和地区的自托管真实住宅地址与合成测试资料生成器</p>

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

Address 只发布同时具备地址存在证据与独立住宅用途证据的记录。包括室内层级在内的地址字段均不编造，缺失值保持为空；同时提供原文、英文、简体中文地址和适合表单与软件测试的合成资料。

> 生成结果属于测试资料，不代表地址可投递、真实居住、身份、支付账户有效性或所有权关系。

## 🚀 使用流程

选择国家和地区 → 生成通过证据门禁的真实住宅地址与测试资料 → 复制单项字段或导出结果。

## ✨ 核心功能

- 覆盖 27 个国家和地区，支持州省、城市和邮编筛选。
- 地区筛选严格匹配；所选地区无合格记录时返回 `NO_POOL_COVERAGE`，不会替换成其他地区。
- IP 地区生成只接受坐标或城市匹配，不会替换成州省或全国记录。
- 地址提供原文、英文和简体中文三种表示。
- 所有地址组件均来自来源；门牌、楼栋、单元、楼层、房间或邮编缺失时保持为空。
- 同时生成基本资料、沙盒银行卡、工作、财务、网络与扩展信息。
- 中国与其他国家可分别启用 Google、高德地图预览，也可以全部关闭。
- 自定义黑名单热加载，并保留证据与来源署名。
- 首次导入支持断点续跑，日常轮转包含质量和容量门禁。

## 🧭 地址来源与字段真实性

active 地址池按下表使用对应来源。每条公开结果都必须通过地址存在性和住宅用途门禁；实时服务仅作为可选输入，其候选记录也执行相同门禁。

**质量高于数量：** [地址格式](docs/address-formats.md)规定的国家必填组件缺少任意一项，整条记录直接淘汰；表中的“保持为空”只适用于建筑名、来源单元等明确标记为可选的字段。系统不使用附近邮编、邻近地址或随机值补齐事实字段。

| 国家/地区 | 默认来源 | 真实/来源地址字段 | 生成地址字段 |
|---|---|---|---|
| 美国（US） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、州、ZIP、来源几何坐标 | 无；缺失字段保持为空 |
| 加拿大（CA） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 墨西哥（MX） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、市镇、州、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 英国（GB） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城镇、Postcode、来源几何坐标 | 无；缺失字段保持为空 |
| 德国（DE） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 法国（FR） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 意大利（IT） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、大区、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 西班牙（ES） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 荷兰（NL） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、城市、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 俄罗斯（RU） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、联邦主体、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 中国（CN） | [AreaCity](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov) + 高德/百度/腾讯 POI | 省/直辖市、城市、区县、乡镇街道、地图登记小区名和地址、平台坐标 | 无；缺失字段保持为空 |
| 中国香港（HK） | [Geofabrik OSM](https://download.geofabrik.de/) | 大厦/道路、分区、地区、来源几何坐标 | 无；缺失字段保持为空 |
| 中国台湾（TW） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、县市、区、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 日本（JP） | [Overture Maps](https://overturemaps.org/) | 番地、道路、自治体、都道府县、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 韩国（KR） | [Geofabrik OSM](https://download.geofabrik.de/) | 道路、建筑号、区、市/道、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 新加坡（SG） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、地区、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 越南（VN） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、区、城市、省、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 泰国（TH） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 菲律宾（PH） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、描笼涯/区、城市、大区、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 马来西亚（MY） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、县/区、城市、州、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 印度（IN） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、县区、城市、州、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 澳大利亚（AU） | [Overture Maps](https://overturemaps.org/) | 门牌、道路、郊区、州、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 土耳其（TR） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、省、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 沙特阿拉伯（SA） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 巴西（BR） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、州、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 尼日利亚（NG） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、城市、州、邮编、来源几何坐标 | 无；缺失字段保持为空 |
| 南非（ZA） | [Geofabrik OSM](https://download.geofabrik.de/) | 门牌、道路、郊区、邮编、来源几何坐标 | 无；缺失字段保持为空 |

“无”表示生成器不合成任何地址组件。必填地址字段缺失时整条记录不进入随机池；可选建筑名或来源单元缺失时保持为空。

### 地址来源与合成测试资料

| 字段 | 来源说明 |
|---|---|
| 国家、地区、城市、区县和道路 | 来自同一地址记录或精确行政关系并经过规范化；冲突记录不发布。 |
| 门牌号 | 只保留来源或地图登记值；缺失时整条记录淘汰。 |
| 邮编 | 除中国 POI 和香港外均为必填；只保留有效来源值或权威精确关联值，缺失或格式错误时整条记录淘汰。 |
| 坐标 | 复制来源几何位置，可能是地址点、建筑点或 OSM 道路/建筑 way 的几何中心。 |
| 建筑或小区 | 只使用与地址对象关联的来源值。中国小区至少需要两个独立地图平台一致后才发布。 |
| 公寓、楼栋、单元、楼层和房间 | 只保留正式或来源标记值；所有国家的缺失室内字段均保持为空。 |
| 姓名、电话、邮箱、工作、财务、网络和沙盒银行卡 | 合成测试资料。 |

中国使用**经 AreaCity 校验的行政区，以及通过多平台一致性检查的地图平台小区、登记地址和坐标**。其他国家将来源地址对象与独立住宅建筑或用途证据关联。`verified` 表示来源证据和质量门禁通过，不代表当前有人居住或可以投递。

### Google 地图与高德地图说明

- **Google 坐标预览**直接打开来源几何位置的 `latitude,longitude`，这是位置预览，不是 Google 对投递或居住状态的证明。
- **Google 地址搜索**只使用来源支持的地址组件；缺失的室内字段直接省略。
- **中国高德地图**在放置标记前把来源 WGS-84 坐标转换为 GCJ-02；高德国外地图保留来源坐标，并要求账号已开通世界地图能力。
- Google 与高德分别提供中国/国外开关，默认均为 Google 开启、高德关闭；一个平台的开关不会改变另一个平台。
- 地图点可能是地址点、建筑中心或 way 的几何中心，不保证是入口或具体房间。默认生成流程也不宣称每条记录都经过 Google Geocoding 独立认证。

高德使用三个彼此分离的值：仅服务端使用的 `AMAP_API_KEY` 是中国 POI 同步所用 WebService 凭据；受域名白名单限制的 `AMAP_JS_API_KEY` 是专用浏览器加载 Key，启用高德时会出现在浏览器网络请求中；`AMAP_JS_SECURITY_CODE` 仅在服务器以 AES-GCM 加密保存，并只由同源 `/_AMapService` 代理使用。高德官方推荐[代理模式](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)；国外地图还需要单独申请[世界地图权限](https://lbs.amap.com/api/javascript-api-v2/guide/map/world-map)。仓库示例中的凭据值全部是占位符，受跟踪文件中不包含真实 Key 或 Token。

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

小区同步完成后，日常生成只查询服务器 SQLite，不调用地图平台。在 `/admin/` 中配置多个高德、百度和腾讯服务端 Key；它们使用服务器专有的 `CONFIG_MASTER_KEY` 加密保存到 `control.sqlite`。高德地图渲染另用受域名限制的 JS API Key，配套安全密钥仅由 `/_AMapService` 服务端代理使用。所有真实凭据只写入被忽略的本地/运行配置或后台密文存储，不进入源码、截图、Issue 或 CI 日志。

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
- 地址与室内字段均来自来源，缺失值保持为空；人物资料和银行卡字段属于合成测试数据。

项目代码使用 [MIT License](LICENSE)。重新分发的数据仍遵循对应来源的许可、署名和相同方式共享要求。仓库与 Release 不包含生产数据库或私密凭据。

## 社区

- [linux.do](https://linux.do)：**学AI，上L站！！！**
- [Nodeseek.com](https://www.nodeseek.com)：**Nodeseek是一个为热爱web开发、托管、vps /服务器和其他极客事物的人提供的地方。**
