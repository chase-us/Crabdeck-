"""Funnel anomaly detection: rolling z-score + CUSUM mean-shift checks.

Pure stdlib (math via statistics). Reads the same funnels.json store as
routers/funnels.py, so the backend must be started with
cwd=~/workspace/crabdeck-omnilayer/backend, exactly like funnels.py.

Method
------
For each funnel stage we build a daily conversion series:

    conversion(date, stage) = unique_visitors(stage, date)
                              / unique_visitors(first_stage, date)

The (date, stage) cell is skipped when the first-stage denominator is 0.

Two detectors run over each stage's sorted-daily series, each using the
strictly-previous up-to-``window_days`` values as the reference window
(at least 2 values required, and the sample stdev must be non-zero):

1. Rolling z-score: z = (x - mean) / stdev (sample stdev via
   statistics.stdev). Emits when abs(z) >= z_threshold.
   Severity: "critical" when abs(z) >= z_threshold * 1.5, else "warning".

2. CUSUM mean-shift: target = window mean, k = 0.5 * stdev, h = 5 * stdev.
   S_h = max(0, S_prev + (x - target - k))
   S_l = min(0, S_prev + (x - target + k))
   Emits (severity "critical", method "cusum") when |S| > h.

When both methods fire on the same (date, stage) the zscore anomaly is kept
and the cusum one is dropped (dedupe).
"""
import statistics
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from storage import Store, seed_data

seed_data()
anomaly_store = Store("funnels.json")

router = APIRouter(prefix="/anomaly", tags=["anomaly"])


class DailyPoint(BaseModel):
    date: str
    stage: str
    conversion: float


class Anomaly(BaseModel):
    date: str
    stage: str
    observed: float
    expected: float
    z_score: float
    severity: str
    method: str


class AnomalyResponse(BaseModel):
    funnel_id: str
    name: str
    window_days: int
    z_threshold: float
    daily_series: List[DailyPoint]
    anomalies: List[Anomaly]


def _daily_conversions(record: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Build per-stage daily conversion cells.

    Returns a list of {"date", "stage", "conversion"} sorted by date, then
    by the funnel's stage order. All counts are unique visitors; every
    number comes from the funnel's event data.
    """
    stages: List[str] = list(record.get("stages") or [])
    if not stages:
        return []
    first_stage = stages[0]
    valid_stages = set(stages)

    # date -> stage -> set(visitor_id)
    per_date: Dict[str, Dict[str, set]] = {}
    for event in record.get("events") or []:
        if not isinstance(event, dict):
            continue
        at = event.get("at")
        stage = event.get("stage")
        visitor = event.get("visitor_id")
        if not isinstance(at, str) or len(at) < 10:
            continue
        if stage not in valid_stages or visitor is None:
            continue
        date = at[0:10]
        per_date.setdefault(date, {}).setdefault(stage, set()).add(visitor)

    series: List[Dict[str, Any]] = []
    for date in sorted(per_date):
        bucket = per_date[date]
        denom = len(bucket.get(first_stage, set()))
        if denom == 0:
            continue
        for stage in stages:
            count = len(bucket.get(stage, set()))
            series.append({
                "date": date,
                "stage": stage,
                "conversion": round(count / denom, 4),
            })
    return series


def _detect_anomalies(
    series: List[Dict[str, Any]],
    stages: List[str],
    window_days: int,
    z_threshold: float,
) -> List[Dict[str, Any]]:
    """Rolling z-score + CUSUM detection per stage, sorted by date then stage."""
    stage_order = {s: i for i, s in enumerate(stages)}
    by_stage: Dict[str, List[Dict[str, Any]]] = {}
    for point in series:
        by_stage.setdefault(point["stage"], []).append(point)

    anomalies: List[Dict[str, Any]] = []
    for stage in stages:
        points = by_stage.get(stage, [])
        s_h = 0.0  # CUSUM upper sum (carried across consecutive days)
        s_l = 0.0  # CUSUM lower sum (carried across consecutive days)
        for i, point in enumerate(points):
            window = [p["conversion"] for p in points[max(0, i - window_days):i]]
            if len(window) < 2:
                continue
            mean = statistics.mean(window)
            stdev = statistics.stdev(window)  # sample stdev
            if stdev == 0:
                continue
            x = point["conversion"]
            z = (x - mean) / stdev

            z_anomaly = None
            if abs(z) >= z_threshold:
                z_anomaly = {
                    "date": point["date"],
                    "stage": stage,
                    "observed": round(x, 4),
                    "expected": round(mean, 4),
                    "z_score": round(z, 4),
                    "severity": "critical" if abs(z) >= z_threshold * 1.5 else "warning",
                    "method": "zscore",
                }

            # CUSUM mean-shift check on the same rolling window.
            k = 0.5 * stdev
            h = 5.0 * stdev
            s_h = max(0.0, s_h + (x - mean - k))
            s_l = min(0.0, s_l + (x - mean + k))

            if z_anomaly is not None:
                anomalies.append(z_anomaly)  # dedupe: keep zscore over cusum
            elif max(abs(s_h), abs(s_l)) > h:
                anomalies.append({
                    "date": point["date"],
                    "stage": stage,
                    "observed": round(x, 4),
                    "expected": round(mean, 4),
                    "z_score": round((x - mean) / stdev, 4),
                    "severity": "critical",
                    "method": "cusum",
                })

    anomalies.sort(key=lambda a: (a["date"], stage_order.get(a["stage"], 0)))
    return anomalies


@router.get("/{funnel_id}", response_model=AnomalyResponse)
def detect_anomalies(
    funnel_id: str,
    window_days: int = Query(7, ge=2, le=90),
    z_threshold: float = Query(3.0, gt=0),
):
    record = anomaly_store.get(funnel_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Funnel not found")

    stages: List[str] = list(record.get("stages") or [])
    series = _daily_conversions(record)
    anomalies = _detect_anomalies(series, stages, window_days, z_threshold)

    return {
        "funnel_id": funnel_id,
        "name": record.get("name", ""),
        "window_days": window_days,
        "z_threshold": z_threshold,
        "daily_series": series,
        "anomalies": anomalies,
    }
