# API Key 設定

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

在「後台 → 服務憑據」新增憑據。同一平台可新增多組憑據，系統會自動輪換。

| 平台 | 對應國家或功能 | 後台設定名稱 |
|---|---|---|
| 高德 WebService | 中國地址同步 | 高德地圖 |
| 百度地圖 | 中國地址同步 | 百度地圖 |
| 騰訊位置服務 | 中國地址同步 | 騰訊地圖 |
| Mappls Reverse Geocoding | 印度地址補全 | Mappls |
| OneMap | 新加坡地址同步 | OneMap |
| Geoapify Reverse Geocoding | 韓國郵遞區號補全 | Geoapify |
| Google Geocoding | 支援的低數量國家住宅地址補全 | Google Geocoding |
| 有道文字翻譯 | 地址翻譯 | 有道翻譯 |
| 高德 JavaScript API | 中國前端地圖 | 高德前端地圖 |

## 高德 WebService

1. 開啟[高德開發者控制台](https://console.amap.com/dev/index)。
2. 依[官方指南](https://lbs.amap.com/api/webservice/create-project-and-key)建立應用與 **WebService** Key。
3. 設定伺服器 IP 限制，在「高德地圖」下新增 Key。

## 百度地圖

1. 開啟[百度地圖 API 控制台](https://lbsyun.baidu.com/apiconsole/key)。
2. 建立「服務端」應用並開通地點搜尋 Web API。
3. 設定伺服器 IP 限制，在「百度地圖」下新增 AK。

## 騰訊位置服務

1. 開啟[騰訊位置服務控制台](https://lbs.qq.com/dev/console/application/mine)。
2. 建立應用並開通 **WebService API**。
3. 設定伺服器 IP 或簽名限制，在「騰訊地圖」下新增 Key。

## Mappls Reverse Geocoding

1. 在 [Mappls 控制台](https://auth.mappls.com/console/)建立應用。
2. 開通 **Reverse Geocoding API**，從 credentials 區域複製靜態 Key。
3. 設定伺服器 IP 限制，在「Mappls」下新增 Key。

介接方式以 [Mappls Reverse Geocoding 官方文件](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/)為準。

## OneMap

1. 註冊 [OneMap API](https://www.onemap.gov.sg/apidocs/register)。
2. 透過[認證介面](https://www.onemap.gov.sg/apidocs/authentication)產生 Access Token。
3. 在「OneMap」下新增 Token，並在三天有效期結束前替換。

## Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/)建立專案。
2. 複製專案 API Key。
3. 在「Geoapify」下新增 Key。

參見[反向地理編碼官方文件](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)。

## Google Geocoding

1. 建立或選擇 Google Cloud 專案並連結結算帳戶。
2. 依[官方設定指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)開通 **Geocoding API**。
3. 建立伺服器 Key，限制到 Geocoding API 與部署伺服器 IP，在「Google Geocoding」下新增。

專案使用 Geocoding API v4，不需要 Places API。

## 有道文字翻譯

1. 註冊[有道智雲](https://ai.youdao.com/)。
2. 建立應用並開通文字翻譯。
3. 在「線上翻譯」中新增應用 ID 與應用密鑰。

每條設定保存一組 ID/密鑰，支援新增多組。

## 高德 JavaScript API

1. 在高德控制台另行建立 **JavaScript API** Key 與安全密鑰。
2. 將 Key 限制到正式網域。
3. 在「高德前端地圖」中新增兩個值。

不要與高德 WebService Key 共用。
