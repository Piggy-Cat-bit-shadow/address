# API Key 設定

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

已有 PostgreSQL 位址池可在沒有第三方金鑰時正常產生位址。只有對應的同步、翻譯、地理編碼或地圖預覽功能需要平台憑據。

## 儲存位置與優先關係

- 啟動值只能寫入被 Git 忽略的 `.env` 或 `/root/address/runtime/address.env`，後者權限應設為 `600`。不要把真實值寫入範例檔。
- 管理後台可儲存高德、百度、騰訊、OneMap、Geoapify、Google Geocoding、有道及高德瀏覽器地圖憑據；所有值使用 `CONFIG_MASTER_KEY` 加密後存入 PostgreSQL。
- 程序啟動時會匯入尚未儲存的環境變數金鑰；後台記錄與其共同參與輪換，修改範例檔不會覆蓋已有密文記錄。
- 韓國批次同步程序目前在啟動時直接讀取 `GEOAPIFY_API_KEY`；新加坡 OneMap 輔助匯入直接讀取 `ONEMAP_ACCESS_TOKEN`。

## 平台憑據

### 高德 WebService

1. 註冊並進入[高德控制台](https://console.amap.com/dev/index)。
2. 依照[官方建立 Key 文件](https://lbs.amap.com/api/webservice/create-project-and-key)建立應用與 **WebService** Key。
3. 依控制台能力限制來源，只開啟專案需要的服務。
4. 設定 `AMAP_API_KEY`；額外金鑰使用 `AMAP_API_KEY_2` 等編號，或在「後台 → 服務憑據」逐一新增。

伺服器同步 Key 不得與瀏覽器地圖 Key 共用。

### 高德 JavaScript 地圖

1. 另外建立 **JavaScript API** Key 與安全金鑰。
2. 將瀏覽器 Key 限制到正式網域。
3. 設定 `AMAP_JS_API_KEY` 與 `AMAP_JS_SECURITY_CODE`，或在後台的高德瀏覽器地圖設定中儲存。

瀏覽器 Key 依平台機制會出現在瀏覽器請求中；安全金鑰只保留於伺服器，透過同源代理使用。高德[安全金鑰官方文件](https://lbs.amap.com/api/maps-javascript-api/guide/abc/jscode)建議使用代理轉送。

### 百度地圖

1. 註冊並進入[百度地圖 API 控制台](https://lbsyun.baidu.com/apiconsole/key)。
2. 建立「服務端」應用，開啟專案使用的 Place/Web API。
3. 設定適合伺服器的 IP 白名單或簽名驗證。
4. 設定 `BAIDU_API_KEY`、`BAIDU_API_KEY_2` 等，或在後台逐一新增 AK。

請參考[百度 Web API 官方文件](https://lbsyun.baidu.com/faq/api?title=webapi%2Fguide%2Fwebservice-placeapi)。額度、無效 AK、服務未開啟及 IP/簽名錯誤只影響對應憑據。

### 騰訊位置服務

1. 進入[騰訊位置服務控制台](https://lbs.qq.com/dev/console/application/mine)建立應用與 Key。
2. 只在需要時開啟 **WebService API**。
3. 設定 IP 或簽名限制。
4. 設定 `TENCENT_API_KEY`、編號變數，或在後台逐一新增。

騰訊[官方狀態碼表](https://lbs.qq.com/service/webService/webServiceGuide/status)說明：`120` 為每秒請求量上限，`121` 為每日呼叫量上限。回應標頭 `X-LIMIT` 可提供即時用量，最終以控制台為準。

### Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/) 建立帳號與專案。
2. 複製專案 Key，並查看[官方價格與額度](https://www.geoapify.com/pricing/)。
3. 設定 `GEOAPIFY_API_KEY`；API 端需要輪換時也可在後台新增。

韓國 K-apt 首次匯入需要此環境變數核驗郵遞區號。不要寫死額度，方案與接口 credits 可能變更。

### 新加坡 OneMap

1. 註冊 [OneMap API](https://www.onemap.gov.sg/apidocs/register)。
2. 透過[官方認證接口](https://www.onemap.gov.sg/apidocs/authentication)產生 Access Token。
3. 在新加坡匯入程序啟動前設定 `ONEMAP_ACCESS_TOKEN`。

OneMap 官方說明 Token 有效期為 3 天。到期前更新環境變數，並重新啟動讀取該變數的同步程序。

### Google Geocoding

1. 建立或選擇 Google Cloud 專案、連結結算帳戶並啟用 Geocoding API。
2. 建立 API Key，限制可用 API 與伺服器來源。
3. 設定 `GOOGLE_GEOCODING_API_KEY`，或在後台新增。

依 Google [官方設定指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)操作，並在[用量與結算頁面](https://developers.google.com/maps/documentation/geocoding/usage-and-billing)檢查目前價格、額度與告警設定。

### OS Data Hub

1. 登入 [OS Data Hub](https://osdatahub.os.uk/)。
2. 開啟「Data → API Projects」，建立專案並加入所需 API。
3. 複製專案 Key，設定 `OS_DATA_HUB_API_KEY`。

[官方帳號與 API FAQ](https://osdatahub.os.uk/support/faqs/account-and-apis#generateApiKey)亦說明重新產生 Key 的步驟。除非選用的資料策略明確要求，否則此整合為選用功能。

### 有道翻譯

1. 註冊[有道智雲](https://ai.youdao.com/)，建立應用並開通文字翻譯。
2. 取得應用 ID 與應用金鑰。
3. 設定 `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET`，或在「後台 → 服務憑據 → 線上翻譯」儲存。
4. `GOOGLE_TRANSLATION_ENABLED` 只控制 Google 線上翻譯路徑；關閉後，已設定的有道仍可作為翻譯服務。

[官方文字翻譯 API](https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html)說明 v3 SHA-256 簽名。應用金鑰不得進入前端程式碼。

## 專案自身密鑰

以下值由部署者自行產生，不是第三方 API Key：

```bash
openssl rand -base64 32   # CONFIG_MASTER_KEY
openssl rand -hex 32      # SYNC_ADMIN_TOKEN
openssl rand -base64 36   # 管理員與 PostgreSQL 密碼
```

| 變數 | 用途 |
|---|---|
| `CONFIG_MASTER_KEY` | 加密平台憑據。必須穩定保存及備份；更換後舊密文無法讀取。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 只在 PostgreSQL 尚無管理員身份時建立第一位管理員。 |
| `SYNC_ADMIN_TOKEN` | API 與同步控制程序之間驗證；兩個程序必須使用相同值。 |
| `POSTGRES_URL` 中的密碼 | 應用連接 PostgreSQL 的密碼；保留字元必須進行 URL 編碼。 |

## 輪換與冷卻

系統依啟用狀態、QPS、額度、有效期、冷卻時間與最近使用時間選擇憑據。單一 Key 失敗後，本輪只排除該 Key，並繼續使用其他可用 Key。額度耗盡時等待平台回傳的恢復時間或設定週期邊界；短暫錯誤使用有上限的指數冷卻。所有 Key 暫不可用時，任務等待最早恢復的 Key，而不會永久停用整個平台。

官方控制台與回應標頭優先於文件範例。建立憑據時應在後台正確設定服務名稱、週期、上限、時區邊界與選用的共用額度群組。

## 提交前檢查

1. 執行 `npm run check:public`。
2. 檢查 `git diff --cached --name-only`，確認沒有 `.env`、資料庫、備份、日誌、原始回應、憑證或私鑰。
3. 只在管理後台測試憑據，不把完整值複製到日誌或截圖。
4. 若憑據曾被顯示，立即輪換。

官方頁面核對日期：2026-08-03。平台條款、方案、額度與控制台流程可能變更。
