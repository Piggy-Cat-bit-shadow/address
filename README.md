<p align="center"><img src="public/favicon.svg" width="88" height="88" alt="Address logo" /></p>
<h1 align="center">Address</h1>
<p align="center"><strong>Self-hosted Real Residential Address Generator backed by PostgreSQL</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/Live-address.333186.xyz-1769e0" alt="Live demo" /></a>
</p>

**Address is a real residential address generator.** Its published residential base addresses come from official open data, national or regional address registers, map-registered buildings, and open-map records with explicit residential evidence. It does not pass randomly assembled streets, house numbers, or postcodes off as real addresses. Every record retains source coordinates for positioning in services such as Google Maps or AMap where they cover the relevant region; text-search results depend on each platform's coverage, indexed names, and update cycle.

## Highlights

- 27 configured countries and regions with country, administrative-area, city, district, and postcode filters where supported.
- Strict filter semantics: an empty matching pool returns an error instead of silently switching to another location.
- Fast database-backed random selection across the complete eligible scope; it does not repeatedly read the first rows.
- Source/native, English, Simplified Chinese, Traditional Chinese, Japanese, Korean, German, French, Spanish, and Portuguese presentation paths.
- Address and profile language choices persist independently in the browser; first use defaults to English.
- Browser-persistent address favorites with continent/country grouping, filters, drag-and-drop or numeric ordering, copy, delete, and Google Maps/AMap links.
- Popular administrative areas, popular cities, and special areas are configurable per country. The United States includes states without statewide sales tax.
- Public coverage monitor plus administrator dashboard, address-data rules, synchronization queue and history, quick-location editor, provider credentials, access control, blacklist, and API tokens.
- JSON API for health, readiness, countries, availability, location options, search, address/profile generation, batch generation, and monitoring, with Python, cURL, and JavaScript examples.
- PostgreSQL-only runtime with pooled connections, transactional publication, indexed location search, and prebuilt random-address indexes.

## Supported scope

| Region | Countries and regions |
|---|---|
| North America | US, CA, MX |
| Europe | GB, DE, FR, IT, ES, NL, RU |
| East Asia | CN, HK, TW, JP, KR |
| Southeast Asia | SG, MY, TH, PH, VN |
| South Asia | IN |
| Oceania | AU |
| Middle East | TR, SA |
| South America | BR |
| Africa | NG, ZA |

## Real residential address sources and fields

This table reflects the current synchronization implementation. Except for the explicitly identified China indoor fields, the generator does not randomly invent address components. A postcode or administrative area obtained by a unique match against an official directory remains a source-real field. Records missing required fields, conflicting with administrative geography, falling outside valid coordinates, or lacking residential evidence are not published.

