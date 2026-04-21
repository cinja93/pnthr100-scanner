# Legacy Generators — Archived

Archived: 2026-04-20

All generators in this directory are **superseded** and must not be re-run.
They are preserved here for attorney/audit provenance only.

## Archived files and their successors

| Archived | Successor | Reason |
|---|---|---|
| `generateBCDRP.py` | `server/backtest/generateDataRoomDocs.py` (Business Continuity & Disaster Recovery Plan v1.1) | Old 14 KB split file consolidated into v1.1 DR plan |
| `generateCodeOfEthics.py` | `server/backtest/generateDataRoomDocs.py` (Compliance Manual & Code of Ethics v1.1) | Consolidated into single Compliance Manual v1.1 |
| `generatePoliciesProcedures.py` | `server/backtest/generateDataRoomDocs.py` (Compliance Manual & Code of Ethics v1.1) | Consolidated into single Compliance Manual v1.1 |
| `generatePPM.py` | `~/Downloads/generate_ppm_v62.py` (PPM v6.8) | Superseded by PPM v6.8 generator |
| `generateInstitutionalPDF.js` | `server/backtest/generateDataRoomDocs.py` (Fund Intelligence Report v21) | v20 Institutional PDF superseded by v21 consolidated FIR |

## Canonical v21 sources (2026-04-20)

- Performance / FIR / Supporting Docs: `server/backtest/generateDataRoomDocs.py`
- PPM v6.8: `~/Downloads/generate_ppm_v62.py`
- LPA v3.4: `~/Downloads/generate_lpa_v32.py`
- IMA v3.5: `~/Downloads/generate_ima_v34.py`
- LOI v4.2: `~/Downloads/generate_loi_v41.py`
- PPM Complete v3: `~/Downloads/build_ppm_complete.py`
- v21 metrics engine: `server/backtest/computeV21FromDailyNav.js`
- v21 source data snapshot: `server/backtest/versions/v21_source_data/v21_final_2026-04-20-10-19-39.json`

## Do not re-run

Running any archived generator would overwrite current canonical outputs with
stale content (pre-gate-fix numbers, unredacted IP, old document format).
