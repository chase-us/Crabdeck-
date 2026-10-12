"""Thread-safe JSON-file persistence for the Crabdeck Omni-Layer backend.

All data lives under backend/data/*.json on the local machine. A single
reentrant lock serializes reads/writes so the ASGI workers stay consistent.
"""
import json
import os
import threading
import time
import uuid

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_LOCK = threading.RLock()


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def seed_data() -> None:
    """Create the data dir and seed JSON files on first run if missing."""
    os.makedirs(DATA_DIR, exist_ok=True)

    contacts_path = os.path.join(DATA_DIR, "contacts.json")
    deals_path = os.path.join(DATA_DIR, "deals.json")
    funnels_path = os.path.join(DATA_DIR, "funnels.json")

    if not os.path.exists(contacts_path):
        contacts = {}
        for name, email, company, notes in [
            ("Ada Lovelace", "ada@example.com", "Analytical Engines Ltd",
             "Interested in the pilot program."),
            ("Grace Hopper", "grace@example.com", "Compiler Co",
             "Requested pricing for the team plan."),
        ]:
            cid = _new_id()
            contacts[cid] = {
                "id": cid,
                "name": name,
                "email": email,
                "company": company,
                "notes": notes,
                "created_at": _iso_now(),
            }
        _write_file(contacts_path, contacts)

    if not os.path.exists(deals_path):
        deals = {}
        for title, value, stage in [
            ("Acme onboarding", 12000.0, "lead"),
            ("Beta rollout", 45000.5, "qualified"),
            ("Enterprise license", 120000.0, "proposal"),
        ]:
            did = _new_id()
            deals[did] = {
                "id": did,
                "title": title,
                "value": value,
                "stage": stage,
                "created_at": _iso_now(),
            }
        _write_file(deals_path, deals)

    if not os.path.exists(funnels_path):
        fid = _new_id()
        _write_file(funnels_path, {
            fid: {
                "id": fid,
                "name": "Website signup",
                "stages": ["visit", "signup", "activate"],
                "created_at": _iso_now(),
                "events": [
                    {"visitor_id": "v-1001", "stage": "visit", "at": _iso_now()},
                    {"visitor_id": "v-1001", "stage": "signup", "at": _iso_now()},
                    {"visitor_id": "v-1002", "stage": "visit", "at": _iso_now()},
                ],
            }
        })


def _new_id() -> str:
    return str(uuid.uuid4())


def new_id() -> str:
    return _new_id()


def _read_file(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_file(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


class Store:
    """A single JSON file of id-keyed records with locking."""

    def __init__(self, filename: str):
        self.path = os.path.join(DATA_DIR, filename)

    def _load(self) -> dict:
        with _LOCK:
            return _read_file(self.path)

    def _save(self, data: dict) -> None:
        with _LOCK:
            _write_file(self.path, data)

    def all(self) -> list:
        return list(self._load().values())

    def get(self, record_id: str):
        return self._load().get(record_id)

    def create(self, record: dict) -> dict:
        data = self._load()
        data[record["id"]] = record
        self._save(data)
        return record

    def update(self, record_id: str, record: dict):
        data = self._load()
        if record_id not in data:
            return None
        data[record_id] = record
        self._save(data)
        return record

    def delete(self, record_id: str) -> bool:
        data = self._load()
        if record_id not in data:
            return False
        del data[record_id]
        self._save(data)
        return True
