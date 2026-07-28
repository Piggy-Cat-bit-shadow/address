<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="Address Logo" />
</p>

<h1 align="center">Address</h1>

<p align="center">面向 27 個國家和地區的自託管真實住宅地址與合成測試資料生成器</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">簡體中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/daimon3332/address/releases"><img src="https://img.shields.io/github/v/release/daimon3332/address" alt="Release" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/Live_Demo-address.333186.xyz-0f766e" alt="在線演示" /></a>
</p>

Address 只發佈同時具備地址存在證據與獨立住宅用途證據的記錄。包括室內層級在內的地址字段均不編造，缺失值保持為空；同時提供原文、英文、簡體中文地址和適合表單與軟件測試的合成資料。

> 生成結果屬於測試資料，不代表地址可投遞、真實居住、身份、支付賬戶有效性或所有權關係。

## 🚀 使用流程

選擇國家和地區 → 生成通過證據門禁的真實住宅地址與測試資料 → 複製單項字段或導出結果。

## ✨ 核心功能

- 覆蓋 27 個國家和地區，支持州省、城市和郵編篩選。
- 地區篩選嚴格匹配；所選地區無合格記錄時返回 `NO_POOL_COVERAGE`，不會替換成其他地區。
- IP 地區生成只接受座標或城市匹配，不會替換成州省或全國記錄。
- 地址提供原文、英文和簡體中文三種表示。
- 所有地址組件均來自來源；門牌、樓棟、單元、樓層、房間或郵編缺失時保持為空。
- 同時生成基本資料、沙盒銀行卡、工作、財務、網絡與擴展信息。
- 中國與其他國家可分別啟用 Google、高德地圖預覽，也可以全部關閉。
- 自定義黑名單熱加載，並保留證據與來源署名。
- 首次導入支持斷點續跑，日常輪轉包含質量和容量門禁。

## 🧭 地址來源與字段真實性

active 地址池按下表使用對應來源。每條公開結果都必須通過地址存在性和住宅用途門禁；實時服務僅作為可選輸入，其候選記錄也執行相同門禁。

**質量高於數量：** [地址格式](docs/address-formats.md)規定的國家必填組件缺少任意一項，整條記錄直接淘汰；表中的「保持為空」只適用於建築名、來源單元等明確標記為可選的字段。系統不使用附近郵編、鄰近地址或隨機值補齊事實字段。

