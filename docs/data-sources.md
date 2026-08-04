# 数据源、准确性与自动同步

更新：2026-08-04。本文汇总各国家和地区使用的数据源、发布规则与自动同步流程。字段、坐标系、去重和验证细节见 [`strategies/`](strategies/)。

## 1. 发布原则

- **地址准确性优先**：没有可靠地址存在证据或住宅用途证据的记录不发布。
- **质量高于数量**：该国必填组件缺少任意一项，整条记录淘汰，不因覆盖率或目标数量降低门禁。
- **地址字段不编造**：只允许可逆格式规范化；附近邮编、邻近地址、翻译反推和随机地址事实一律不用于补缺。
- **E3 才可发布**：地址组件、坐标、行政区与邮编通过校验，并关联明确住宅建筑/用途证据。
- **严格地区匹配**：城市/区县筛选无覆盖时返回空结果，不替换为附近、州省或全国地址。
- **来源冲突即隔离**：行政区、门牌、邮编或坐标冲突的记录不进入 active 池。

中国额外要求：AreaCity 行政区有效；高德候选必须是住宅小区分类、行政区一致、具有数字门牌且不命中机构黑名单。百度/腾讯可增加验证等级，但不作为发布必需条件；小区及来源证据均在 180 天有效窗口内。

## 2. 当前主源

