# API key configuration

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

Add credentials in **Admin → Service credentials**. Multiple credentials under the same provider are rotated automatically.

| Provider | Country or feature | Administrator entry |
|---|---|---|
| AMap WebService | China address synchronization | AMap |
| Baidu Maps | China address synchronization | Baidu Maps |
| Tencent Location Service | China address synchronization | Tencent Maps |
| Mappls Reverse Geocoding | India address enrichment | Mappls |
| OneMap | Singapore address synchronization | OneMap |
| Geoapify Reverse Geocoding | South Korea postcode enrichment | Geoapify |
| Google Geocoding | Residential enrichment for supported low-volume countries | Google Geocoding |
| Youdao Text Translation | Address translation | Youdao Translate |
| AMap JavaScript API | China browser map | AMap browser map |

## AMap WebService

1. Open the [AMap developer console](https://console.amap.com/dev/index).
2. Create an application and a **WebService** key using the [official guide](https://lbs.amap.com/api/webservice/create-project-and-key).
3. Apply the server IP restriction and add the key under **AMap**.

## Baidu Maps

1. Open the [Baidu Maps API console](https://lbsyun.baidu.com/apiconsole/key).
2. Create a **Server** application and enable the Place Web API.
3. Apply the server IP restriction and add the AK under **Baidu Maps**.

## Tencent Location Service

1. Open the [Tencent Location Service console](https://lbs.qq.com/dev/console/application/mine).
2. Create an application and enable **WebService API**.
3. Apply the server IP or signature restriction and add the key under **Tencent Maps**.

## Mappls Reverse Geocoding

1. Create an application in the [Mappls Console](https://auth.mappls.com/console/).
2. Enable **Reverse Geocoding API** and copy the static key from the credentials section.
3. Apply the server IP restriction and add the key under **Mappls**.

The integration follows the [Mappls Reverse Geocoding API](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/).

## OneMap

1. Register for [OneMap API access](https://www.onemap.gov.sg/apidocs/register).
2. Generate an access token through the [authentication API](https://www.onemap.gov.sg/apidocs/authentication).
3. Add the token under **OneMap**. Replace it before its three-day expiry.

## Geoapify

1. Create a project in [Geoapify MyProjects](https://myprojects.geoapify.com/).
2. Copy the project API key.
3. Add the key under **Geoapify**.

See the [Reverse Geocoding API documentation](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/).

## Google Geocoding

1. Create or select a Google Cloud project and attach a billing account.
2. Enable **Geocoding API** using the [official setup guide](https://developers.google.com/maps/documentation/geocoding/get-api-key).
3. Create a server API key, restrict it to Geocoding API and the deployment server IP, then add it under **Google Geocoding**.

The project uses Geocoding API v4. Places API is not required.

## Youdao Text Translation

1. Register at [Youdao Zhiyun](https://ai.youdao.com/).
2. Create an application and enable Text Translation.
3. Add the application ID and application secret under **Online translation**.

Each entry stores one ID/secret pair; multiple pairs are supported.

## AMap JavaScript API

1. Create a separate **JavaScript API** key and security code in the AMap console.
2. Restrict the key to the production domain.
3. Add both values under **AMap browser map**.

Do not reuse the AMap WebService key for browser maps.
