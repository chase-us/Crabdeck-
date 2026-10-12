from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from storage import Store, new_id, seed_data

seed_data()
contacts_store = Store("contacts.json")
deals_store = Store("deals.json")

router = APIRouter(prefix="/crm", tags=["crm"])

DEAL_STAGES = ["lead", "qualified", "proposal", "won", "lost"]


# ---------- Schemas ----------
class ContactIn(BaseModel):
    name: str = Field(min_length=1)
    email: str = Field(min_length=1)
    company: Optional[str] = None
    notes: Optional[str] = None


class ContactUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    company: Optional[str] = None
    notes: Optional[str] = None


class DealIn(BaseModel):
    title: str = Field(min_length=1)
    value: float = Field(ge=0)
    stage: str


class DealUpdate(BaseModel):
    title: Optional[str] = None
    value: Optional[float] = None
    stage: Optional[str] = None


def _validate_stage(stage: str) -> None:
    if stage not in DEAL_STAGES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid stage {stage!r}; must be one of {DEAL_STAGES}",
        )


# ---------- Contacts ----------
@router.get("/contacts")
def list_contacts():
    return contacts_store.all()


@router.post("/contacts", status_code=201)
def create_contact(payload: ContactIn):
    cid = new_id()
    record = {
        "id": cid,
        "name": payload.name,
        "email": payload.email,
        "company": payload.company,
        "notes": payload.notes,
        "created_at": _now(),
    }
    return contacts_store.create(record)


@router.get("/contacts/{contact_id}")
def get_contact(contact_id: str):
    record = contacts_store.get(contact_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    return record


@router.put("/contacts/{contact_id}")
def update_contact(contact_id: str, payload: ContactUpdate):
    record = contacts_store.get(contact_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    for field in ("name", "email", "company", "notes"):
        value = getattr(payload, field)
        if value is not None:
            if field in ("name", "email") and not value.strip():
                raise HTTPException(status_code=422, detail=f"{field} must not be empty")
            record[field] = value
    return contacts_store.update(contact_id, record)


@router.delete("/contacts/{contact_id}")
def delete_contact(contact_id: str):
    if not contacts_store.delete(contact_id):
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"deleted": True, "id": contact_id}


# ---------- Deals ----------
@router.get("/deals")
def list_deals():
    return deals_store.all()


@router.post("/deals", status_code=201)
def create_deal(payload: DealIn):
    _validate_stage(payload.stage)
    did = new_id()
    record = {
        "id": did,
        "title": payload.title,
        "value": payload.value,
        "stage": payload.stage,
        "created_at": _now(),
    }
    return deals_store.create(record)


@router.get("/deals/{deal_id}")
def get_deal(deal_id: str):
    record = deals_store.get(deal_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Deal not found")
    return record


@router.put("/deals/{deal_id}")
def update_deal(deal_id: str, payload: DealUpdate):
    record = deals_store.get(deal_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Deal not found")
    if payload.stage is not None:
        _validate_stage(payload.stage)
        record["stage"] = payload.stage
    if payload.title is not None:
        if not payload.title.strip():
            raise HTTPException(status_code=422, detail="title must not be empty")
        record["title"] = payload.title
    if payload.value is not None:
        if payload.value < 0:
            raise HTTPException(status_code=422, detail="value must be >= 0")
        record["value"] = payload.value
    return deals_store.update(deal_id, record)


@router.delete("/deals/{deal_id}")
def delete_deal(deal_id: str):
    if not deals_store.delete(deal_id):
        raise HTTPException(status_code=404, detail="Deal not found")
    return {"deleted": True, "id": deal_id}


# ---------- Pipeline ----------
@router.get("/pipeline")
def pipeline():
    stages = {s: {"count": 0, "total_value": 0.0} for s in DEAL_STAGES}
    grand_total = 0.0
    grand_count = 0
    for deal in deals_store.all():
        stage = deal["stage"]
        if stage in stages:
            stages[stage]["count"] += 1
            stages[stage]["total_value"] += deal["value"]
            grand_count += 1
            grand_total += deal["value"]
    for s in stages:
        stages[s]["total_value"] = round(stages[s]["total_value"], 2)
    return {
        "stages": stages,
        "total": {"count": grand_count, "total_value": round(grand_total, 2)},
    }


def _now() -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
