# API Key 設定

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

已有 PostgreSQL 位址池可在沒有第三方金鑰時正常產生位址。只有對應的同步、翻譯、地理編碼或地圖預覽功能需要平台憑據。

## 儲存位置與優先關係

- 高德、百度、騰訊、Mappls、OneMap、Geoapify、Google Geocoding、有道及高德瀏覽器地圖憑據統一在管理員後台設定；所有值使用 `CONFIG_MASTER_KEY` 加密後存入 PostgreSQL。
- 管理員後台保存的憑據直接加入同步服務使用的額度、冷卻與輪換池。
- 一般部署保持 `config/address.env` 為空。它只保留給同步程序啟動前必須存在的授權 feed URL、欄位映射與授權門禁；除非未來適配器明確要求，否則不要在其中保存平台 Key。

## 平台憑據

### 高德 WebService

1. 註冊並進入[高德控制台](https://console.amap.com/dev/index)。
2. 依照[官方建立 Key 文件](https://lbs.amap.com/api/webservice/create-project-and-key)建立應用與 **WebService** Key。
3. 依控制台能力限制來源，只開啟專案需要的服務。
4. 設定 `AMAP_API_KEY`；額外金鑰使用 `AMAP_API_KEY_2` 等編號，或在「後台 → 服務憑據」逐一新增。

伺服器同步 Key 不得與瀏覽器地圖 Key 共用。

高德[基礎服務價格與配額頁](https://lbs.amap.com/pages/base_service_price)列出的個人認證基礎搜尋預設值為每月 `5,000` 次、`3 QPS`。官方[錯誤碼表](https://lbs.amap.com/api/webservice/guide/tools/info/)中，`10003` 為每日存取量超限並於次日 `00:00` 解封，`10004` 為單位時間存取超限並於下一分鐘解封；`40000` 屬於餘額或方案額度耗盡。系統分別記錄分鐘冷卻、每日視窗和每月視窗。

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

百度[開發者權益說明](https://lbsyun.baidu.com/solutions/privilege)列出的個人地點搜尋預設值為每日 `100` 次、`3 QPS`。方案或控制台顯示不同值時，以目前帳戶控制台為準。

### 騰訊位置服務

1. 進入[騰訊位置服務控制台](https://lbs.qq.com/dev/console/application/mine)建立應用與 Key。
2. 只在需要時開啟 **WebService API**。
3. 設定 IP 或簽名限制。
4. 設定 `TENCENT_API_KEY`、編號變數，或在後台逐一新增。

騰訊[官方狀態碼表](https://lbs.qq.com/service/webService/webServiceGuide/status)說明：`120` 為每秒請求量上限，`121` 為每日呼叫量上限。回應標頭 `X-LIMIT` 可提供即時用量，最終以控制台為準。

騰訊[WebService 配額說明](https://lbs.qq.com/webservice_v1/guide-quota.html)列出的初始預設值為每日 `10,000` 次、`5 QPS`。若 `X-LIMIT` 或控制台回傳不同實際值，系統儲存並優先採用該每日視窗值。

### Mappls Search API

1. 在 [Mappls 控制台](https://auth.mappls.com/console/)建立應用，並為該應用開通 Nearby Places 與 Place Details。
2. 從應用的 credentials 區域複製靜態 Key；現行 Nearby API 文件要求透過 `access_token` 查詢參數傳入。
3. 控制台支援時，將 Key 限制到生產伺服器 IP。
4. 設定 `MAPPLS_API_KEY`、`MAPPLS_API_KEY_2` 等編號變數，或在管理後台逐一新增。

印度住宅適配器預設關閉。只有合約明確允許住宅分類代碼、受限地址欄位、座標、快取和再分發後才能啟用。系統內建的每日 1,000 次只是本機保護值，不是官方方案額度；實際額度必須按合約和控制台設定。參見 [Nearby API 現行文件](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-near-by-api-example/Readme)。

### 越南郵政 Vpostcode feed

1. 取得允許住宅欄位、座標、伺服器端快取和再分發的 Vpostcode 批次 feed 或 API 合約。
2. 將 `ADDRESS_SYNC_VPOSTCODE_FEED_URL` 設定為 HTTPS feed，或設定為 `ADDRESS_DATA_ROOT` 下的本機檔案；填寫不可變的 `ADDRESS_SYNC_VPOSTCODE_FEED_VERSION` 和格式（`csv`、`json` 或 `jsonl`）。
3. 將 `ADDRESS_SYNC_VPOSTCODE_FIELD_MAP` 設定為 JSON，映射 `id`、`number`、`street`、`locality`、`admin1`、`postcode`、`longitude` 和 `latitude`。若合約沒有明確整庫均為住宅，還要映射 `residentialClass` 並設定 `ADDRESS_SYNC_VPOSTCODE_RESIDENTIAL_VALUES`。
4. 檢查合約和欄位樣本後，才設定 `ADDRESS_SYNC_VPOSTCODE_ENABLED=true`、`ADDRESS_SYNC_VPOSTCODE_LICENSE_CONFIRMED=true` 和 `ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED=true`。

適配器只接受五位郵遞區號；在真實授權樣本通過住宅品質門禁前保持關閉。合成 feed 吞吐測試不能證明 Vpostcode 的真實容量。

### 奈及利亞 NIPOST 或 ProgIS feed

1. 取得允許住宅欄位、座標、伺服器端快取和再分發的 NIPOST 或 ProgIS 批次 feed 合約。
2. 將 `ADDRESS_SYNC_NG_FEED_URL` 設定為 HTTPS feed，或設定為 `ADDRESS_DATA_ROOT` 下的本機檔案；填寫 `ADDRESS_SYNC_NG_FEED_VERSION` 和格式（`csv`、`json` 或 `jsonl`）。
3. 將 `ADDRESS_SYNC_NG_FIELD_MAP` 設定為 JSON，映射 `id`、`number`、`street`、`district`、`locality`、`admin1`、`postcode`、`longitude` 和 `latitude`。若合約沒有明確整庫均為住宅，還要映射 `residentialClass` 並設定 `ADDRESS_SYNC_NG_RESIDENTIAL_VALUES`。
4. 檢查合約和欄位樣本後，才設定 `ADDRESS_SYNC_NG_FEED_ENABLED=true`、`ADDRESS_SYNC_NG_LICENSE_CONFIRMED=true` 和 `ADDRESS_SYNC_NG_REDISTRIBUTION_ALLOWED=true`。

適配器要求六位郵遞區號和 district；在真實授權樣本通過住宅品質門禁前保持關閉。合成 feed 吞吐測試不能證明 NIPOST 或 ProgIS 的真實容量。

### Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/) 建立帳號與專案。
2. 複製專案 Key，並查看[反向地理編碼文件](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)與[官方價格及額度](https://www.geoapify.com/pricing/)。
3. 在「後台 → 服務憑據 → Geoapify」逐一新增 Key。`GEOAPIFY_API_KEY`、`GEOAPIFY_API_KEY_2` 等環境變數只用於首次部署匯入。

韓國 K-apt 每次核驗郵遞區號前都從加密憑據池取得 Key，並分別回寫認證失敗、限速、額度等待及暫時失敗。全部 Key 不可用時，同步等待資料庫記錄的最早恢復時間。同一專案或帳戶共享額度的 Key 必須設定相同的額度作用域。Geoapify 目前每次 Reverse Geocoding 消耗一個 credit；方案可能變更，因此後台額度仍可編輯。`429` 回應優先遵循 `Retry-After`；平台未提供重置時間時，依該憑據設定的時區計算本機日額度視窗。

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

系統依啟用狀態、QPS、額度、有效期、冷卻時間與最近使用時間選擇憑據。一個 Key 可同時具有每日與每月多個額度視窗，任一視窗耗盡都會輪換到其他 Key。單一 Key 失敗後，本輪只排除該 Key，並繼續使用其他可用 Key。額度耗盡時等待平台回傳的恢復時間或對應週期邊界；QPS 與分鐘限制只進入短冷卻。所有 Key 暫不可用時，任務等待最早恢復的 Key。

官方控制台與回應標頭優先於文件範例。建立憑據時應在後台正確設定服務名稱、週期、上限、時區邊界與選用的共用額度群組。

## 提交前檢查

1. 執行 `npm run check:public`。
2. 檢查 `git diff --cached --name-only`，確認沒有 `.env`、資料庫、備份、日誌、原始回應、憑證或私鑰。
3. 只在管理後台測試憑據，不把完整值複製到日誌或截圖。
4. 若憑據曾被顯示，立即輪換。

官方頁面核對日期：2026-08-05。平台條款、方案、額度與控制台流程可能變更。
