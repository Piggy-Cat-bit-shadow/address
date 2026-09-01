# API Key 配置

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

在“后台 → 服务凭据”添加凭据。同一平台可以添加多组凭据，系统会自动轮换。

| 平台 | 对应国家或功能 | 后台配置名称 |
|---|---|---|
| 高德 WebService | 中国地址同步 | 高德地图 |
| 百度地图 | 中国地址同步 | 百度地图 |
| 腾讯位置服务 | 中国地址同步 | 腾讯地图 |
| Mappls Reverse Geocoding | 印度地址补全 | Mappls |
| OneMap | 新加坡地址同步 | OneMap |
| Geoapify Reverse Geocoding | 韩国邮编补全 | Geoapify |
| Google Geocoding | 支持的低数量国家住宅地址补全 | Google Geocoding |
| 有道文本翻译 | 地址翻译 | 有道翻译 |
| 高德 JavaScript API | 中国前端地图 | 高德前端地图 |

## 高德 WebService

1. 打开[高德开发者控制台](https://console.amap.com/dev/index)。
2. 按[官方指南](https://lbs.amap.com/api/webservice/create-project-and-key)创建应用和 **WebService** Key。
3. 配置服务器 IP 限制，在“高德地图”下添加 Key。

## 百度地图

1. 打开[百度地图 API 控制台](https://lbsyun.baidu.com/apiconsole/key)。
2. 创建“服务端”应用并开通地点检索 Web API。
3. 配置服务器 IP 限制，在“百度地图”下添加 AK。

## 腾讯位置服务

1. 打开[腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)。
2. 创建应用并开通 **WebService API**。
3. 配置服务器 IP 或签名限制，在“腾讯地图”下添加 Key。

## Mappls Reverse Geocoding

1. 在 [Mappls 控制台](https://auth.mappls.com/console/)创建应用。
2. 开通 **Reverse Geocoding API**，从 credentials 区域复制静态 Key。
3. 配置服务器 IP 限制，在“Mappls”下添加 Key。

接口以 [Mappls Reverse Geocoding 官方文档](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/)为准。

## OneMap

1. 注册 [OneMap API](https://www.onemap.gov.sg/apidocs/register)。
2. 通过[认证接口](https://www.onemap.gov.sg/apidocs/authentication)生成 Access Token。
3. 在“OneMap”下添加 Token，并在三天有效期结束前替换。

## Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/)创建项目。
2. 复制项目 API Key。
3. 在“Geoapify”下添加 Key。

参见[反向地理编码官方文档](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)。

## Google Geocoding

1. 创建或选择 Google Cloud 项目并关联结算账户。
2. 按[官方配置指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)开通 **Geocoding API**。
3. 创建服务端 Key，将它限制到 Geocoding API 和部署服务器 IP，在“Google Geocoding”下添加。

项目使用 Geocoding API v4，不需要 Places API。

## 有道文本翻译

1. 注册[有道智云](https://ai.youdao.com/)。
2. 创建应用并开通文本翻译。
3. 在“在线翻译”中添加应用 ID 和应用密钥。

每条配置保存一组 ID/密钥，支持添加多组。

## 高德 JavaScript API

1. 在高德控制台单独创建 **JavaScript API** Key 和安全密钥。
2. 将 Key 限制到正式域名。
3. 在“高德前端地图”中添加两个值。

不要与高德 WebService Key 共用。
