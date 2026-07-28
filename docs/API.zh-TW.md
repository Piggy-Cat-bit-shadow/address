# Address API 文檔

[English](API.md) · [簡體中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

外部 API 位於 `/api/v1`，其資料端點使用 `GET` 並返回 JSON。服務啟動後，可在 `/en/api/` 或 `/zh-CN/api/` 查看互動參數說明。

## 基礎地址

```text
https://YOUR_DOMAIN.example/api/v1
```

本地開發默認使用 `http://127.0.0.1:8787/api/v1`。

除 `/api/v1/health` 外，外部 API 請求需要管理員創建的 Bearer Token：

```http
Authorization: Bearer YOUR_API_TOKEN
```

Token 在 `/admin/` 建立，同時保存不可逆驗證雜湊和由服務端主密鑰加密的密文，可設定權限、限速和到期時間，也可在管理員工作階段中查看、修改或撤銷。WebUI 使用獨立的 `/web-api/v1` 工作階段通道，不嵌入該 Token。驗證失敗返回 `401`；超過令牌每分鐘限速返回 `429` 和 `Retry-After: 60`。

## 外部端點

| 方法 | 路徑 | 用途 |
|---|---|---|
| `GET` | `/health` | API 基礎健康檢查 |
| `GET` | `/countries` | 國家註冊表、同步數量和嚴格住宅覆蓋 |
| `GET` | `/client-context` | 將請求 IP 或指定 IP 解析到支持地區 |
| `GET` | `/locations/search` | 搜索州省、城市和郵編選項 |
| `GET` | `/generate` | 生成通過證據門禁的真實住宅地址和相關測試資料 |
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
| `field` | `city` | `region`、`city` 或 `postcode` |
| `q` | 空 | 搜索文本 |
| `region` | 空 | 上級州省文本 |
| `regionId` | 空 | 穩定州省 ID |
| `cityId` | 空 | 穩定城市 ID |
| `residential` | `false`（目錄兼容） | 傳入 `true` 時只列出具備真實住宅覆蓋的選項；`/generate` 始終使用住宅記錄 |
| `cursor` | 空 | 上一頁返回的分頁游標 |
| `limit` | `100` | 請求頁大小 |

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
| `region`、`city`、`postcode` | 空 | 可讀地區篩選 |
| `regionId`、`cityId`、`postcodeId` | 空 | 穩定目錄 ID |
| `q` | 空 | 自由文本地區提示 |
| `strategy` | `random` | 用 `random` 或 `instant` 選擇合格真實記錄，不合成地址字段 |
| `seed` | 自動 UUID | 確定性生成種子 |
| `requestId` | 自動 UUID | 調用方關聯 ID |
| `live` | `false` | 單次請求啟用已配置實時服務；候選記錄仍需具備真實住宅證據 |

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

響應外層為 `{ "data": { ... } }`。生成數據包含請求 ID、模式、國家、篩選、精確 `filterMatchLevel` 或 IP `ipMatchLevel`、嘗試的數據源和耗時。地址三語變體與室內字段均來自來源，缺失值保持為空；人物資料、沙盒銀行卡、工作、財務和網絡字段仍為合成測試數據。地區篩選嚴格匹配，IP 模式只接受座標或城市匹配。

需要穩定復現合格記錄選擇與測試資料時傳入 `seed`；該參數不會生成缺失的地址組件。地址源同步後，底層住宅池仍可能變化。

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
- 生成的個人資料和銀行卡號是測試數據，不對應真實個人或支付賬戶。
- 公開生成從 active SQLite 讀取具備證據的真實住宅記錄；啟用實時服務後，候選記錄仍執行地址存在性和住宅證據門禁。
