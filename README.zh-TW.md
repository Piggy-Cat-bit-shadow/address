<p align="center"><img src="public/favicon.svg" width="88" height="88" alt="Address Logo" /></p>
<h1 align="center">Address</h1>
<p align="center"><strong>基於 PostgreSQL 的自託管真實住宅位址產生器</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/線上展示-address.333186.xyz-1769e0" alt="線上展示" /></a>
</p>

**一般部署完成後，應用程式與 PostgreSQL 位址資料庫大約占用 5 GB 磁碟空間；同步執行期間需要額外的暫存空間。**

**Address 是真實住宅位址產生器。** 發布池中的住宅基礎位址來自官方開放資料、國家或地區位址登記、地圖登記建築及具有明確住宅用途證據的開放地圖資料，不使用隨機街道、門牌或郵遞區號冒充真實位址。每筆記錄保留來源座標，可用於 Google Maps、高德地圖等覆蓋相應地區的地圖服務定位；具體平台的文字搜尋結果取決於其地區覆蓋、索引名稱與更新時間。

## 核心功能

- 設定 27 個國家和地區，依實際行政結構提供州省、城市、區縣及郵遞區號篩選。
- 嚴格篩選：所選範圍沒有合格記錄時回傳錯誤，不會偷偷切換到其他地區。
- 從目前篩選範圍的全部合格位址快速隨機選擇，不會重複讀取資料庫前幾筆。
- 支援原文、英文、簡體中文、繁體中文、日語、韓語、德語、法語、西班牙語及葡萄牙語展示路徑。
- 位址語言和資料語言分別記憶；瀏覽器首次開啟預設 English，產生和切換國家不會重設選擇。
- 位址收藏保存在瀏覽器中，支援依大洲或國家分組與篩選、拖曳或序號排序、複製、刪除，以及跳轉 Google Maps 或高德地圖。
- 每個國家可設定熱門行政區、熱門城市與特殊區域；美國包含無州級銷售稅州。
- 提供公開覆蓋監控，以及管理員儀表板、位址資料規則、同步佇列與同步歷史、快捷區域、平台憑據、存取控制、黑名單與 API Token 頁面。
- JSON API 提供健康檢查、國家、可用性、地區選項、搜尋、位址/資料產生、批次產生與監控介面，並包含 Python、cURL 與 JavaScript 範例。
- 執行階段完全使用 PostgreSQL，包含連線池、交易發布、地區索引與預先建立的隨機位址索引。

## 支援範圍

| 區域 | 國家和地區 |
|---|---|
| 北美 | US、CA、MX |
| 歐洲 | GB、DE、FR、IT、ES、NL、RU |
| 東亞 | CN、HK、TW、JP、KR |
| 東南亞 | SG、MY、TH、PH、VN |
| 南亞 | IN |
| 大洋洲 | AU |
| 中東 | TR、SA |
| 南美 | BR |
| 非洲 | NG、ZA |

## 真實住宅位址來源與欄位

下表對應目前同步實作。除「中國室內欄位」一項外，產生器不會隨機補造位址元件；由官方目錄唯一匹配取得的郵遞區號或行政區仍屬來源真實欄位。必填欄位缺失、行政區衝突、座標越界或住宅證據不足的記錄不會進入發布池。

