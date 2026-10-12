import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from storage import Store, new_id, seed_data

seed_data()
funnels_store = Store("funnels.json")

router = APIRouter(prefix="/funnels", tags=["funnels"])


class FunnelIn(BaseModel):
    name: str = Field(min_length=1)
    stages: List[str] = Field(min_length=1)


class FunnelUpdate(BaseModel):
    name: Optional[str] = None
    stages: Optional[List[str]] = None


class EventIn(BaseModel):
    visitor_id: str = Field(min_length=1)
    stage: str = Field(min_length=1)


def _validate_stages(stages: List[str]) -> None:
    if not stages:
        raise HTTPException(status_code=422, detail="stages must contain at least one stage")
    for s in stages:
        if not isinstance(s, str) or not s.strip():
            raise HTTPException(status_code=422, detail="each stage must be a non-empty string")
    if len(set(stages)) != len(stages):
        raise HTTPException(status_code=422, detail="stage names must be unique")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@router.get("", include_in_schema=True)
@router.get("/", include_in_schema=False)
def list_funnels():
    return funnels_store.all()


@router.post("", status_code=201)
@router.post("/", status_code=201, include_in_schema=False)
def create_funnel(payload: FunnelIn):
    _validate_stages(payload.stages)
    fid = new_id()
    record = {
        "id": fid,
        "name": payload.name,
        "stages": payload.stages,
        "created_at": _now(),
        "events": [],
    }
    return funnels_store.create(record)


@router.get("/{funnel_id}")
def get_funnel(funnel_id: str):
    record = funnels_store.get(funnel_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Funnel not found")
    return record


@router.put("/{funnel_id}")
def update_funnel(funnel_id: str, payload: FunnelUpdate):
    record = funnels_store.get(funnel_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Funnel not found")
    if payload.name is not None:
        if not payload.name.strip():
            raise HTTPException(status_code=422, detail="name must not be empty")
        record["name"] = payload.name
    if payload.stages is not None:
        _validate_stages(payload.stages)
        record["stages"] = payload.stages
    return funnels_store.update(funnel_id, record)


@router.delete("/{funnel_id}")
def delete_funnel(funnel_id: str):
    if not funnels_store.delete(funnel_id):
        raise HTTPException(status_code=404, detail="Funnel not found")
    return {"deleted": True, "id": funnel_id}


@router.post("/{funnel_id}/events", status_code=201)
def record_event(funnel_id: str, payload: EventIn):
    record = funnels_store.get(funnel_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Funnel not found")
    if payload.stage not in record["stages"]:
        raise HTTPException(
            status_code=422,
            detail=f"Stage {payload.stage!r} is not part of this funnel's stages {record['stages']}",
        )
    event = {
        "visitor_id": payload.visitor_id,
        "stage": payload.stage,
        "at": _now(),
    }
    record["events"].append(event)
    funnels_store.update(funnel_id, record)
    return event


@router.get("/{funnel_id}/stats")
def funnel_stats(funnel_id: str):
    record = funnels_store.get(funnel_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Funnel not found")

    stages = record["stages"]
    visitors_per_stage = {s: set() for s in stages}
    for event in record.get("events", []):
        stage = event.get("stage")
        visitor = event.get("visitor_id")
        if stage in visitors_per_stage and visitor is not None:
            visitors_per_stage[stage].add(visitor)

    counts = [len(visitors_per_stage[s]) for s in stages]
    first_count = counts[0] if counts else 0

    result = []
    for i, stage in enumerate(stages):
        count = counts[i]
        if i == 0:
            conv_prev = None
        else:
            prev = counts[i - 1]
            conv_prev = round(count / prev * 100, 1) if prev > 0 else 0.0
        conv_first = round(count / first_count * 100, 1) if first_count > 0 else 0.0
        result.append({
            "stage": stage,
            "count": count,
            "conversion_from_previous": conv_prev,
            "conversion_from_first": conv_first,
        })
    return {"funnel_id": funnel_id, "name": record["name"], "stages": result}
