"""Real machine-learning algorithms in pure Python (no numpy).

- kmeans: Lloyd's algorithm with k-means++-style seeded initialization.
- regression: ordinary least-squares linear regression.
"""
import math
import random
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/ml", tags=["ml"])


class KMeansIn(BaseModel):
    points: List[List[float]] = Field(min_length=1)
    k: int = Field(ge=1)


class RegressionIn(BaseModel):
    x: List[float] = Field(min_length=2)
    y: List[float] = Field(min_length=2)


def _dist2(a: List[float], b: List[float]) -> float:
    return sum((ai - bi) ** 2 for ai, bi in zip(a, b))


@router.post("/kmeans")
def kmeans(payload: KMeansIn):
    points = payload.points
    k = payload.k
    n = len(points)

    for i, p in enumerate(points):
        if len(p) != 2:
            raise HTTPException(
                status_code=422, detail=f"points[{i}] must be a 2D point [x, y]"
            )

    if k > n:
        raise HTTPException(
            status_code=422, detail=f"k ({k}) must be <= number of points ({n})"
        )

    rng = random.Random(42)

    # k-means++ initialization for reproducibility and decent convergence.
    centroids = [list(rng.choice(points))]
    while len(centroids) < k:
        d2 = [min(_dist2(p, c) for c in centroids) for p in points]
        total = sum(d2)
        if total == 0.0:
            centroids.append(list(rng.choice(points)))
            continue
        r = rng.random() * total
        cumulative = 0.0
        chosen = points[-1]
        for p, d in zip(points, d2):
            cumulative += d
            if cumulative >= r:
                chosen = p
                break
        centroids.append(list(chosen))

    assignments = [0] * n
    iterations = 0
    for it in range(100):
        iterations = it + 1
        changed = False
        # Assignment step.
        for i, p in enumerate(points):
            best = min(range(k), key=lambda c: _dist2(p, centroids[c]))
            if best != assignments[i]:
                assignments[i] = best
                changed = True
        # Update step: recompute centroids; re-init empty clusters.
        new_centroids = []
        for c in range(k):
            members = [points[i] for i in range(n) if assignments[i] == c]
            if members:
                new_centroids.append([
                    sum(p[0] for p in members) / len(members),
                    sum(p[1] for p in members) / len(members),
                ])
            else:
                new_centroids.append(list(rng.choice(points)))
        centroids = new_centroids
        if not changed:
            break

    return {
        "assignments": assignments,
        "centroids": centroids,
        "iterations": iterations,
        "k": k,
    }


@router.post("/regression")
def regression(payload: RegressionIn):
    x = payload.x
    y = payload.y

    if len(x) != len(y):
        raise HTTPException(
            status_code=422, detail="x and y must have equal length"
        )
    n = len(x)

    mean_x = sum(x) / n
    mean_y = sum(y) / n

    var_x = sum((xi - mean_x) ** 2 for xi in x)
    if var_x == 0:
        raise HTTPException(
            status_code=422, detail="x has zero variance; cannot fit a line"
        )

    cov = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y))
    slope = cov / var_x
    intercept = mean_y - slope * mean_x

    ss_res = sum((yi - (slope * xi + intercept)) ** 2 for xi, yi in zip(x, y))
    ss_tot = sum((yi - mean_y) ** 2 for yi in y)
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return {
        "slope": slope,
        "intercept": intercept,
        "r_squared": r_squared,
        "n": n,
    }