| 国家/地区 | 地址主源 | 邮编/行政区核验 | 住宅证据 | 策略 |
|---|---|---|---|---|
| 美国 US | Overture + Geofabrik 州级分片 | 源字段 + catalog；ZIP/ZIP+4 | OSM/Overture 住宅建筑 | [US](strategies/US-address-strategy.md) |
| 加拿大 CA | Overture | 源字段 + catalog；加拿大邮编格式 | 明确住宅建筑/用途 | [CA](strategies/CA-address-strategy.md) |
| 墨西哥 MX | INEGI 原始地址框架 + 同源标准化包 | INEGI 原始字段；5 位非零邮编 | `TIPODOM=VIVIENDA` | [MX](strategies/MX-address-strategy.md) |
| 英国 GB | Geofabrik OSM | 源值 + Postcodes.io | OSM 住宅建筑 | [GB](strategies/GB-address-strategy.md) |
| 德国 DE | Overture + Geofabrik 16 州分片 | 源字段 + catalog；OpenPLZ 仅辅助 | 明确住宅建筑/用途 | [DE](strategies/DE-address-strategy.md) |
| 法国 FR | Overture + Geofabrik 27 区域分片 | 源字段 + catalog；5 位邮编 | 明确住宅建筑/用途 | [FR](strategies/FR-address-strategy.md) |
| 意大利 IT | Overture + Geofabrik OSM | 源字段 + catalog；5 位 CAP | 明确住宅建筑/用途 | [IT](strategies/IT-address-strategy.md) |
| 西班牙 ES | Overture | 源字段 + catalog；5 位邮编 | 明确住宅建筑/用途 | [ES](strategies/ES-address-strategy.md) |
| 荷兰 NL | Kadaster BAG（PDOK OGC Features）+ Overture | BAG 源字段 + catalog；`1234 AB` | BAG 严格在用 `woonfunctie`；Overture 明确住宅建筑/用途 | [NL](strategies/NL-address-strategy.md) |
| 俄罗斯 RU | Geofabrik OSM | 源字段 + catalog；6 位邮编 | OSM 住宅建筑 | [RU](strategies/RU-address-strategy.md) |
| 中国 CN | AreaCity 行政区 + 高德住宅小区；百度/腾讯只作可选增强验证 | AreaCity + 民政部版本对照；6 位源邮编 | 高德住宅分类、行政区一致、数字门牌和机构黑名单门禁 | [CN](strategies/CN-China-address-generation.md) |
| 中国香港 HK | 屋宇署住宅/综合用途 Tower；房委会单位 + ALS；OSM 补充 | 官方 18 区双语映射与香港坐标；无通用邮编 | 屋宇署住宅用途或房委会公屋库存 | [HK](strategies/HK-address-strategy.md) |
| 中国台湾 TW | 内政部实价登录多季度住宅成交门牌 + OA 官方门牌点 | 县市/区一致 + 中华邮政 3+3 完整门牌精确匹配 | 实价登录住宅主要用途与住宅建筑型态 | [TW](strategies/TW-address-strategy.md) |
| 日本 JP | 数字厅 ABR/Geolonia + PLATEAU；OSM 住宅轮廓补充 | ABR 行政层级 + 日本邮便 7 位邮编唯一匹配 | ABR 点精确落入 PLATEAU/OSM 明确住宅建筑面 | [JP](strategies/JP-address-strategy.md) |
| 韩国 KR | K-apt 官方共同住宅目录 + Juso/OpenAddresses 归档 + Geofabrik OSM | Juso 5 位邮编与行政层级；K-apt 地番地址 | K-apt 官方共同住宅标识；Juso 地址点须与明确住宅建筑相交 | [KR](strategies/KR-address-strategy.md) |
| 新加坡 SG | HDB Property Information + Existing Building；Geofabrik OSM | HDB/OneMap 6 位邮编 | HDB 明确住宅字段与住宅单元数；OSM 住宅建筑 | [SG](strategies/SG-address-strategy.md) |
| 马来西亚 MY | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [MY](strategies/MY-address-strategy.md) |
| 泰国 TH | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [TH](strategies/TH-address-strategy.md) |
| 菲律宾 PH | Geofabrik OSM | 源字段 + catalog；4 位邮编 | OSM 住宅建筑 | [PH](strategies/PH-address-strategy.md) |
| 越南 VN | Geofabrik OSM；可选 Vpostcode 授权 feed（默认关闭、容量未验收） | 源字段 + catalog；五位邮编 | OSM 住宅建筑；授权 feed 的逐条/合同级住宅分类 | [VN](strategies/VN-address-strategy.md) |
| 土耳其 TR | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [TR](strategies/TR-address-strategy.md) |
| 沙特阿拉伯 SA | 全国地址点保全包 + Overture + Geofabrik OSM | 源字段 + catalog；5 位或 `5-4` 邮编 | 地址点精确落入明确住宅建筑面 | [SA](strategies/SA-address-strategy.md) |
| 印度 IN | Geofabrik OSM；可选 Mappls Nearby + Place Details（默认关闭、容量未验收） | 源字段 + catalog；6 位 PIN | OSM 住宅建筑；合同授权的 Mappls 住宅分类 | [IN](strategies/IN-address-strategy.md) |
| 澳大利亚 AU | Overture | 源字段 + catalog；4 位邮编 | 明确住宅建筑/用途 | [AU](strategies/AU-address-strategy.md) |
| 巴西 BR | Geofabrik OSM | 源字段 + catalog；CEP | OSM 住宅建筑 | [BR](strategies/BR-address-strategy.md) |
| 尼日利亚 NG | 默认无可发布源；可选 NIPOST/ProgIS 授权 feed（默认关闭、容量未验收） | 来源字段；6 位邮编 | 授权 feed 的逐条/合同级住宅分类 | [NG](strategies/NG-address-strategy.md) |
| 南非 ZA | eThekwini 官方地址点 + Cape Town 官方地块 + Geofabrik OSM | SAPO 官方 4 位邮编精确唯一匹配 | 官方住宅分区精确点/地块关联；OSM 明确住宅建筑 | [ZA](strategies/ZA-address-strategy.md) |

OpenAddresses 只用于发现可用上游；每个上游需单独核验许可和质量。libpostal 只用于解析/规范化，不证明地址真实或属于住宅。

### 授权住宅 feed 配置

