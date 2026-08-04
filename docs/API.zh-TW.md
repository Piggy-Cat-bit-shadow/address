# Address API 文檔

[English](API.md) · [簡體中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

外部 API 位於 `/api/v1` 並返回 JSON。服務啟動後，可在 `/en/api/` 或 `/zh-CN/api/` 查看互動參數說明。

## 基礎地址

```text
https://YOUR_DOMAIN.example/api/v1
```

本地開發默認使用 `http://127.0.0.1:8787/api/v1`。

除 `/api/v1/health`、`/api/v1/ready` 和 `/api/v1/openapi.json` 外，外部 API 請求需要管理員創建的 Bearer Token：

```http
Authorization: Bearer YOUR_API_TOKEN
```

Token 在 `/admin/` 建立，同時保存不可逆驗證雜湊和由服務端主密鑰加密的密文，可設定權限、限速和到期時間，也可在管理員工作階段中查看、修改或撤銷。WebUI 使用獨立的 `/web-api/v1` 工作階段通道，不嵌入該 Token。驗證失敗返回 `401`；超過令牌每分鐘限速返回 `429` 和 `Retry-After: 60`。

## 外部端點

| 方法 | 路徑 | 用途 |
|---|---|---|
| `GET` | `/health` | API 基礎健康檢查 |
| `GET` | `/ready` | PostgreSQL 就緒檢查 |
| `GET` | `/openapi.json` | OpenAPI 3.1 契約 |
| `GET` | `/countries` | 國家註冊表、同步數量和嚴格住宅覆蓋 |
| `GET` | `/availability` | 所有已設定國家的公開生成可用性 |
| `GET` | `/client-context` | 將請求 IP 或指定 IP 解析到支持地區 |
| `GET` | `/locations/search` | 搜索州省、城市和郵編選項 |
| `GET` | `/locations/hierarchy` | 按上下級關係瀏覽行政區和郵編選項 |
| `GET` | `/generate` | 生成通過證據門禁的真實住宅地址和相關測試資料 |
| `POST` | `/generate/batch` | 使用結構化篩選和唯一性控制批量生成最多 50 個地址 |
| `GET` | `/addresses/{id}` | 按生成結果 ID 查詢目前發布地址 |
| `GET` | `/coverage` | 查詢國家同步的三項完成規則 |
| `POST` | `/address-translation` | 將已生成地址翻譯為支持的顯示語言 |
| `GET` | `/data-health` | 檢查地址池覆蓋和就緒狀態 |

## 健康檢查

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/health
```

```json
{"status":"ok"}
```

## 國家註冊表

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/countries
```

響應格式為 `{ "data": [...] }`。每個國家包含代碼、本地化名稱、支持的篩選條件、同步總量、真實住宅數量、住宅覆蓋狀態和 `generationMode`。公開生成只使用真實住宅池；同步總量僅用於遷移和健康報告。未連接數據庫時，數量為 `null`。

## 生成可用性

```bash
curl -fsS -H "Authorization: Bearer YOUR_API_TOKEN" \
  https://YOUR_DOMAIN.example/api/v1/availability
```

響應說明每個已設定國家目前是否存在通過發布門檻、可用於生成的住宅記錄。

## 客戶端地區

解析當前請求：

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/client-context
```

解析指定 IPv4 或 IPv6：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/client-context?ip=8.8.8.8"
```

響應可能包含 `publicIp`、國家、州省、城市、郵編、緯度和經度。只有受控反向代理會覆蓋轉發 IP 請求頭時，才配置 `TRUST_PROXY=true`。

## 地區搜索

| 參數 | 默認值 | 說明 |
|---|---|---|
| `country` | `US` | 項目支持的國家代碼 |
| `field` | `city` | `region`、`city`、`district` 或 `postcode` |
| `q` | 空 | 搜索文本 |
| `region` | 空 | 上級州省文本 |
| `regionId` | 空 | 穩定州省 ID |
| `cityId` | 空 | 穩定城市 ID |
| `residential` | `false`（目錄兼容） | 傳入 `true` 時只列出具備真實住宅覆蓋的選項；`/generate` 始終使用住宅記錄 |
| `cursor` | 空 | 上一頁返回的分頁游標 |
| `limit` | `100` | 請求頁大小，範圍為 `20` 至 `200` |

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/locations/search?country=CN&field=city&q=南京"
```

響應包含 `regions`、`cities`、`postcodes` 和 `matches`。連接地區目錄數據庫後，還會提供 `total`、`nextCursor` 和 `source`。

## 地址與資料生成

| 參數 | 默認值 | 說明 |
|---|---|---|
| `country` | `US` | 國家代碼；IP 模式成功解析國家時忽略 |
| `mode` | `residential` | 使用 `ip-region` 開啟 IP 座標或城市匹配 |
| `ip` | 請求 IP | `mode=ip-region` 時使用的指定 IP |
| `residential` | `true` | 舊客戶端兼容參數；`true`、`false` 均可傳入，但公開生成始終執行住宅證據門禁 |
| `region`、`city`、`district`、`postcode` | 空 | 可讀地區篩選 |
| `regionId`、`cityId`、`districtId`、`postcodeId` | 空 | 穩定目錄 ID |
| `q` | 空 | 自由文本地區提示 |
| `strategy` | `random` | 用 `random` 或 `instant` 選擇合格真實記錄，不合成地址字段 |
| `seed` | 自動 UUID | 確定性生成種子 |
| `requestId` | 自動 UUID | 調用方關聯 ID |

美國真實住宅地址：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US"
```

中國城市篩選：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN&city=南京"
```

IP 地區生成：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?mode=ip-region&ip=8.8.8.8"
```

響應外層為 `{ "data": { ... } }`。生成數據包含請求 ID、模式、國家、篩選、精確 `filterMatchLevel` 或 IP `ipMatchLevel`、嘗試的數據源和耗時；普通生成還返回 `eligibleCount`，表示當前精確篩選範圍內通過發布門禁的數據庫記錄數。地址三語變體與室內字段均來自來源，缺失值保持為空；人物資料、沙盒銀行卡、工作、財務和網絡字段仍為合成測試數據。地區篩選嚴格匹配，IP 模式只接受座標或城市匹配。

普通請求從當前篩選範圍的完整合格數據庫候選集中選擇，不使用固定候選窗口或固定順序。需要穩定復現合格記錄選擇與測試資料時傳入 `seed`；未傳入時服務器為每次請求生成新 UUID。該參數不會生成缺失的地址組件，地址源同步後底層住宅池仍可能變化。

## 批量生成與結構化查詢

`POST /generate/batch` 接受 1 至 50 的 `count`、必填的 `filters` 物件、可選的 `options`（`unique`、`seed`、`strategy`、`requestId`），以及最多 500 個 `excludeAddressIds`。唯一合格地址不足時返回已有結果，並以 `exhausted: true` 標明。

`GET /locations/hierarchy` 使用 `country`、`parentType`、`parentId` 和 `childType` 瀏覽目錄上下級。`GET /addresses/{id}` 重新查詢目前仍在發布的同步地址。`GET /coverage` 分別返回國家總量、完整行政區覆蓋率和各級節點最低數量三項規則。

## 地址翻譯

`POST /address-translation` 將已生成地址的語義組件（社區/樓棟、街道、城市、區縣、行政區）返回為指定顯示語言；數字標識（門牌號、單元、郵編）始終原樣保留。

| 參數 | 默認值 | 說明 |
|---|---|---|
| `addressId` | 必填 | `/generate` 返回的 `result.address.id` |
| `targetLocale` | 必填 | `en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es` 或 `pt` |

顯示鏈路為：已存儲變體 → 按需翻譯 → 原文。僅當每個語義組件均已符合目標文字時才直接使用已存儲變體；否則依次執行本地文字轉換（中文目標使用 OpenCC，中文來源的英文目標以拼音兜底）和已配置的翻譯服務商，並對每個候選做文字與數字保真校驗。響應始終為單一語言的完整地址：任何環節都無有效結果時返回 `fallback` 或 `unavailable`，客戶端應回退展示完整原文地址，絕不混排。

## WebUI 地圖配置

地圖顯示屬於 WebUI 配置，不改變 `/generate` 的地址證據。受會話保護的 `/web-api/v1` 通道只返回顯示開關，以及啟用高德時瀏覽器加載所需的專用 JS API Key；不會返回高德 JS 安全密鑰或任何同步 Key。

Google 與高德分別提供中國和國外開關，默認均為 Google 開啟、高德關閉。中國高德標記使用 GCJ-02 座標；高德國外地圖需要賬號已開通世界地圖權限。高德服務請求統一使用同源 `/_AMapService` 前綴，由伺服器讀取加密安全密鑰並附加後再轉發到固定高德上游。

## 數據健康

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/data-health
```

該端點返回配置國家、無效配置、熱點池覆蓋、低水位槽位和就緒狀態，適合監控和部署檢查。

## 錯誤格式

```json
{
  "error": {
    "code": "INVALID_COUNTRY",
    "message": "Unknown country code: ZZ"
  }
}
```

常見代碼包括 `INVALID_COUNTRY`、`INVALID_FIELD`、`INVALID_LOCATION`、`INVALID_RESIDENTIAL`、`IP_LOCATION_UNAVAILABLE`、`NO_POOL_COVERAGE` 和 IP 參數校驗錯誤。調用方應判斷 `error.code`，不要依賴界面翻譯文本。

## 同步管理 API

同步服務默認只監聽 `127.0.0.1:8791`。任務端點要求 `Authorization: Bearer SYNC_ADMIN_TOKEN`。

| 方法 | 路徑 | 用途 |
|---|---|---|
| `GET` | `/healthz` | `8791` 端口的本地同步服務健康檢查 |
| `POST` | `/api/v1/sync/jobs` | 創建 `initial` 或 `manual` 任務 |
| `GET` | `/api/v1/sync/jobs/latest` | 查詢最近任務 |
| `GET` | `/api/v1/sync/jobs/{id}` | 查詢指定任務 |

```bash
curl -fsS -X POST http://127.0.0.1:8791/api/v1/sync/jobs \
  -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"manual","shards":["CN"]}'
```

任務接受後返回 HTTP `202`、任務對象和 `Location` 請求頭。已有任務運行時返回 `409`；JSON、模式或分片標識無效時返回 `400`。

主 API 默認隱藏 `/sync-control/*`。保持 `SYNC_CONTROL_PUBLIC=false`，通過本地端口或額外的私有訪問邊界進行管理。

## CORS 與隱私

- 生產環境將 `ALLOWED_ORIGIN` 設置為公開 HTTPS 來源。
- API Key 和 `SYNC_ADMIN_TOKEN` 不進入查詢參數、瀏覽器代碼、截圖或日誌。
- 瀏覽器渲染應使用專用且受域名限制的高德 JS API Key。JS Key 按平台機制會出現在瀏覽器請求中；配套安全密鑰和所有 WebService 同步 Key 始終留在伺服器。
