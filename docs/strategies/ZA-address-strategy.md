# ZA 南非地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | eThekwini Municipality `Street_Address` + `Zoning`；City of Cape Town `Land Parcels`（同一地块含门牌与 zoning）；Geofabrik `south-africa` 补充 |
| 格式 / 邮编 | `<unit> <house> <street>, <suburb>, <city> <postcode>, ZA`；unit 缺失不补；4 位邮编仅接受 South African Post Office 官方表中 `PlaceName=suburb`、`Town=city` 且唯一的 `StrCode` |
| 行政区 | eThekwini 使用 `DISTRICT/SUBURB` + KwaZulu-Natal；Cape Town 使用 SAPO 唯一 postal town + 官方 `OFC_SBRB_NAME` + Western Cape；冲突记录拒绝发布 |
| 住宅证据 | eThekwini 地址点必须精确落入唯一住宅 zoning；Cape Town 仅接受同一官方地块的纯 `Residential 1/2` 或 `General Residential 1-6`，逗号拼接的混合 zoning 全部拒绝；Geofabrik 仍要求 OSM 明确住宅建筑 |
| 发布门禁 | 质量高于数量。仅发布 E3：地址存在与独立住宅用途证据同时成立；本国格式规定的必填组件缺一即淘汰，字段冲突拒绝合并；只允许可逆、可验证的格式规范化。 |
| 同步频率 | 每月检查 eThekwini/SAPO；新快照通过门禁后原子切换，失败保留上一 active 快照 |
| 验证 / 排除 | 仅保留完整门牌字段与纯住宅 zoning，重复门牌按规范化键去重；数值道路、非标准门牌、多个邮编、混合/非住宅 zoning 和缺坐标记录全部拒绝。 |
| 许可 | eThekwini 与 City of Cape Town 官方 Open Data item 均指向各自专用条款（无 SPDX 代码）+ SAPO 官方邮编表；保留来源署名，不把条款标成 CC |
| 策略版本 / 状态 / 更新 | 1.9 / 官方双源 + 多规则完成下限 / 2026-08-03 |

- 默认 active 地址上限 8,000；省、市镇、地区单节点上限 4,000/3,800/60，后台可覆盖；只裁剪地址记录，行政区划与邮编目录保持完整。
- eThekwini 只覆盖 KwaZulu-Natal；Cape Town 只覆盖 Western Cape，并使用官方 parcel centroid，不通过附近地块推断住宅用途。
- Cape Town 来源依据：[Land Parcels 官方 item](https://www.arcgis.com/home/item.html?id=7c59bb7a1b724d11a70d3db591233df1)、[Street Address Numbers 官方 item](https://www.arcgis.com/home/item.html?id=c2101858187f424298f85e60f9706533)、[开放数据条款](https://www.capetown.gov.za/General/Terms-of-use-open-data) 与 [SAPO 邮编下载页](https://www.postoffice.co.za/questions/postalcode.html)。

- OSM 独立地址点仅在精确落入明确住宅建筑面时获得住宅用途证据；不使用附近建筑、同街道或邻近坐标推断。

- 公开生成和 IP 区域生成只读取 active PostgreSQL 住宅池；第三方平台 API 仅用于后台同步，不在公开请求期间调用。

统一证据等级、许可、配额与 VPS 边界见 [数据源与自动同步方案](../data-sources.md)。策略变化时同步更新本文件、实现与测试。
## 覆盖与保留

- 官方行政区目录定义覆盖分母；只有关联到官方节点的严格住宅地址计入分子。
- 每个有合格数据的最低行政区先满足每节点、省市和单节点目标，再轮询分配额外记录；国家总量是完成下限，节点规则可推动总量继续增长，来源或分片容量仍是技术硬限制。
- 每次国家快照发布后自动重建住宅覆盖；生成器只展示至少有 1 条可发布住宅地址的官方区域。


## 运行时随机生成

- 公开普通生成只从当前筛选范围内通过发布门禁的完整数据库候选集选择，不使用固定候选窗口、固定顺序或国家特例。
- 服务启动后由最多 4 个按国家分区的只读 worker 建立地址引用与筛选索引；每次按 seed 从完整候选集选择引用，再按主键从 PostgreSQL 读取完整地址及证据。
- 未传入 seed 时由服务器为每个请求生成新 UUID；相同显式 seed 在同一数据库快照中可复现。数据库提交后，新 worker 快照全部就绪才原子替换旧快照。
