# Boundary data

## `ghmc-wards.json` — Greater Hyderabad Municipal Corporation wards

© OpenStreetMap contributors. Available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

- **Source:** OpenStreetMap `boundary=administrative`, `admin_level=10` relations, as exported via
  Overpass and published by DataMeet at
  `datameet/Municipal_Spatial_Data/Hyderabad/ghmc-wards.geojson`.
- **Snapshot:** 2018-01-03 (the export's own timestamp). It reflects the 2016 delimitation of
  150 wards.
- **Derived:** simplified with Douglas–Peucker at 0.0001° (~11 m) and rounded to 6 decimals by
  `packages/geo/src/cli/import-ghmc-wards.ts`. That is a derivative database under the ODbL, so it
  keeps the same license and this notice.

### Known gaps

- **145 of 150 wards.** Wards 3, 4, 11, 13, 31 and 113 have no relation in the export. A point in
  one of them resolves to nothing, and the person is asked to pick their ward from the list. That is
  the right failure: a wrong ward is worse than no guess.
- **Ward 37 is claimed twice** (Rein Bazar and Kurmaguda). Wards are keyed by name, so both are
  kept; the number is recorded as the source gives it.
- **The boundaries may be out of date.** Delimitations change, and the corporation's own current
  ward map is authoritative. Before production, reconcile against it and fill the missing wards,
  either in OpenStreetMap (so everyone benefits) or from an officially licensed release.

Any page that shows these boundaries or anything derived from them must display
“© OpenStreetMap contributors”.