| 國家/地區 | 目前位址資料來源 | 位址組成 | 真實/來源欄位 | 合成或補全欄位 | 住宅真實性依據 |
|---|---|---|---|---|---|
| 美國（US） | Overture Maps、Geofabrik OSM 州級分片 | 門牌、道路、城市、州、ZIP、座標 | 全部位址欄位及座標 | 無；僅規範格式 | OSM/Overture 明確住宅建築或用途 |
| 加拿大（CA） | Overture Maps、Geofabrik OSM | 門牌、道路、城市、省、郵遞區號、座標 | 全部位址欄位及座標 | 無；僅規範郵遞區號格式 | 明確住宅建築或用途 |
| 墨西哥（MX） | INEGI 全國位址框架；同源標準化包僅補名稱 | 門牌、道路、住區、市鎮、州、郵遞區號、座標 | INEGI 原始門牌、道路、住區、行政區、郵遞區號及座標 | 州/城市名稱可由同源記錄確定性映射；不產生位址 | INEGI `TIPODOM=VIVIENDA` |
| 英國（GB） | Geofabrik OSM；Postcodes.io/ONS 僅核驗 | 單位/樓宇、門牌、道路、城鎮、郵遞區號、座標 | OSM 中存在的全部位址欄位及座標 | 無；僅規範格式 | OSM/建築資料明確住宅用途 |
| 德國（DE） | Overture Maps、Geofabrik 16 州分片；OpenPLZ 輔助 | 門牌、道路、城市、郵遞區號、座標 | 全部位址欄位及座標 | 無；不補 Wohnung/Etage | 明確住宅建築或用途 |
| 法國（FR） | Overture Maps、Geofabrik 27 區域分片；BAN 僅核驗存在性 | 門牌、道路、補充號、城市、郵遞區號、座標 | 全部位址欄位及座標 | 無；僅規範格式 | 明確住宅建築或用途，BAN 本身不作為住宅證據 |
| 義大利（IT） | Overture Maps、Geofabrik OSM | 門牌、道路、城市、省/大區、CAP、座標 | 全部位址欄位及座標 | 無；不補內部號 | 明確住宅建築或用途 |
| 西班牙（ES） | Overture Maps、Geofabrik OSM | 門牌、道路、市鎮、省、郵遞區號、座標 | 全部位址欄位及座標 | 無；只保留來源樓梯/門號 | 明確住宅建築或用途 |
| 荷蘭（NL） | Kadaster BAG（PDOK）及 Overture Maps | 門牌/字母/附加號、道路、城市、省、郵遞區號、座標 | BAG/來源全部位址欄位及座標 | 無；僅可逆組合門牌格式 | BAG 在用 `woonfunctie` 或 Overture 明確住宅用途 |
| 俄羅斯（RU） | Geofabrik OSM | 門牌、道路、城市、聯邦主體、郵遞區號、座標 | 全部位址欄位及座標 | 無；不補 корпус/квартира | OSM 明確住宅建築 |
| 中國（CN） | AreaCity/StatsGov；高德、百度、騰訊住宅社區 POI | 省、市、區縣、街道/道路門牌、社區、棟/單元/樓層/室、座標 | 行政區、社區名、道路門牌與平台座標 | 僅棟、單元、樓層、室號為合成欄位並標記 `synthetic`；不產生郵遞區號 | 嚴格住宅分類、行政區一致、數字門牌與機構黑名單門禁 |
| 中國香港（HK） | 房委會公屋單位、屋宇署樓宇資料、ALS | 單位/樓層、樓宇、門牌、街道、地點、18 區、地域、座標 | 公屋單位欄位或私人住宅樓宇欄位及座標；無通用郵遞區號 | 無 | 房委會住宅庫存，或屋宇署 `Residential/Composite` Tower |
| 中國臺灣（TW） | 內政部實價登錄、中華郵政 3+3、地方政府門牌點 | 門牌、路街段巷弄、區鄉鎮市、縣市、郵遞區號、座標 | 住宅成交門牌、行政區、唯一精確匹配郵遞區號及座標 | 無；不以鄰近點補全 | 實價登錄住宅主要用途及住宅建築型態 |
| 日本（JP） | 數位廳 ABR/Geolonia、日本郵便、PLATEAU/MLIT、Geofabrik OSM | 都道府縣、市區町村、町域/丁目、街區與住居號或地番、郵遞區號、座標 | ABR 位址欄位、唯一匹配的日本郵便郵遞區號及來源座標 | 無；建築名和室號缺失時留空 | 位址點精確落入 PLATEAU/OSM 住宅建築面 |
| 韓國（KR） | K-apt、Juso/OpenAddresses 歸檔、Geofabrik/Overture | 市/道、市/郡/區、邑面洞、道路、建築號、郵遞區號、座標 | K-apt 地番或 Juso 道路名位址欄位及座標 | 無；不產生棟、單元或室號 | K-apt 官方共同住宅，或 Juso 點與住宅建築相交 |
| 新加坡（SG） | HDB Property Information、Existing Building、OneMap、Geofabrik OSM | 樓棟號、道路、規劃城鎮、6 位郵遞區號、座標 | HDB 樓棟、道路、城鎮；OneMap 唯一匹配的郵遞區號與座標 | 僅依同樓棟和道路唯一匹配補全，不產生門牌 | HDB `residential=Y` 且住宅單位數大於零，或 OSM 住宅建築 |
| 馬來西亞（MY） | Geofabrik OSM 馬來西亞分片 | 單位/地塊、樓宇、道路、縣區、城市、州、郵遞區號、座標 | OSM 中存在的全部位址欄位及座標 | 無；不補單位 | OSM 明確住宅建築並排除商業 POI |
| 泰國（TH） | Geofabrik OSM；DOPA 僅核驗行政區 | 門牌、村、巷、道路、分區、縣區、府、郵遞區號、座標 | OSM 中存在的全部位址欄位及座標 | 無；僅規範格式 | OSM 明確住宅建築 |
| 菲律賓（PH） | Geofabrik OSM、PHLPost；PSA PSGC 僅核驗行政區 | 門牌、道路、Barangay、城市/市鎮、省、郵遞區號、座標 | OSM 位址欄位及座標 | 缺郵遞區號時僅依 PHLPost 省+城市/市鎮唯一匹配補全 | OSM 明確住宅建築 |
| 越南（VN） | Geofabrik OSM；可選越南郵政 Vpostcode 授權 feed（取得許可並完成驗收前預設關閉） | 門牌、道路、坊/社、省級城市/省、郵遞區號、座標 | 來源欄位及座標 | 無；僅接受來源五位郵遞區號 | OSM 明確住宅建築，或授權 feed 的住宅分類 |
| 土耳其（TR） | Geofabrik OSM、伊茲密爾官方 Building Identity | 門牌、道路、區、省、郵遞區號、座標 | 全部來源位址欄位及座標 | 無；僅規範格式 | OSM 住宅標籤或官方 `Konut` 用途 |
| 沙烏地阿拉伯（SA） | 全國位址點保全包、Overture、Geofabrik OSM | 樓宇/門牌、道路、區、城市、郵遞區號、座標 | 全國位址點的位址欄位及座標 | 無；僅規範格式 | 位址點與明確住宅建築面精確關聯 |
| 印度（IN） | Geofabrik OSM；可選 Mappls Nearby + Place Details（取得許可並完成驗收前預設關閉） | 門牌、道路/地點、縣區、城市、邦、PIN、座標 | 來源欄位及座標 | 無；不補公寓或樓層 | OSM 明確住宅建築，或合約授權的 Mappls 住宅分類 |
| 澳洲（AU） | Overture Maps、Geofabrik OSM | 單位、門牌、道路、郊區、州、郵遞區號、座標 | 全部來源位址欄位及座標 | 無；不補單位 | 明確住宅建築或用途；位址存在本身不作為住宅證據 |
| 巴西（BR） | Geofabrik OSM | 門牌、道路、街區、城市、州、CEP、座標 | OSM 中存在的全部位址欄位及座標 | 無；不補 complemento | OSM 明確住宅建築 |
| 奈及利亞（NG） | 預設無可發布來源；可選 NIPOST 或 ProgIS 授權 feed（取得許可並完成驗收前預設關閉） | 門牌、道路、地區、城市、州、郵遞區號、座標 | 授權來源欄位及座標 | 無；不推算缺失欄位 | 逐條或合約級住宅分類；未授權或未驗收時不發布 |
| 南非（ZA） | eThekwini 官方位址與分區、Cape Town 官方地塊、Geofabrik OSM、SAPO | 單位、門牌、道路、郊區、城市、郵遞區號、座標 | 官方位址/地塊欄位、OSM 補充欄位、SAPO 唯一匹配郵遞區號及座標 | 無；不補單位 | 官方住宅 zoning 精確關聯，或 OSM 明確住宅建築 |

