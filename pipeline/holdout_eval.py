"""Held-out evaluation for the two hand-tuned thresholds in the pipeline.

The main pipeline's dedup thresholds and fraud threshold were chosen on the same data they are scored on, which
can flatter the reported numbers. This script splits the listings by AREA into a tuning half and a held-out half
(duplicates never cross areas, so no pair is split), re-tunes each threshold on the tuning half only, and reports
performance on the held-out half, alongside the pipeline's current hand-set values for comparison.

    python -m pipeline.holdout_eval        # writes results/holdout_evaluation.json
"""
import itertools
import json
import os
import time

import pandas as pd

from pipeline.dedup import DedupParams, find_duplicates
from pipeline.evaluate import _prf, evaluate_dedup, naive_suspicious_flags
from pipeline.valuation_model import get_clean_training_set, score_all_listings_out_of_fold

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_PATH = os.path.join(ROOT, "data", "raw", "listings.csv")
OUT_PATH = os.path.join(ROOT, "results", "holdout_evaluation.json")

DEDUP_GRID = {
    "match_threshold": [0.45, 0.50, 0.55, 0.60, 0.65, 0.70],
    "max_distance_m": [200, 300, 500],
    "min_price_sim": [0.85, 0.90, 0.95],
    "min_size_sim": [0.90, 0.95, 0.98],
}
FRAUD_GRID = [-0.15, -0.20, -0.25, -0.30, -0.35, -0.40, -0.45]
CURRENT_FRAUD_THRESHOLD = -0.30


def split_by_area(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Deterministic split: alternate areas (sorted by name) between tuning and held-out halves."""
    areas = sorted(df["area"].unique())
    tune_areas = set(areas[0::2])
    return df[df["area"].isin(tune_areas)].copy(), df[~df["area"].isin(tune_areas)].copy()


def _dedup_metrics(df, params):
    started = time.time()
    return evaluate_dedup(df, find_duplicates(df, params), time.time() - started)


def tune_dedup(tune_df: pd.DataFrame) -> tuple[DedupParams, dict]:
    best = None
    keys = list(DEDUP_GRID)
    for values in itertools.product(*(DEDUP_GRID[k] for k in keys)):
        params = DedupParams(**dict(zip(keys, values)))
        metrics = _dedup_metrics(tune_df, params)
        if best is None or metrics["f1"] > best[1]["f1"]:
            best = (params, metrics)
    return best


def tune_fraud(df: pd.DataFrame, residuals: pd.Series, truth: pd.Series) -> tuple[float, dict]:
    best = None
    for threshold in FRAUD_GRID:
        flags = (residuals <= threshold).astype(int)
        metrics = _prf(flags, truth)
        if best is None or metrics["f1"] > best[1]["f1"]:
            best = (threshold, metrics)
    return best


def main() -> dict:
    df = pd.read_csv(RAW_PATH)
    tune_df, hold_df = split_by_area(df)
    report = {"split": {"method": "by area, alternating sorted area names",
                        "tune_listings": len(tune_df), "holdout_listings": len(hold_df),
                        "tune_areas": sorted(tune_df["area"].unique()), "holdout_areas": sorted(hold_df["area"].unique())}}

    # 1. Duplicate detection
    params, tune_metrics = tune_dedup(tune_df)
    report["dedup"] = {
        "tuned_params": params.__dict__,
        "tune_split": tune_metrics,
        "holdout_with_tuned_params": _dedup_metrics(hold_df, params),
        "holdout_with_current_params": _dedup_metrics(hold_df, DedupParams()),
    }

    # 2. Fraud flag: residuals are out-of-fold (grouped by unit), exactly as in run_pipeline.py
    dedup_result = find_duplicates(df)
    clean_df = get_clean_training_set(df, dedup_result, naive_suspicious_flags(df))
    scored = score_all_listings_out_of_fold(df, clean_df, dedup_result).set_index("listing_id")
    truth = pd.Series(df["is_suspicious_truth"].values, index=df["listing_id"].values)
    naive = naive_suspicious_flags(df)
    tune_ids, hold_ids = tune_df["listing_id"].values, hold_df["listing_id"].values
    residuals = scored["residual_pct"].reindex(truth.index)
    threshold, fraud_tune = tune_fraud(df, residuals.loc[tune_ids], truth.loc[tune_ids])
    report["fraud"] = {
        "tuned_threshold": threshold,
        "tune_split_model": fraud_tune,
        "holdout_model_tuned_threshold": _prf((residuals.loc[hold_ids] <= threshold).astype(int), truth.loc[hold_ids]),
        "holdout_model_current_threshold": _prf((residuals.loc[hold_ids] <= CURRENT_FRAUD_THRESHOLD).astype(int), truth.loc[hold_ids]),
        "holdout_naive_baseline": _prf(naive.loc[hold_ids], truth.loc[hold_ids]),
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)
    d, fr = report["dedup"], report["fraud"]
    print(f"Split: {len(tune_df)} tuning / {len(hold_df)} held-out listings")
    print(f"Dedup F1  tune {d['tune_split']['f1']:.3f} | held-out (tuned) {d['holdout_with_tuned_params']['f1']:.3f} "
          f"| held-out (current) {d['holdout_with_current_params']['f1']:.3f}")
    print(f"Fraud F1  tune {fr['tune_split_model']['f1']:.3f} | held-out model (tuned {threshold}) "
          f"{fr['holdout_model_tuned_threshold']['f1']:.3f} | held-out model (current) "
          f"{fr['holdout_model_current_threshold']['f1']:.3f} | held-out naive {fr['holdout_naive_baseline']['f1']:.3f}")
    return report


if __name__ == "__main__":
    main()
