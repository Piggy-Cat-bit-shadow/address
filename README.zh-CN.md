<p align="center"><img src="public/favicon.svg" width="88" height="88" alt="Address Logo" /></p>
<h1 align="center">Address</h1>
<p align="center">基于 PostgreSQL 的自托管住宅地址与合成测试资料生成器</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/在线演示-address.333186.xyz-1769e0" alt="在线演示" /></a>
</p>

**常规部署完成后，应用程序与 PostgreSQL 地址数据库大约占用 5 GB 硬盘空间；同步运行期间需要额外的临时空间。**

## 核心功能

- 配置 27 个国家和地区，并按国家实际行政结构提供州省、城市、区县和邮编筛选。
- 严格筛选：所选范围没有合格记录时返回错误，不会悄悄切换到其他地区。
- 从当前筛选范围的全部合格地址中快速随机选择，不会反复读取数据库前几条。
- 支持原文、英文、简体中文、繁体中文、日语、韩语、德语、法语、西班牙语和葡萄牙语展示路径。
- 地址语言和资料语言分别记忆；浏览器首次打开默认 English，生成和切换国家不会重置选择。
- 每个国家可配置热门行政区、热门城市和特殊区域；美国包含无州级销售税州。
- 提供公开覆盖监控，以及管理员仪表盘、地址数据规则、同步队列、快捷区域、平台凭据、访问控制、黑名单和 API Token 页面。
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

队列包含有限重试、指数退避、额度/冷却恢复时间、无增长锁存和连续失败暂停机制，因此不会对同一个没有变化的数据源无限循环。中国在仍具备同步条件时拥有最高自动优先级。

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

## 快速开始

需要 Node.js 24+、Docker Compose，以及足够容纳所选数据源的磁盘空间。

```bash
git clone https://github.com/daimon3332/address.git
cd address

cd ops/postgresql
POSTGRES_PASSWORD='REPLACE_WITH_A_STRONG_PASSWORD' docker compose up -d
cd ../..

cp .env.example .env
# 在 .env 中设置 POSTGRES_URL、CONFIG_MASTER_KEY、ADMIN_BOOTSTRAP_PASSWORD。
npm ci
npm run db:migrate
npm run build
npm start
```

新数据库只有表结构。导入数据前应先检查对应国家的许可、资源需求和策略文档。生产部署、进程监督、反向代理、备份与恢复见[部署文档](docs/DEPLOYMENT.zh-CN.md)。

## 配置与 API Key

- 复制 `.env.example`，绝不提交 `.env`。
- 平台密钥默认可选；只有所选同步策略需要时才必须配置。
- 多个 Key 独立轮换。当前 Key 失败时先冷却并尝试其他 Key；全部不可用时等待最早恢复时间。
- 后台加密凭据依赖稳定的 `CONFIG_MASTER_KEY`。
- 各平台申请入口、变量名、限制和轮换规则见独立的 [API Key 配置文档](docs/API_KEYS.zh-CN.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [API 文档](docs/API.zh-CN.md) | Bearer 鉴权、生成、筛选、错误和监控 |
| [API Key](docs/API_KEYS.zh-CN.md) | 平台申请、环境变量、加密、轮换和冷却 |
| [部署文档](docs/DEPLOYMENT.zh-CN.md) | PostgreSQL、VPS 目录、进程、Nginx、备份、恢复和升级 |
| [开发文档](docs/DEVELOPMENT.zh-CN.md) | 架构、本地检查、扩展点和发布门禁 |
| [地址格式](docs/address-formats.md) | 各国格式与字段行为 |
| [国家策略](docs/strategies/) | 数据源、证据、坐标、去重、验证和更新策略 |

## 许可证

项目源码使用 [MIT](LICENSE)。上游数据集保留各自的许可与署名要求。
