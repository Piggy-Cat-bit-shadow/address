# 数据源、准确性与自动同步

更新：2026-07-28。这里只保留当前实现、已完成的本地可用性探测和发布门禁；各国细节见 `docs/strategies/`。

## 1. 发布原则

- **地址准确性优先**：没有可靠地址存在证据或住宅用途证据的记录不发布。
- **质量高于数量**：该国必填组件缺少任意一项，整条记录淘汰，不因覆盖率或目标数量降低门禁。
- **地址字段不编造**：只允许可逆格式规范化；附近邮编、邻近地址、翻译反推和随机地址事实一律不用于补缺。
- **E3 才可发布**：地址组件、坐标、行政区与邮编通过校验，并关联明确住宅建筑/用途证据。
- **严格地区匹配**：城市/区县筛选无覆盖时返回空结果，不替换为附近、州省或全国地址。
- **来源冲突即隔离**：行政区、门牌、邮编或坐标冲突的记录不进入 active 池。

中国额外要求：AreaCity 行政区有效；同一小区至少两个独立地图平台在名称、行政区、地址和坐标上匹配；小区及来源证据均在 180 天有效窗口内。

## 2. 当前主源

| 国家/地区 | 地址主源 | 邮编/行政区核验 | 住宅证据 | 策略 |
|---|---|---|---|---|
| 美国 US | Overture | 源字段 + catalog；ZIP/ZIP+4 | OSM/Overture 住宅建筑 | [US](strategies/US-address-strategy.md) |
| 加拿大 CA | Overture | 源字段 + catalog；加拿大邮编格式 | 明确住宅建筑/用途 | [CA](strategies/CA-address-strategy.md) |
| 墨西哥 MX | Overture | 源字段 + catalog；5 位邮编 | 明确住宅建筑/用途 | [MX](strategies/MX-address-strategy.md) |
| 英国 GB | Geofabrik OSM | 源值 + Postcodes.io | OSM 住宅建筑 | [GB](strategies/GB-address-strategy.md) |
| 德国 DE | Overture | 源字段 + catalog；OpenPLZ 仅辅助 | 明确住宅建筑/用途 | [DE](strategies/DE-address-strategy.md) |
| 法国 FR | Overture | 源字段 + catalog；5 位邮编 | 明确住宅建筑/用途 | [FR](strategies/FR-address-strategy.md) |
| 意大利 IT | Overture | 源字段 + catalog；5 位 CAP | 明确住宅建筑/用途 | [IT](strategies/IT-address-strategy.md) |
| 西班牙 ES | Overture | 源字段 + catalog；5 位邮编 | 明确住宅建筑/用途 | [ES](strategies/ES-address-strategy.md) |
| 荷兰 NL | Overture | 源字段 + catalog；`1234 AB` | 明确住宅建筑/用途 | [NL](strategies/NL-address-strategy.md) |
| 俄罗斯 RU | Geofabrik OSM | 源字段 + catalog；6 位邮编 | OSM 住宅建筑 | [RU](strategies/RU-address-strategy.md) |
| 中国 CN | AreaCity + 高德/百度/腾讯；旧 OSM 中国池退出发布 | AreaCity + 民政部版本对照；6 位源邮编 | 至少两平台一致 | [CN](strategies/CN-China-address-generation.md) |
| 中国香港 HK | Geofabrik OSM | 源字段 + catalog；无通用邮编 | OSM 住宅建筑 | [HK](strategies/HK-address-strategy.md) |
| 中国台湾 TW | Overture | 源字段 + catalog；TGOS 暂停 | 明确住宅建筑/用途 | [TW](strategies/TW-address-strategy.md) |
| 日本 JP | Overture；ABR/Geolonia 为候选 | 源字段 + catalog；7 位邮编 | 明确住宅建筑/用途 | [JP](strategies/JP-address-strategy.md) |
| 韩国 KR | Geofabrik OSM | 源字段 + catalog；Juso 暂停 | OSM 住宅建筑 | [KR](strategies/KR-address-strategy.md) |
| 新加坡 SG | Geofabrik OSM；OneMap 辅助 | OneMap/源 6 位邮编 | OSM 住宅建筑 | [SG](strategies/SG-address-strategy.md) |
| 马来西亚 MY | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [MY](strategies/MY-address-strategy.md) |
| 泰国 TH | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [TH](strategies/TH-address-strategy.md) |
| 菲律宾 PH | Geofabrik OSM | 源字段 + catalog；4 位邮编 | OSM 住宅建筑 | [PH](strategies/PH-address-strategy.md) |
| 越南 VN | Geofabrik OSM | 源字段 + catalog；5–6 位源值 | OSM 住宅建筑 | [VN](strategies/VN-address-strategy.md) |
| 土耳其 TR | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [TR](strategies/TR-address-strategy.md) |
| 沙特阿拉伯 SA | Geofabrik OSM | 源字段 + catalog；源邮编 | OSM 住宅建筑 | [SA](strategies/SA-address-strategy.md) |
| 印度 IN | Geofabrik OSM | 源字段 + catalog；6 位 PIN | OSM 住宅建筑 | [IN](strategies/IN-address-strategy.md) |
| 澳大利亚 AU | Overture | 源字段 + catalog；4 位邮编 | 明确住宅建筑/用途 | [AU](strategies/AU-address-strategy.md) |
| 巴西 BR | Geofabrik OSM | 源字段 + catalog；CEP | OSM 住宅建筑 | [BR](strategies/BR-address-strategy.md) |
| 尼日利亚 NG | Geofabrik OSM | 源字段 + catalog；6 位源值 | OSM 住宅建筑 | [NG](strategies/NG-address-strategy.md) |
| 南非 ZA | Geofabrik OSM | 源字段 + catalog；4 位邮编 | OSM 住宅建筑 | [ZA](strategies/ZA-address-strategy.md) |