| 國家/地區 | 默認來源 | 真實/來源地址字段 | 生成地址字段 |
|---|---|---|---|
| 美國（US） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、州、ZIP、來源幾何座標 | 無；缺失欄位保持為空 |
| 加拿大（CA） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 墨西哥（MX） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、市鎮、州、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 英國（GB） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城鎮、Postcode、來源幾何座標 | 無；缺失欄位保持為空 |
| 德國（DE） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 法國（FR） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 意大利（IT） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、大區、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 西班牙（ES） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 荷蘭（NL） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 俄羅斯（RU） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、聯邦主體、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 中國（CN） | [AreaCity](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov) + 高德/百度/騰訊 POI | 省/直轄市、城市、區縣、鄉鎮街道、地圖登記小區名和地址、平台座標 | 無；缺失欄位保持為空 |
| 中國香港（HK） | [Geofabrik OSM](https://download.geofabrik.de/) | 大廈/道路、分區、地區、來源幾何座標 | 無；缺失欄位保持為空 |
| 中國臺灣（TW） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、縣市、區、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 日本（JP） | [Overture Maps](https://overturemaps.org/) | 番地、道路、自治體、都道府縣、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 韓國（KR） | [Geofabrik OSM](https://download.geofabrik.de/) | 道路、建築號、區、市/道、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 新加坡（SG） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、地區、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 越南（VN） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、區、城市、省、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 泰國（TH） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 菲律賓（PH） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、描籠涯/區、城市、大區、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 馬來西亞（MY） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、縣/區、城市、州、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 印度（IN） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、縣區、城市、州、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 澳大利亞（AU） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、郊區、州、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 土耳其（TR） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 沙特阿拉伯（SA） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 巴西（BR） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、州、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 尼日利亞（NG） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、州、郵編、來源幾何座標 | 無；缺失欄位保持為空 |
| 南非（ZA） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、郊區、郵編、來源幾何座標 | 無；缺失欄位保持為空 |

「無」表示生成器不合成任何地址組件。必填地址字段缺失時整條記錄不進入隨機池；可選建築名或來源單元缺失時保持為空。

### 地址來源與合成測試資料

| 字段 | 來源說明 |
|---|---|
| 國家、地區、城市、區縣和道路 | 來自同一地址記錄或精確行政關係並經過規範化；衝突記錄不發佈。 |
| 門牌號 | 只保留來源或地圖登記值；缺失時整條記錄淘汰。 |
| 郵編 | 除中國 POI 和香港外均為必填；只保留有效來源值或權威精確關聯值，缺失或格式錯誤時整條記錄淘汰。 |
| 座標 | 複製來源幾何位置，可能是地址點、建築點或 OSM 道路/建築 way 的幾何中心。 |
| 建築或小區 | 只使用與地址對象關聯的來源值。中國小區至少需要兩個獨立地圖平台一致後才發佈。 |
| 公寓、樓棟、單元、樓層和房間 | 只保留正式或來源標記值；所有國家的缺失室內字段均保持為空。 |
| 姓名、電話、郵箱、工作、財務、網絡和沙盒銀行卡 | 合成測試資料。 |

中國使用**經 AreaCity 校驗的行政區，以及通過多平台一致性檢查的地圖平台小區、登記地址和座標**。其他國家將來源地址對象與獨立住宅建築或用途證據關聯。`verified` 表示來源證據和質量門禁通過，不代表當前有人居住或可以投遞。

### Google 地圖與高德地圖說明

- **Google 座標預覽**直接打開來源幾何位置的 `latitude,longitude`，這是位置預覽，不是 Google 對投遞或居住狀態的證明。
- **Google 地址搜索**只使用來源支持的地址組件；缺失的室內字段直接省略。
- **中國高德地圖**在放置標記前把來源 WGS-84 座標轉換為 GCJ-02；高德國外地圖保留來源座標，並要求賬號已開通世界地圖能力。
- Google 與高德分別提供中國/國外開關，默認均為 Google 開啟、高德關閉；一個平台的開關不會改變另一個平台。
- 地圖點可能是地址點、建築中心或 way 的幾何中心，不保證是入口或具體房間。默認生成流程也不宣稱每條記錄都經過 Google Geocoding 獨立認證。

高德使用三個彼此分離的值：僅伺服端使用的 `AMAP_API_KEY` 是中國 POI 同步所用 WebService 憑據；受域名白名單限制的 `AMAP_JS_API_KEY` 是專用瀏覽器載入 Key，啟用高德時會出現在瀏覽器網路請求中；`AMAP_JS_SECURITY_CODE` 僅在伺服器以 AES-GCM 加密保存，並只由同源 `/_AMapService` 代理使用。高德官方推薦[代理模式](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)；國外地圖還需要單獨申請[世界地圖權限](https://lbs.amap.com/api/javascript-api-v2/guide/map/world-map)。倉庫示例中的憑據值全部是占位符，受追蹤檔案中不包含真實 Key 或 Token。

字段示例和來源細節請參閱[地址格式](docs/address-formats.md)、[數據來源](docs/data-sources.md)和 [API 文檔](docs/API.zh-TW.md)。

## 🖼️ Webui Preview (Webui 預覽)

<details>
<summary>展開查看美國與中國完整 WebUI 預覽</summary>

<br />

<table>
  <tr>
    <th width="50%">美國</th>
    <th width="50%">中國</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="美國 WebUI 總覽" /></td>
    <td><img src="image/webui-cn-overview.png" alt="中國 WebUI 總覽" /></td>
  </tr>
  <tr>
    <th>生成器</th>
    <th>生成器</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-generator.png" alt="美國地址生成器" /></td>
    <td><img src="image/webui-cn-generator.png" alt="中國地址生成器" /></td>
  </tr>
  <tr>
    <th>地址</th>
    <th>地址</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-address.png" alt="美國地址結果" /></td>
    <td><img src="image/webui-cn-address.png" alt="中國地址結果" /></td>
  </tr>
  <tr>
    <th>基本資料</th>
    <th>基本資料</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-profile.png" alt="美國基本測試資料" /></td>
    <td><img src="image/webui-cn-profile.png" alt="中國基本測試資料" /></td>
  </tr>
  <tr>
    <th>銀行卡測試資料</th>
    <th>銀行卡測試資料</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-test-card.png" alt="美國銀行卡測試資料" /></td>
    <td><img src="image/webui-cn-test-card.png" alt="中國銀行卡測試資料" /></td>
  </tr>
  <tr>
    <th>工作信息</th>
    <th>工作信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-employment.png" alt="美國工作信息" /></td>
    <td><img src="image/webui-cn-employment.png" alt="中國工作信息" /></td>
  </tr>
  <tr>
    <th>財務信息</th>
    <th>財務信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-finance.png" alt="美國財務信息" /></td>
    <td><img src="image/webui-cn-finance.png" alt="中國財務信息" /></td>
  </tr>
  <tr>
    <th>網絡與擴展信息</th>
    <th>網絡與擴展信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-network.png" alt="美國網絡與擴展信息" /></td>
    <td><img src="image/webui-cn-network.png" alt="中國網絡與擴展信息" /></td>
  </tr>
  <tr>
    <th>Google 地圖</th>
    <th>Google 地圖</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-map.png" alt="美國 Google 地圖預覽" /></td>
    <td><img src="image/webui-cn-map.png" alt="中國 Google 地圖預覽" /></td>
  </tr>
</table>

</details>

## 📚 項目文檔

| 文檔 | 內容 |
|---|---|
| [API 文檔](docs/API.zh-TW.md) | 公開端點、參數、錯誤、同步管理、CORS 與示例 |
| [部署文檔](docs/DEPLOYMENT.zh-TW.md) | API Key、私密配置、VPS、Nginx、同步、備份與容量 |
| [二次開發文檔](docs/DEVELOPMENT.zh-TW.md) | 架構、本地環境、數據管線、擴展點、測試與發佈門禁 |

## ⚡ 快速開始

要求 Node.js 24 或更新版本。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

新數據庫只有表結構。執行 `npm run data:address-pool:bootstrap` 可開始支持斷點續跑的 27 國導入。生產 VPS 部署前請閱讀[部署文檔](docs/DEPLOYMENT.zh-TW.md)。

## 🔑 配置摘要

小區同步完成後，日常生成只查詢伺服器 SQLite，不調用地圖平台。在 `/admin/` 中配置多個高德、百度和騰訊伺服器端 Key；它們使用伺服器專有的 `CONFIG_MASTER_KEY` 加密保存到 `control.sqlite`。高德地圖渲染另用受域名限制的 JS API Key，配套安全密鑰僅由 `/_AMapService` 伺服器端代理使用。所有真實憑據只寫入被忽略的本地/運行配置或後台密文存儲，不進入源碼、截圖、Issue 或 CI 日誌。

## 💾 數據庫大小

以下數據於 2026-07-23、提交 `084805e`、27 國同步完成後實測：

| 內容 | 實測值 |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| 完整 `data/` 目錄 | 7.89 GiB |
| 首次導入峰值 | 約 11.2 GiB |

實際大小會隨上游版本和 WAL 活躍度變化。生產環境建議應用卷至少預留 **60 GiB**，用於同步、備份和恢復空間。

## 🌍 支持範圍

美國、加拿大、墨西哥、英國、德國、法國、意大利、西班牙、荷蘭、俄羅斯、中國、香港、臺灣、日本、韓國、新加坡、越南、泰國、菲律賓、馬來西亞、印度、澳大利亞、土耳其、沙特阿拉伯、巴西、尼日利亞和南非。

## 數據、隱私與許可

- [Overture Maps](https://overturemaps.org/) 提供部分地址記錄，並保留具體來源元數據與條款。
- [OpenStreetMap](https://www.openstreetmap.org/copyright) 和 [Geofabrik](https://download.geofabrik.de/) 根據 ODbL 1.0 提供其他源數據。
- 客戶端 IP 只用於用戶請求的定位查詢，不寫入地址數據庫。
- 地址與室內字段均來自來源，缺失值保持為空；人物資料和銀行卡字段屬於合成測試數據。

項目代碼使用 [MIT License](LICENSE)。重新分發的數據仍遵循對應來源的許可、署名和相同方式共享要求。倉庫與 Release 不包含生產數據庫或私密憑據。

## 社區

- [linux.do](https://linux.do)：**學AI，上L站！！！**
- [Nodeseek.com](https://www.nodeseek.com)：**Nodeseek是一個為熱愛web開發、託管、vps /伺服器和其他極客事物的人提供的地方。**
