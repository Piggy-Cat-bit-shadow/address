# Upstream Sync Contract

Upstream: https://github.com/daimon3332/address  
Fork: https://github.com/Piggy-Cat-bit-shadow/address

## Required flow

```sh
git fetch origin
git fetch upstream
git switch -c chore/sync-upstream-YYYYMMDD
git merge upstream/main
```

Preserve merge ancestry. Do not reset `main`, discard fork commits, force-push, or resolve a large sync directly on `main`.

Upstream-owned `server/**`, database, sync engine, API, Docker, and backend code should normally take the latest upstream implementation. Lite-owned workflows, `config/lite-*`, `scripts/lite/**`, Lite frontend/PWA integration, `ops/address-lite/**`, Lite tests, and these documents must remain intact. Mixed files use upstream as the base with only the smallest necessary Lite integration reapplied.

## Isolation invariant

Address Lite is a credential-free, database-free, runtime-independent Native OSM / Overpass pipeline. New upstream PostgreSQL schemas, source adapters, enrichments, importers, or supervisors are not part of Lite unless explicitly authorized. Upstream-only changes must not alter `refreshFingerprint`; Lite fingerprint tests cover this invariant. Lite source refresh uses Node 24 built-ins and does not install or execute the upstream sync runtime.

After every sync, run repository tests, Lite tests, the Lite active-path reference check, and compare refresh fingerprints before and after the merge. With no Lite-owned input changes, `data_mode=auto` should reuse a compatible Verified Snapshot. Keep Production static: Nginx plus static HTML/CSS/JS/JSON only.