| Country/region | Current address sources | Address components | Real/source fields | Synthesized or completed fields | Residential evidence |
|---|---|---|---|---|---|
| United States (US) | Overture Maps and state-level Geofabrik OSM shards | house number, street, city, state, ZIP, coordinates | all address fields and coordinates | none; reversible formatting only | explicit OSM/Overture residential building or use |
| Canada (CA) | Statistics Canada National Address Register, Overture Maps, and Geofabrik OSM | house number, street, city, province, postcode, coordinates | NAR/source address fields and coordinates | none; postcode formatting only | NAR residential building use or explicit map residential use |
| Mexico (MX) | INEGI national address framework; same-origin normalized archive for names only | house number, street, colonia, municipality, state, postcode, coordinates | original INEGI address, administrative, postcode, and coordinate fields | deterministic state/city name mapping only; no address generation | INEGI `TIPODOM=VIVIENDA` |
| United Kingdom (GB) | Geofabrik OSM; Postcodes.io/ONS for validation only | flat/building, house number, street, town, postcode, coordinates | all fields present in OSM and source coordinates | none; formatting only | explicit OSM/building residential use |
| Germany (DE) | Overture Maps, 16 Geofabrik state shards; OpenPLZ assistance | house number, street, city, postcode, coordinates | all address fields and coordinates | none; no invented Wohnung/Etage | explicit residential building or use |
| France (FR) | CSTB BDNB joined to BAN, Overture Maps, and 27 Geofabrik regional shards | house number, street, suffix, commune, postcode, coordinates | BDNB/BAN or map-source address fields and coordinates | none; formatting only | BDNB residential use with a reliable BAN join, or explicit map residential use |
| Italy (IT) | Overture Maps and Geofabrik OSM | house number, street, city, province/region, CAP, coordinates | all address fields and coordinates | none; no invented internal number | explicit residential building or use |
| Spain (ES) | Catastro INSPIRE address/building data, Overture Maps, and Geofabrik OSM | house number, street, municipality, province, postcode, coordinates | Catastro or map-source address fields and coordinates | none; stair/door retained only when sourced | Catastro residential use and dwelling count, or explicit map residential use |
| Netherlands (NL) | Kadaster BAG via PDOK and Overture Maps | house number/letter/addition, street, city, province, postcode, coordinates | all BAG/source address fields and coordinates | none; reversible number formatting only | active BAG `woonfunctie` or explicit Overture residential use |
| Russia (RU) | Geofabrik OSM | house number, street, locality, federal subject, postcode, coordinates | all address fields and coordinates | none; no invented корпус/квартира | explicit OSM residential building |
| China (CN) | AreaCity/StatsGov plus AMap, Baidu, and Tencent residential-community POIs | province, city, district, street/house number, community, building/unit/floor/room, coordinates | administrative areas, community name, street/house number, and provider coordinates | only building, unit, floor, and room are synthesized and marked `synthetic`; no postcode generation | strict residential class, matching district, numeric house number, and institutional blacklist gates |
| Hong Kong (HK) | Housing Authority public-housing units, Buildings Department records, ALS | unit/floor, building, house number, street, locality, 18 districts, region, coordinates | official public-housing or private residential-building fields and coordinates; no general postcode | none | Housing Authority inventory or Buildings Department `Residential/Composite` Tower |
| Taiwan (TW) | Ministry of the Interior transaction records, Chunghwa Post 3+3, local-government address points | house number, road/section/lane/alley, township/district, county/city, postcode, coordinates | residential transaction address, administrative fields, uniquely matched postcode, and coordinates | none; no nearest-point completion | explicit residential primary use and building type in transaction data |
| Japan (JP) | Digital Agency ABR/Geolonia, Japan Post, PLATEAU/MLIT, Geofabrik OSM | prefecture, municipality, town/chome, block/residence number or parcel number, postcode, coordinates | ABR address fields, uniquely matched Japan Post postcode, and source coordinates | none; missing building and room stay empty | address point lies exactly inside a PLATEAU/OSM residential building |
| South Korea (KR) | K-apt, archived Juso/OpenAddresses, Geofabrik/Overture | province/city, city/county/district, town, road, building number, postcode, coordinates | K-apt parcel address or Juso road-address fields and coordinates | none; no invented building, unit, or room | official K-apt complex or Juso point intersecting a residential building |
| Singapore (SG) | HDB Property Information, Existing Building, OneMap, Geofabrik OSM | block number, road, planning town, six-digit postcode, coordinates | HDB block, road, town; uniquely matched OneMap postcode and coordinates | completion only on a unique same-block/same-road match; no house-number generation | HDB `residential=Y` with dwelling units, or an OSM residential building |
| Malaysia (MY) | Geofabrik OSM Malaysia shard | unit/lot, building, street, district, city, state, postcode, coordinates | all fields present in OSM and source coordinates | none; no invented unit | explicit OSM residential building with commercial POIs excluded |
| Thailand (TH) | DPT official building layer and Geofabrik OSM | house number, moo, village/road, subdistrict, district, province, postcode, coordinates | DPT or OSM address, administrative, postcode, and geometry fields | none; polygon-to-point conversion and formatting only | DPT residential building classes or explicit OSM residential building |
| Philippines (PH) | Geofabrik OSM, PHLPost; PSA PSGC for administrative validation only | house number, street, barangay, city/municipality, province, postcode, coordinates | OSM address fields and coordinates | a missing postcode may be completed only by a unique PHLPost province+city/municipality match | explicit OSM residential building |
| Vietnam (VN) | Geofabrik OSM; Google Geocoding enrichment | house number, street, ward/commune, province-level city/province, postcode, coordinates | source fields and coordinates | none; only five-digit postcodes accepted | explicit OSM residential building |
| Türkiye (TR) | Geofabrik OSM and İzmir official Building Identity data | house number, street, district, province, postcode, coordinates | all sourced address fields and coordinates | none; formatting only | OSM residential tag or official `Konut` use |
| Saudi Arabia (SA) | preserved national address points, Overture, Geofabrik OSM | building/house number, street, district, city, postcode, coordinates | national-address point fields and coordinates | none; formatting only | address point exactly associated with an explicit residential building |
| India (IN) | Geofabrik OSM; Mappls Reverse Geocoding; Google Geocoding enrichment | house number, street/locality, district, city, state, PIN, coordinates | OSM residential building, door and street; geocoder administrative fields and PIN | none; no invented apartment or floor | explicit OSM residential building |
| Australia (AU) | Overture Maps and Geofabrik OSM | unit, house number, street, suburb, state, postcode, coordinates | all sourced address fields and coordinates | none; no invented unit | explicit residential building/use; address existence alone is insufficient |
| Brazil (BR) | Geofabrik OSM | house number, street, neighborhood, city, state, CEP, coordinates | all fields present in OSM and source coordinates | none; no invented complemento | explicit OSM residential building |
| Nigeria (NG) | Geofabrik OSM; Google Geocoding enrichment | house number, street, district, city, state, postcode, coordinates | source fields and coordinates | none; missing fields are not inferred | explicit OSM residential building |
| South Africa (ZA) | eThekwini official addresses/zoning, Cape Town official parcels, Geofabrik OSM, SAPO | unit, house number, street, suburb, city, postcode, coordinates | official address/parcel fields, supplemental OSM fields, uniquely matched SAPO postcode, and coordinates | none; no invented unit | exact official residential-zoning association or explicit OSM residential building |