更詳細的資料源版本、座標系、去重與發布門禁見[資料源文件](docs/data-sources.md)及[各國家/地區策略](docs/strategies/)。

## 介面截圖

<table>
  <tr><th>美國產生介面</th><th>中國產生介面</th></tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="美國產生介面" /></td>
    <td><img src="image/webui-cn-overview.png" alt="中國產生介面" /></td>
  </tr>
</table>

### 資料監控

<img src="image/webui-monitor.png" alt="公開位址數量與行政區覆蓋監控" />

### 管理員介面

<table>
  <tr><th>儀表板</th><th>位址資料</th></tr>
  <tr>
    <td><img src="image/admin-dashboard.png" alt="管理員儀表板" /></td>
    <td><img src="image/admin-address-data.png" alt="位址資料管理" /></td>
  </tr>
  <tr><th>同步佇列</th><th>快捷區域</th></tr>
  <tr>
    <td><img src="image/admin-sync-queue.png" alt="同步佇列與完成規則" /></td>
    <td><img src="image/admin-quick-locations.png" alt="附可用位址數量的快捷區域搜尋" /></td>
  </tr>
</table>

<img src="image/admin-map-keys.png" alt="已完整遮罩的地圖金鑰與額度管理" />

## 架構

```text
Astro 靜態頁面 + React 介面
             │
             ▼
       Hono Node.js API
        ├─ PostgreSQL 位址與控制資料
        ├─ 從 PostgreSQL 建立的隨機/篩選記憶體索引
        └─ 本地格式化、資料產生與選用翻譯

同步監督程序
        ├─ 可續跑的批次/API 適配器
        ├─ 依國家執行驗證與住宅證據門禁
        ├─ PostgreSQL 交易發布
        └─ 覆蓋統計與有界同步佇列
```

