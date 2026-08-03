#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/env.sh"

pid_file="$RUNTIME/pids/initial-sync.pid"
trap 'rm -f "$pid_file"' EXIT
cd "$APP"
if [ "$("$NODE" -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.POSTGRES_URL,options:'-c search_path=address,control,public'});p.query('SELECT COUNT(*) AS n FROM catalog_regions').then(r=>console.log(r.rows[0].n)).catch(()=>console.log(0)).finally(()=>p.end())")" = "0" ]; then
  "$NODE" "$APP/scripts/sync-location-catalog.mjs"
  "$NODE" "$APP/scripts/import-location-catalog.mjs"
fi
ADDRESS_SYNC_MODE=initial ADDRESS_SYNC_TRIGGER=initial \
  "$NODE" "$APP/server/sync/address-etl.mjs" --initial --all
"$APP/ops/start.sh"
