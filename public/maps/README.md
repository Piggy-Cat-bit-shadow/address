# World map asset

`world-map-units.geojson` is derived from Natural Earth 1:110m Admin 0 Map Units and contains only geometry, ISO code candidates, and label coordinates required by the dashboard.

- Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_map_units.geojson
- Dataset: Natural Earth 5.1.1
- License: public domain
- Retrieved: 2026-07-31

`admin-1/{ISO}.geojson` contains simplified first-order administrative boundaries for the 27 supported countries and regions. Files are loaded only after selecting a country or zooming into the world map.

- Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_admin_1_states_provinces.geojson
- Dataset: Natural Earth 5.1.1, Admin-1 States and Provinces
- License: public domain
- Retrieved: 2026-07-31
- Processing: filtered by ISO alpha-2 code, reduced to display fields, topology-preserving simplification at 0.015 degrees