## 全自動同步規則

一個國家只有在所有已啟用規則都符合時才算完成：

1. 合格位址總量達到目標；
2. 最低行政層覆蓋率和每節點最低數量達標；
3. 已設定的一級、二級行政區最低數量達標；
4. 所有單節點覆蓋目標達標。

只達到國家總量不能標記完成。若資料源已被證明耗盡，該國家仍顯示未完成，但不會重複進入執行佇列；只有來源或版本指紋變更後才重新評估。

佇列包含有限重試、指數退避、額度/冷卻恢復時間、可續跑 checkpoint、無增長鎖存及連續失敗暫停，因此不會對同一個沒有變化的資料源無限循環。同步歷史記錄每個來源、耗時、結果與位址增量，過期同步產物由系統自動清理。中國在仍具備同步條件時擁有最高自動優先權。

## 部署

```bash
git clone https://github.com/daimon3332/address.git
cd address
sh ops/init-compose.sh
docker compose up -d
```

完整說明見[部署文件](docs/DEPLOYMENT.zh-TW.md)。

## 設定與 API Key

- 前端密碼、管理員密碼、API Token、平台金鑰、額度與快捷區域均在管理員後台設定。
- 平台金鑰預設為選用；只有選定同步策略需要時才必須設定。
- 多個 Key 獨立輪換。目前 Key 失敗時先冷卻並嘗試其他 Key；全部不可用時等待最早恢復時間。
- 各平台申請入口、變數名稱、限制與輪換規則見獨立的 [API Key 設定文件](docs/API_KEYS.zh-TW.md)。

## 文件

| 文件 | 內容 |
|---|---|
| [API 文件](docs/API.zh-TW.md) | Bearer 驗證、產生、篩選、錯誤與監控 |
| [API Key](docs/API_KEYS.zh-TW.md) | 平台申請、環境變數、加密、輪換與冷卻 |
| [部署文件](docs/DEPLOYMENT.zh-TW.md) | PostgreSQL、VPS 目錄、程序、Nginx、備份、還原與升級 |
| [開發文件](docs/DEVELOPMENT.zh-TW.md) | 架構、本地檢查、擴充點與發布門禁 |
| [位址格式](docs/address-formats.md) | 各國格式與欄位行為 |
| [國家策略](docs/strategies/) | 資料源、證據、座標、去重、驗證與更新策略 |

## 授權

專案原始碼使用 [MIT](LICENSE)。上游資料集保留各自的授權與署名要求。
