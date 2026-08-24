# Country Address Contracts

Updated: 2026-08-24. This document is the review checklist for the runtime contract in `src/domain/address-contracts.mjs`.

## Administrative abbreviations

The `admin1Code` field is published only for `US`, `CA`, `AU`, `BR`, `MX`, and `IT`. Every published record in those countries must carry the authoritative code and the formatter uses that code in the postal line. All other countries retain the full administrative name; a source-provided road abbreviation may be preserved but is never invented.

## Native scripts

| Code | Native script | Fixed administrative semantics |
|---|---|---|
| CN | Simplified Chinese | province-level, city, district/county |
| HK | Traditional Chinese | area (Hong Kong Island/Kowloon/New Territories), 18 district, locality |
| TW | Traditional Chinese | county/city, township/town/city/district, village/li (optional) |
| JP | Japanese | prefecture, municipality, town/chome |
| KR | Korean | province/metro, si/gun/gu, eup/myeon/dong or road address |
| TH | Thai | changwat, amphoe/khet, tambon/khwaeng |
| SA | Arabic | city, district, additional number |
| RU | Cyrillic | federal subject, locality, street/unit |

## Release gate

Every record must have a house number and street plus the country-specific required fields in `address-contracts.mjs`, valid postcode where required, a coordinate in the country envelope, an official administrative node match, and independent residential evidence. A failed contract is rejected during import and checked again by the read repository. Missing optional facts remain absent; they are never filled from a nearby node.

Native variants must pass the country script gate before publication. Alphanumeric premise identifiers and single-letter building or zone identifiers are allowed when attached to an address component suffix; ordinary foreign-language text is not. English and Simplified Chinese variants are generated during synchronization; the automatic backfill worker repairs legacy untranslated fields in bounded batches and yields while a source sync is active. The public translation endpoint validates every translated component and falls back to the complete native address instead of publishing a mixed-language line.