Vpostcode 与 NIPOST/ProgIS 适配器默认关闭。启用前必须同时设置 `*_ENABLED=true`、`*_LICENSE_CONFIRMED=true` 和 `*_REDISTRIBUTION_ALLOWED=true`，并取得允许住宅字段、坐标、缓存和再分发的合同。远程 feed 只接受 HTTPS；本地 feed 只能放在 `ADDRESS_DATA_ROOT` 内。`*_FIELD_MAP` 是 JSON 对象，至少映射 `id`、`number`、`street`、`locality`、`admin1`、`postcode`、`longitude`、`latitude`，还要映射 `district`（NG 必需）；如果不是整库住宅，还必须映射 `residentialClass` 并在 `*_RESIDENTIAL_VALUES` 列出允许值。支持 `csv`、`json`（数组或 `records`/`data`）和 `jsonl`。容量审计见被忽略的 `docs/source-capacity-audit.md`，其中的合成吞吐结果不代表供应商容量。

## 3. 自动同步

国家完成条件为“总量目标 + 完整官方行政目录最低层覆盖率（零地址节点也计入分母）+ 最低层/一级/二级节点最低数 + 自定义节点目标”全部启用规则同时达标；任一规则未达标都保持未完成。

1. 最多 10 个国家并行发现、下载和准备；重型解析默认 4 路（可设 1–4），PostgreSQL 使用按国家隔离的事务发布。
2. 下载/调用上游到服务器 staging；相同 URL 与版本的原始包只下载一次，本地只做小型脱敏测试。
3. 解析并分离 `buildingName` 与 `unit`，执行全半角、大小写、空白和标准邮编分隔符等确定性规范化。
4. 按国家策略检查所有必填项、邮编格式、国家边界、行政层级、住宅用途和来源许可；OSM 独立地址点必须精确落入明确住宅建筑面，附近建筑不算证据；任一失败即记录拒绝原因并淘汰。
5. 候选按住宅证据、质量分和稳定哈希排序；每个最低行政节点先满足每节点、省市和单节点目标，再轮询分配额外记录；国家总量是完成下限，节点规则可以推动结果远超该数量，分片来源容量仍是技术硬限制。
6. 在影子表完成质量统计；全部门禁通过后仅切换同来源的旧快照。同一国家的多个来源保持 active，合并去重后重建覆盖统计。
7. 只比较最新候选与当前 active 快照；候选不足显示缺口，不放宽门禁。行政区划和邮编目录不受地址数量限制。
8. 发布后以官方行政区 ID 重建住宅覆盖和前端筛选；读取层再次执行同一规则，旧库脏记录立即停止返回；同步失败保留上一份已通过相同门禁的快照。
9. 按月检查批量源；中国行政区跟随 AreaCity 版本，小区按免费额度增量同步。高德只按 `types=120302` 查询，原始结果非空但全部被过滤时标记 `adapter_rejected_all`，不写成地区已耗尽。
10. 数据源确认耗尽的国家保持未完成但不进入执行队列，只有相同输入成功运行且所有未达规则均无进展时才锁定；总量不变但覆盖或节点达标数增加仍算进展，策略、目录、适配器、导入逻辑或来源版本变化会自动解锁。日/月额度和 QPS 冷却保留重置时间并自动恢复。中国未完成时拥有最高调度优先级；后台同步队列使用独立页面。

API Key 的申请、配置、轮换与冷却规则见 [API Key 配置文档](API_KEYS.zh-CN.md)。

## 4. 主要参考

- Overture: <https://docs.overturemaps.org/guides/addresses/>
- Geofabrik: <https://download.geofabrik.de/>
- AreaCity: <https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov>
- 民政部区划版本: <https://dmfw.mca.gov.cn/XzqhVersionPublish.html>
- 高德 JS 安全密钥: <https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode>
- Postcodes.io: <https://postcodes.io/>
- Geolonia Japanese Addresses v2: <https://github.com/geolonia/japanese-addresses-v2>
- OpenAddresses: <https://github.com/openaddresses/openaddresses>
- libpostal: <https://github.com/openvenues/libpostal>
