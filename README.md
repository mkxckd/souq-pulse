# SouqPulse

An end-to-end data pipeline for property listings: ingestion, entity resolution, an incrementally loaded star-schema warehouse, SQL analytics, and batch plus real-time scoring with a fair-value pricing model.

It's built around three problems a classifieds platform has:
- The same unit gets re-posted by different agents.
- Scam listings are priced too good to be true.
- "Average rent in this area" says little about what one specific unit is worth.

> The dataset is synthetic: 2,629 Dubai-style rental listings. It is **not** real Bayut/Dubizzle data. Duplicate re-posts and lowball fraud listings are injected on purpose, so every stage can be scored against known ground truth.

## Architecture

```
 listings.csv ──► dedup ──► clean training set ──► train model ──► score every listing
  (raw batch)    (blocking,    (1 row per unit,     (GBM, held-out    (out-of-fold, so no
                  gates, TF-IDF, fraud excluded)      test split)        listing is scored by a
                  union-find)                                            model that saw it)
                                                                              │
          ┌───────────────────────────────────────────────────────────────────┤
          ▼                                   ▼                               ▼
  SQLite warehouse (ELT)              real-time scoring               FastAPI service
  staging → dims → fact upsert        per-event inference,           /estimate  /score
  row-hash change detection           latency measured                     │
  soft deletes, etl_runs audit                │                            │
          │                                   ▼                            ▼
          └──► /sql analytics ──────────► dashboard (frontend/) ◄──────────┘
```

## Results

From `python run_pipeline.py` on the committed dataset:

| Stage | Result |
|---|---|
| Duplicate detection | precision **95.5%**, recall **97.1%**, F1 **0.963** (pairwise), 306 clusters, 0.3 s |
| Fair-value model (held-out 20%) | R² **0.966**, MAPE **10.3%**, MAE ≈1,215 AED/month |
| Fraud flag, naive rule (< 65% of area+type median) | precision 87.0%, recall 90.9%, F1 0.889 |
| Fraud flag, model (> 30% below predicted value) | precision **92.9%**, recall **98.5%**, F1 **0.956** |
| Warehouse re-load of an unchanged batch | 0 inserted, 0 updated, 2,629 unchanged |
| Real-time scoring | ~2–3 ms average per listing through the real model |

The fraud comparison is fair to both methods:
- Both are scored against the same ground truth.
- Every listing's predicted price comes from a model trained on *other* folds.
- Folds are grouped by physical unit, so a re-post can't leak its twin's price into training.

Scoring with the final model would give genuine listings in-sample predictions and inflate precision.

### Held-out check of the hand-tuned thresholds

The dedup thresholds and the fraud threshold above were chosen on the same data they're scored on. `python -m pipeline.holdout_eval` tests whether that flattered them. It splits listings **by area** into a tuning half (1,277 listings) and a held-out half (1,352). Duplicates never cross areas, so no pair is split. It then re-tunes each threshold on the tuning half only and scores the held-out half (`results/holdout_evaluation.json`):

| | Held-out precision | Held-out recall | Held-out F1 |
|---|---|---|---|
| Dedup, current pipeline thresholds | 94.3% | 97.3% | **0.958** |
| Dedup, thresholds re-tuned on the tuning half | 98.6% | 98.6% | **0.986** |
| Fraud flag, naive rule | 89.5% | 91.9% | 0.907 |
| Fraud flag, model at the current −30% threshold | 92.5% | 100% | **0.961** |
| Fraud flag, model at the threshold re-tuned on the tuning half (−35%) | 100% | 100% | 1.000 |

The headline numbers hold up on areas the thresholds never saw: dedup F1 0.958 held-out vs 0.963 in-sample, and the model still beats the naive fraud rule. The held-out fraud set has only 37 suspicious listings, so the 1.000 says more about the small sample than about a perfect detector. The pipeline keeps its original thresholds so the headline table stays comparable.

## Data engineering

### Warehouse (`pipeline/etl.py`)

The warehouse is a star schema in SQLite: `fact_listings` plus `dim_area`, `dim_property_type`, `dim_agent` and `dim_date`. It is loaded ELT-style, and each load is **incremental and idempotent**:

