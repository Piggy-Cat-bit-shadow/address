# API key configuration

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

Address can serve an existing PostgreSQL address pool without third-party keys. Provider credentials are needed only for the related synchronization, translation, geocoding, or map-preview feature.

## Where credentials are stored

- Put bootstrap values in an ignored `.env` file or `/root/address/runtime/address.env` (`chmod 600`). Never edit an example file with a real value.
- The administrator console can store AMap, Baidu, Tencent, OneMap, Geoapify, Google Geocoding, Youdao, and AMap browser credentials. They are encrypted in PostgreSQL with `CONFIG_MASTER_KEY`.
- Environment provider keys are imported at startup if they are not already present. Administrator records then coexist with them; changing an example file never replaces an existing encrypted record.
- The Korea batch worker currently reads `GEOAPIFY_API_KEY` from the process environment at startup. OneMap-assisted Singapore import also reads `ONEMAP_ACCESS_TOKEN` from the process environment.

## Provider credentials

### AMap WebService

1. Register at the [AMap developer console](https://console.amap.com/dev/index).
2. Create an application and a **WebService** key following the [official key guide](https://lbs.amap.com/api/webservice/create-project-and-key).
3. Restrict the key as allowed by the console and enable only required services.
4. Set `AMAP_API_KEY`; additional keys use numbered names such as `AMAP_API_KEY_2`, or add every key separately in **Admin → Service credentials**.

Do not reuse this server key for browser maps.

### AMap JavaScript map

1. Create a dedicated **JavaScript API** key and security code in the AMap console.
2. Restrict the browser key to the production domain.
3. Configure `AMAP_JS_API_KEY` and `AMAP_JS_SECURITY_CODE`, or use **Admin → Service credentials → AMap browser map**.

The browser key is visible to browsers by design. The security code remains server-side and is applied through the same-origin proxy. AMap's [official security-code guide](https://lbs.amap.com/api/maps-javascript-api/guide/abc/jscode) recommends proxy forwarding rather than exposing the code.

### Baidu Maps

1. Register and open the [Baidu Maps API console](https://lbsyun.baidu.com/apiconsole/key).
2. Create a **Server** application and enable the Place/Web API services used by the project.
3. Configure an IP whitelist or signature policy suitable for the server.
4. Set `BAIDU_API_KEY`, numbered variants such as `BAIDU_API_KEY_2`, or add keys in the administrator console.

See Baidu's [official Web API documentation](https://lbsyun.baidu.com/faq/api?title=webapi%2Fguide%2Fwebservice-placeapi). Codes for quota, invalid AK, disabled service, and IP/signature validation are handled per credential.

### Tencent Location Service

1. Register in the [Tencent Location Service console](https://lbs.qq.com/dev/console/application/mine).
2. Create an application and key, then enable **WebService API** only where needed.
3. Apply IP/signature restrictions.
4. Set `TENCENT_API_KEY`, a numbered variant, or add each key in the administrator console.

Tencent documents response code `120` as a per-second limit and `121` as a daily limit in its [official status table](https://lbs.qq.com/service/webService/webServiceGuide/status). Current usage may also be reported in `X-LIMIT` response headers; the console remains authoritative.

### Geoapify

1. Create an account and project at [Geoapify MyProjects](https://myprojects.geoapify.com/).
2. Copy the project API key and review the current [official pricing and quotas](https://www.geoapify.com/pricing/).
3. Set `GEOAPIFY_API_KEY`. Add API-side keys in the administrator console when appropriate.

The Korea K-apt initial import requires this environment variable for postcode verification. Do not hard-code a quota: plans and endpoint credit costs can change.

### Singapore OneMap

1. Register for [OneMap API access](https://www.onemap.gov.sg/apidocs/register).
2. Use the [authentication endpoint](https://www.onemap.gov.sg/apidocs/authentication) to generate an access token.
3. Set `ONEMAP_ACCESS_TOKEN` before starting the Singapore import.

OneMap states that a token is valid for three days. Refresh the environment value before expiry and restart the worker that consumes it.

### Google Geocoding

1. Create or select a Google Cloud project, attach billing, and enable Geocoding API.
2. Create an API key and apply API and server restrictions.
3. Set `GOOGLE_GEOCODING_API_KEY` or add it in the administrator console.

Follow Google's [official setup guide](https://developers.google.com/maps/documentation/geocoding/get-api-key). Pricing and quotas are account-dependent; review the [usage and billing page](https://developers.google.com/maps/documentation/geocoding/usage-and-billing) and set cost/quota alerts.

### OS Data Hub

1. Sign in to [OS Data Hub](https://osdatahub.os.uk/).
2. Open **Data → API Projects**, create a project, and add the required API.
3. Copy the project API key and set `OS_DATA_HUB_API_KEY`.

The [official account and API FAQ](https://osdatahub.os.uk/support/faqs/account-and-apis#generateApiKey) also explains key regeneration. This integration is optional unless a selected import strategy explicitly requires it.

### Youdao translation

1. Register at [Youdao Zhiyun](https://ai.youdao.com/), create an application, and enable text translation.
2. Copy the application ID and application secret.
3. Set `YOUDAO_APP_KEY` and `YOUDAO_APP_SECRET`, or save both in **Admin → Service credentials → Online translation**.
4. `GOOGLE_TRANSLATION_ENABLED` controls only the Google online-translation path; when it is disabled, a configured Youdao credential can still provide translation.

The [official text-translation API](https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html) describes the v3 SHA-256 signature. Never expose the application secret in frontend code.

## Project-generated secrets

Generate these independently; they are not provider API keys:

```bash
openssl rand -base64 32   # CONFIG_MASTER_KEY
openssl rand -hex 32      # SYNC_ADMIN_TOKEN
openssl rand -base64 36   # administrator and PostgreSQL passwords
```

| Variable | Purpose |
|---|---|
| `CONFIG_MASTER_KEY` | Encrypts provider credentials. Keep it stable and backed up; changing it makes existing ciphertext unreadable. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Creates the first administrator only when PostgreSQL contains no administrator identity. |
| `SYNC_ADMIN_TOKEN` | Authenticates API-to-sync-control requests. Use the same value in both processes. |
| `POSTGRES_URL` password | Authenticates the application to PostgreSQL. URL-encode reserved characters. |

## Rotation and cooldown behavior

Credentials are selected by least-recent use while respecting enabled state, QPS, quota, expiry, and cooldown. A request failure excludes only that credential from the current attempt and lets another available credential run. Quota failures wait until the provider-reported retry time or configured period reset; transient failures use bounded exponential cooldown. If every key is unavailable, work waits for the earliest eligible credential instead of permanently disabling the provider.

Official dashboards and response headers override documentation examples. Review current limits when creating a credential and configure its service, quota period, limit, time-zone boundary, and optional shared quota scope in the administrator console.

## Verification checklist

1. Run `npm run check:public` before staging files.
2. Confirm `git diff --cached --name-only` contains no `.env`, database, dump, log, raw response, certificate, or private key.
3. Test each credential from the administrator console without copying its value into logs or screenshots.
4. Keep screenshots masked and rotate any credential that was accidentally displayed.

Official pages checked: 2026-08-03. Provider terms, plans, quotas, and console workflows may change.