OpenAddresses 只用于发现可用上游；每个上游需单独核验许可和质量。libpostal 只用于解析/规范化，不证明地址真实或属于住宅。

## 3. 本地探测结论

| 来源/API | 2026-07-28 结果 | 决策 |
|---|---|---|
| Overture STAC | HTTP 200，Catalog 和 `latest` 可解析 | 批量主源；每国仍执行 E3 |
| Geofabrik index | HTTP 200，分片索引可解析 | 批量主源；每个 PBF 独立校验 |
| AreaCity / 民政部版本页 | 均可访问 | 中国行政区主源/版本对照，不提供住宅 |
| Geolonia Japanese Addresses v2 | HTTP 200，行政字段和坐标可解析 | 日本升级候选；尚缺住宅关联 |
| Postcodes.io | 示例 HTTP 200，邮编/坐标/行政字段完整 | 英国邮编核验，不是物业地址源 |
| OpenPLZ | GitHub 数据可访问；公开 API 探测 404 | 仅离线辅助，不作运行时主源 |
| 高德 WebService | 本地 Key 调用成功，POI 字段可解析 | 中国小区候选 |
| 百度 Place API | 本地 AK 调用成功，地点字段可解析 | 中国小区候选 |
| 腾讯 Place API | HTTP 200，`status=121` | 当日额度耗尽，暂停至下一周期 |
| OneMap Search | 3 个脱敏邮编均 HTTP 200 且一致 | 新加坡地址/邮编/坐标辅助，不赋予住宅证据 |
| Geoapify | HTTP 2xx，schema 可解析 | 地址/邮编辅助，不赋予住宅证据 |
| 韩国 Juso/data.go.kr | 申请依赖当前缺少的账户条件 | 暂停；使用 OSM 严格门禁 |
| 台湾 TGOS | 本地访问不稳定 | 暂停；使用 Overture 严格门禁 |

探测成功只表示接口和 schema 可用；生产同步仍须抽样、边界、邮编、去重和住宅证据门禁。

## 4. API 与免费额度