1. The batch lands in a staging table.
2. New dimension members are inserted (`INSERT OR IGNORE`).
3. Facts are upserted with `INSERT … ON CONFLICT DO UPDATE`. A per-row hash means unchanged rows aren't rewritten.
4. Listings that disappeared from the source are soft-deleted (`is_active = 0`) rather than dropped.
5. Each run's inserted, updated, unchanged and deactivated counts are written to `etl_runs`.

The whole load runs in one transaction, so a failure leaves the warehouse untouched. A schema version (`PRAGMA user_version`) forces a rebuild if the schema changes.

### SQL analytics (`sql/`)

The dashboard's leaderboard reads from these queries, not from pandas. All four appear on the dashboard next to their results.

| Query | What it shows | Techniques |
|---|---|---|
| `area_leaderboard.sql` | Rent per sqft by area, each duplicate cluster counted once | CTE, `ROW_NUMBER()` window, conditional aggregation |
| `monthly_rent_index.sql` | Monthly rent index with month-over-month change | Window functions (`LAG`), date dimension |
| `agent_repost_rate.sql` | Which agents re-post units that are already listed | Partitioned `ROW_NUMBER()` |
| `model_error_by_segment.sql` | Where the pricing model is weakest | Aggregates over model output in the fact table |

### Data quality

The pipeline checks field completeness and naive exact-match duplicates, both shown in the dashboard's pipeline-health panel. It also shows how much the fuzzy duplicate detection catches beyond what exact matching finds.

### Batch vs. real-time

Training and warehouse loads are batch jobs. `pipeline/streaming_sim.py` replays listings in posting order through the trained model one at a time and measures per-event latency. `api/main.py` serves the same model for live requests.

## Quickstart

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt

python run_pipeline.py            # add --regenerate for a fresh random dataset
pytest                            # 31 tests (API tests need run_pipeline.py first)
python -m pipeline.holdout_eval   # held-out check of the hand-tuned thresholds
uvicorn api.main:app --reload     # API + dashboard at http://localhost:8000
```

Docker trains the model during the image build:

```bash
docker build -t souqpulse .
docker run -p 8000:8000 souqpulse
```

## API

Interactive docs are at `/docs`.

| Endpoint | |
|---|---|
| `GET /health` | Whether the model is loaded, plus the known areas and property types |
| `GET /metrics` | The full `results/evaluation.json` |
| `POST /estimate` | Fair rent for a listing's features |
| `POST /score` | The estimate, plus the residual, `underpriced` / `fair` / `overpriced`, and the fraud flag |

```bash
curl -X POST localhost:8000/score -H "content-type: application/json" \
  -d '{"area":"Palm Jumeirah","property_type":"Villa","size_sqft":4000,"furnished":true,"price_aed_month":20000}'
# -> predicted ≈ 49,650 AED, residual_pct ≈ -0.60, flag "underpriced", suspicious true
```

## Limitations and next steps

- **Synthetic data.** Prices are generated from the same features the model uses, which flatters R². The next step is running the same pipeline on a public Dubai rentals dataset, where fraud labels wouldn't exist but pricing accuracy could be measured honestly.
- **Thresholds** are now checked on held-out areas (see above), but the data is still synthetic and generated by the same process in both halves.
- **SQLite** keeps the project runnable anywhere. The schema and SQL port directly to Postgres, BigQuery or Snowflake, and an orchestrator like Airflow or Dagster would replace `run_pipeline.py`.

## Layout

```
data/generate_data.py        synthetic data generator (ground truth for dedup + fraud)
pipeline/dedup.py            duplicate detection: blocking, geo/price/size gates, TF-IDF, union-find
pipeline/valuation_model.py  fair-value model + out-of-fold scoring
pipeline/evaluate.py         dedup + fraud metrics vs. ground truth, data-quality checks
pipeline/holdout_eval.py     re-tunes thresholds on half the areas, scores the other half
pipeline/streaming_sim.py    real-time scoring latency
pipeline/etl.py              incremental ELT into the SQLite star schema
pipeline/warehouse_queries.py runs /sql against the warehouse for the dashboard
sql/                         analytical queries
run_pipeline.py              runs everything in order
api/main.py                  FastAPI service over the saved model
frontend/                    dashboard (standalone_demo.html is generated; don't edit by hand)
tests/                       pipeline, warehouse and API tests
```
