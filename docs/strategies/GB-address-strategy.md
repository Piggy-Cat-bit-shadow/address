# GB 英国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | Geofabrik OpenStreetMap `united-kingdom`（当前批量主源） |
| 格式 / 邮编 | `<flat/building if present>, <house> <street>, <post town>, <postcode>, UK`；Flat 缺失保持空；Postcodes.io/ONS Postcode Directory 用于格式和坐标核验；完整物业地址不由 postcodes.io 生成。只清洗格式，不创造或按邻近地址补齐 |
| 行政区 | ONS 地区/地方政府目录作为候选核验；当前从 OSM 记录并经 catalog 反查。行政层级必须与坐标反查一致；冲突时保留源值在隔离区并拒绝发布 |
| 住宅证据 | OSM `building` 住宅标签或 Overture/建筑证据；仅有邮编绝不视为住宅。住宅证据必须来自明确建筑/用途字段，不能由地址存在推断 |
| 发布门禁 | 仅发布 E3：地址存在与独立住宅用途证据同时成立；字段冲突拒绝合并，缺失字段保持空。 |
| 同步频率 | 每日检查上游分片；新快照通过门禁后原子切换，失败保留上一 active 快照。 |
| 验证 / 排除 | Postcodes.io 本地样本 HTTP 200，返回 postcode、坐标和行政字段；它不是物业级地址库。 暂不采用：Royal Mail PAF/OS AddressBase 不是本项目默认可再分发数据，未接入。 |
| 策略版本 / 状态 / 更新 | 1.0 / 当前主链路 / 2026-07-28 |

统一证据等级、许可、配额与 VPS 边界见 [数据源与自动同步方案](../data-sources.md)。策略变化时同步更新本文件、实现与测试。