| 平台 | 申请入口 | 免费/初始额度基线 | 项目配置 |
|---|---|---|---|
| 高德 WebService | <https://console.amap.com/dev/index> | 个人 5,000/月；以控制台为准 | `AMAP_API_KEY` 或后台多个 Key |
| 高德 JS API | <https://console.amap.com/dev/index> | 以控制台为准 | 独立 `AMAP_JS_API_KEY` + `AMAP_JS_SECURITY_CODE` |
| 百度 Place API | <https://lbsyun.baidu.com/apiconsole/key> | 个人常见 100/日、3 QPS；以认证档位为准 | `BAIDU_API_KEY` 或后台多个 AK |
| 腾讯 WebService | <https://lbs.qq.com/dev/console/application/mine> | 初始档 10,000/日、5 QPS | `TENCENT_API_KEY` 或后台多个 Key |
| OneMap | <https://www.onemap.gov.sg/apidocs/> | 未找到统一公开日额度；Token 通常短期有效 | `ONEMAP_ACCESS_TOKEN` |
| Geoapify | <https://www.geoapify.com/pricing> | 免费计划 3,000 credits/日、最多 5 req/s | `GEOAPIFY_API_KEY` |

系统按每个 Key 的官方周期计数：日额度按自然日、月额度按自然月，每个 Key 默认独立；仅在管理员明确配置同一额度组时共享。腾讯返回 `X-Limit` 时使用平台实时值，高德和百度使用本地统计并由超限错误校正。后台显示已用、上限、剩余、来源和重置时间；出现 429、QPS、日/月额度错误或 Token 过期时自动冷却或暂停，并在周期边界恢复。

## 5. 密钥安全

- 真实值只保存在被 Git 忽略的本地 `.env`、VPS 权限 `600` 的运行配置或 `control.sqlite` AES-256-GCM 密文中。
- WebService Key、Security Code、Token、主密钥不进入前端 bundle、公开 API、日志、审计详情、文档或 Git。
- 高德 JS API Key 按浏览器机制会出现在网络请求中，因此必须使用**独立 Key**并设置正式域名白名单；它不得复用同步 Key。
- `AMAP_JS_SECURITY_CODE` 仅由同源 `/_AMapService` 固定上游代理使用；代理有会话检查、Origin/Referer 校验、路径白名单、无缓存、响应过滤和每 IP 限速。

## 6. 自动同步

1. 最多 10 个国家并行发现、下载和准备；重型解析默认 3 路（可设 1–4），SQLite 固定单写入发布。
2. 下载/调用上游到服务器 staging；相同 URL 与版本的原始包只下载一次，本地只做小型脱敏测试。
3. 解析并分离 `buildingName` 与 `unit`，执行全半角、大小写、空白和标准邮编分隔符等确定性规范化。
4. 按国家策略检查所有必填项、邮编格式、国家边界、行政层级、住宅用途和来源许可；任一失败即记录拒绝原因并淘汰。
5. 候选按住宅证据、质量分和稳定哈希排序，再应用国家及行政层级目标；节点可覆盖继承上限。
6. 在影子表完成质量统计；全部门禁通过后原子切换 active 快照，再删除 retired 证据、数据集和孤立地址。
7. 只比较最新候选与当前 active 快照；候选不足显示缺口，不放宽门禁。行政区划和邮编目录不受地址数量限制。
8. 读取层再次执行同一规则，旧库脏记录立即停止返回；同步失败保留上一份已通过相同门禁的快照。
9. 按月检查批量源；中国行政区跟随 AreaCity 版本，小区按免费额度增量同步。高德只按 `types=120302` 查询，原始结果非空但全部被过滤时标记 `adapter_rejected_all`，不写成地区已耗尽。

VPS 生产数据只保存在 `/root/address/data/`，代码部署必须排除数据库、WAL/SHM、日志、缓存、原始响应和所有密钥。旧数据只在新快照达到覆盖门槛后退役；清理生产旧数据的临时脚本不提交仓库。

## 7. 主要参考

- Overture: <https://docs.overturemaps.org/guides/addresses/>
- Geofabrik: <https://download.geofabrik.de/>
- AreaCity: <https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov>
- 民政部区划版本: <https://dmfw.mca.gov.cn/XzqhVersionPublish.html>
- 高德 JS 安全密钥: <https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode>
- Postcodes.io: <https://postcodes.io/>
- Geolonia Japanese Addresses v2: <https://github.com/geolonia/japanese-addresses-v2>
- OpenAddresses: <https://github.com/openaddresses/openaddresses>
- libpostal: <https://github.com/openvenues/libpostal>
