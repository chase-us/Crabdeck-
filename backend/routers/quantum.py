"""Classical SIMULATIONS of quantum-inspired algorithms.

IMPORTANT: nothing here uses quantum hardware. These endpoints run ordinary
classical algorithms (simulated annealing, closed-form Grover analysis) on the
host machine. Every response carries `"simulated": true` and a plain-language
note saying so.
"""
import math
import random
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/quantum", tags=["quantum"])

SIM_NOTE = "Classical simulation of quantum-inspired algorithms — no quantum hardware."

ANNEAL_BOUND = 5.12


class AnnealIn(BaseModel):
    objective: str
    dims: int = Field(ge=1, le=10)
    iterations: int = Field(ge=1, le=100000)


class GroverIn(BaseModel):
    n_qubits: int = Field(ge=1, le=8)
    target: int = Field(ge=0)


def _rastrigin(xs: List[float]) -> float:
    return sum(xi ** 2 - 10 * math.cos(2 * math.pi * xi) + 10 for xi in xs)


def _sphere(xs: List[float]) -> float:
    return sum(xi ** 2 for xi in xs)


OBJECTIVES = {"rastrigin": _rastrigin, "sphere": _sphere}


@router.get("/info")
def quantum_info():
    return {
        "note": (
            "These endpoints are classical simulations of quantum-inspired "
            "algorithms running on ordinary hardware. No quantum computer "
            "is involved in any of them."
        ),
        "methods": [
            {
                "name": "anneal",
                "description": (
                    "Simulated annealing: classical probabilistic optimization "
                    "with a geometric cooling schedule and Gaussian neighbor "
                    "proposals. Minimizes the Rastrigin or sphere objective "
                    "over [-5.12, 5.12]^dims."
                ),
                "simulated": True,
            },
            {
                "name": "grover",
                "description": (
                    "Closed-form analysis of Grover's search: computes the "
                    "optimal number of iterations and theoretical success "
                    "probability for a given number of qubits and target. "
                    "The math is evaluated classically."
                ),
                "simulated": True,
            },
        ],
        "simulated": True,
    }


@router.post("/anneal")
def anneal(payload: AnnealIn):
    objective_name = payload.objective.lower()
    if objective_name not in OBJECTIVES:
        raise HTTPException(
            status_code=422,
            detail="objective must be one of ['rastrigin', 'sphere']",
        )
    f = OBJECTIVES[objective_name]
    dims = payload.dims
    iterations = payload.iterations

    rng = random.Random(42)  # Seeded for reproducibility.

    def rand_point():
        return [rng.uniform(-ANNEAL_BOUND, ANNEAL_BOUND) for _ in range(dims)]

    current = rand_point()
    current_value = f(current)
    best = list(current)
    best_value = current_value

    t0, t1 = 10.0, 1e-4  # Geometric cooling from t0 to t1.
    sigma = 1.0  # Gaussian neighbor proposal width.

    for it in range(iterations):
        frac = (it + 1) / iterations
        temp = t0 * (t1 / t0) ** frac
        candidate = [
            min(ANNEAL_BOUND, max(-ANNEAL_BOUND, xi + rng.gauss(0, sigma)))
            for xi in current
        ]
        candidate_value = f(candidate)
        delta = candidate_value - current_value
        if delta < 0 or rng.random() < math.exp(-delta / temp):
            current = candidate
            current_value = candidate_value
            if candidate_value < best_value:
                best = list(candidate)
                best_value = candidate_value

    return {
        "objective": objective_name,
        "dims": dims,
        "iterations": iterations,
        "best_solution": best,
        "best_value": best_value,
        "simulated": True,
        "note": "Classical simulated annealing — no quantum hardware.",
    }


@router.post("/grover")
def grover(payload: GroverIn):
    n = payload.n_qubits
    search_space = 2 ** n
    if payload.target >= search_space:
        raise HTTPException(
            status_code=422,
            detail=f"target must satisfy 0 <= target < {search_space} for {n} qubits",
        )

    # Closed-form Grover analysis (classical evaluation of the formulas).
    optimal_iterations = max(1, round(math.pi / 4 * math.sqrt(search_space)))
    theta = math.asin(1 / math.sqrt(search_space))
    success_probability = math.sin((2 * optimal_iterations + 1) * theta) ** 2

    return {
        "n_qubits": n,
        "target": payload.target,
        "search_space": search_space,
        "optimal_iterations": optimal_iterations,
        "success_probability": success_probability,
        "simulated": True,
        "note": "Classical simulation of Grover search mathematics — no quantum hardware.",
    }