See [data sources](docs/data-sources.md) and the [country/region strategies](docs/strategies/) for source versions, coordinate systems, deduplication, and publication gates.

## Screenshots

<table>
  <tr><th>United States generator</th><th>China generator</th></tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="United States generator" /></td>
    <td><img src="image/webui-cn-overview.png" alt="China generator" /></td>
  </tr>
</table>

### Data monitor

<img src="image/webui-monitor.png" alt="Public address-count and administrative-coverage monitor" />

### Administrator console

<table>
  <tr><th>Dashboard</th><th>Address data</th></tr>
  <tr>
    <td><img src="image/admin-dashboard.png" alt="Administrator dashboard" /></td>
    <td><img src="image/admin-address-data.png" alt="Address data administration" /></td>
  </tr>
  <tr><th>Synchronization queue</th><th>Quick locations</th></tr>
  <tr>
    <td><img src="image/admin-sync-queue.png" alt="Synchronization queue and completion rules" /></td>
    <td><img src="image/admin-quick-locations.png" alt="Quick locations with searchable availability counts" /></td>
  </tr>
</table>

<img src="image/admin-map-keys.png" alt="Masked map-key and quota administration" />

## Architecture

```text
Astro static pages + React UI
             │
             ▼
       Hono Node.js API
        ├─ PostgreSQL address and control data
        ├─ in-memory random/filter indexes rebuilt from PostgreSQL
        └─ local formatting, profile generation, and optional translation

Synchronization supervisor
        ├─ resumable bulk/API adapters
        ├─ country-specific validation and residential evidence gates
        ├─ transactional PostgreSQL publication
        └─ coverage statistics and bounded queue state
```

## Automated synchronization

A country is complete only when every enabled rule passes:

1. total eligible-record target;
2. lowest administrative-level coverage and per-node minimums;
3. level-1 and level-2 minimums where configured;
4. every explicit node override.

Reaching only the total target does not mark a country complete. Conversely, a source proven to be exhausted is kept visible as incomplete but removed from active work until its source/version fingerprint changes.

The queue applies bounded retries, exponential backoff, cooldown/quota reset times, resumable checkpoints, no-progress latching, and suspension after repeated failures. It cannot run the same unchanged no-progress source indefinitely. Run history records each source, duration, result, and address growth, while stale synchronization artifacts are cleaned automatically. China receives the highest automatic priority while it remains eligible.

## Deployment

```bash
git clone https://github.com/daimon3332/address.git
cd address
sh ops/init-compose.sh
docker compose up -d
```

See the [deployment guide](docs/DEPLOYMENT.md) for complete instructions.

## Configuration and API keys

- Frontend and administrator passwords, API tokens, provider credentials, quotas, and quick locations are managed in the administrator console.
- Provider keys are optional unless the selected synchronization strategy needs them.
- Multiple credentials rotate independently. A failing key is cooled down while another available key is tried; when all keys are unavailable, work waits for the earliest reset.
- Follow the dedicated [API key configuration guide](docs/API_KEYS.md) for provider purposes, official application links, and administrator entry names.

## Documentation

| Document | Purpose |
|---|---|
| [API reference](docs/API.md) | Bearer authentication, generation, filtering, errors, and monitoring |
| [API keys](docs/API_KEYS.md) | Provider purpose, registration links, required products, and administrator configuration |
| [Deployment](docs/DEPLOYMENT.md) | PostgreSQL, VPS layout, process control, Nginx, backup, restore, and upgrades |
| [Development](docs/DEVELOPMENT.md) | Architecture, local checks, extension points, and release gates |
| [Address formats](docs/address-formats.md) | Country formatting and field behavior |
| [Country strategies](docs/strategies/) | Source, evidence, coordinates, deduplication, validation, and update policy |

## Community

- [linux.do](https://linux.do): **Learn AI at L-Site!!!**

## License

Project source code is licensed under [MIT](LICENSE). Upstream datasets retain their own licenses and attribution requirements.
