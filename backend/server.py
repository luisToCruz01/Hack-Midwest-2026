"""Closure Call backend.

Python 3.9+ and PostgreSQL. Install the three packages with: pip install -r requirements.txt

Setup
  1. Put this file in backend/, next to your frontend/ and database/ folders.
  2. Put schema_postgres.sql in database/. It is loaded once, the first time the server
     starts against an empty database (it creates all tables and the 6,000 employees).
  3. Set DATABASE_URL to your Postgres connection string (on Render: the Internal URL
     in the service's Environment settings; on your computer: the External URL).
  4. Set MANAGER_IDS to the user IDs allowed to use manager features (comma separated).
  5. python server.py
  6. Load real facility coordinates with load_geo.py (facilities without coordinates are skipped
     by the background scan). Attach email/phone with load_contacts.py (CSV) or
     POST /api/admin/employees/contacts. Add new people with /api/admin/employees/import.

Two notification paths
  Facility path  NWS alerts at a facility -> graded recommendation (pending) -> a manager
                 approves or overrides -> everyone scheduled at that facility is notified.
                 Recommendations are created on demand AND by a background scan
                 (AUTO_SCAN_MINUTES, default 10). With AUTO_DECIDE on (default OFF) the scan
                 sends notifications by itself when confidence is at least AUTO_DECIDE_MIN_CONFIDENCE;
                 lower-confidence ones wait as PENDING for a manager.
                 When the NWS stays quiet for ALL_CLEAR_HOLD_MINUTES after a notice, the same
                 scan sends one all-clear to the people who were told (ALL_CLEAR on/off).
  Personal path  Mobile app posts a location every ~30 s -> NWS lookup for that spot ->
                 if severe, that one person is notified immediately -> if it is a
                 shelter-type emergency, FEMA open shelters are sent as a follow-up.
                 This runs for any consenting employee, wherever they work.

Who can do what
  Any logged-in employee: own profile, location sharing, own notifications and shelters.
  Managers (MANAGER_IDS env var, comma separated): employee roster, recommendations, decisions,
  decision log, facility settings, snapshots, employee import.

Environment (all optional except DATABASE_URL and, for manager features, MANAGER_IDS)
  DATABASE_URL (required), DB_POOL_MAX, HOST, PORT (Render sets PORT), SCHEMA_FILE,
  MANAGER_IDS, SESSION_HOURS, NWS_USER_AGENT, CELL_DEG, AUTO_SCAN_MINUTES (0 turns the scan off),
  AUTO_DECIDE (on/off, default off), AUTO_DECIDE_MIN_CONFIDENCE (low/medium/high),
  ALL_CLEAR (on/off), ALL_CLEAR_HOLD_MINUTES, SNAPSHOT_RETENTION_DAYS,
  API_MIN_INTERVAL_SECONDS, MIN_LOCATION_INTERVAL_SECONDS,
  NOTIFY_WEBHOOK_URL, NOTIFY_WEBHOOK_TOKEN,
  DEMO_GEO (on = seed made-up facility coordinates, testing only),
  DEMO_FLAGS (on = seed two demo essential/no-telework employees, testing only)

Routes
  GET  /api/health
  POST /api/login                          {"userId": "482917"}
  GET  /api/me
  GET  /api/employees                      (manager) roster for the dashboard
  GET  /api/locations                     all work sites for the dashboard map
  GET  /api/weather?locationId=..         selected-site NWS forecast and alerts
  GET  /api/locations/<id>                 PUT (manager): {"lat":..,"lon":..,"tz":"America/Chicago"}
  GET  /api/alerts?lat=..&lon=..
  GET  /api/shelters?lat=..&lon=..
  GET  /api/my/shelters                    nearest open FEMA shelters to my last shared location
  GET  /api/snapshots, /api/snapshots/<id>                  (manager)
  GET  /api/recommendations?status=pending                  (manager)
  POST /api/recommendations                {"locationId": 1}   (manager)
  GET  /api/recommendations/<id>                              (manager)
  POST /api/recommendations/<id>/decision  {"action":"approve"} or
                                           {"action":"override","posture":"...","reason":"..."}
  POST /api/admin/employees/import         {"employees":[{...}]}  add/update people (manager, 5 MB)
  POST /api/admin/employees/contacts       {"employees":[{"userId","email","phone",...}]}  (manager)
  POST /api/location/consent               {"consent": true}
  POST /api/location                       {"lat":..,"lon":..}  (the mobile app calls this)
  GET  /api/my/notifications
  GET  /api/decision-log, /api/decision-log/verify            (manager)
  GET/POST /api/entries
"""
import hashlib
import json
import math
import os
import re
import secrets
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from time import monotonic
from urllib.error import URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg
from psycopg_pool import ConnectionPool


# ======================================================================
# Config
# ======================================================================

def load_env_file():
    """Read KEY=value lines from backend/.env (if it exists) into the environment.
    Real environment variables win, so settings on Render are never overridden."""
    path = Path(__file__).resolve().parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()  # must run before the settings below are read

HERE = Path(__file__).resolve().parent
PROJECT_DIRECTORY = HERE.parent
FRONTEND_DIRECTORY = PROJECT_DIRECTORY / "frontend"
DATABASE_URL = os.environ.get("DATABASE_URL", "")
DB_POOL_MAX = int(os.environ.get("DB_POOL_MAX", "10"))  # keep under your Postgres plan's connection limit


def _is_placeholder_path(value):
    if value is None:
        return False
    value = value.strip()
    if not value:
        return True
    lowered = value.lower().replace("\\", "/")
    return "full/path/to" in lowered or "full\\path\\to" in lowered or lowered.endswith("/schema_postgres.sql") and "full/path/to" in lowered


# Prefer the configured file when it points to a real schema, but ignore the placeholder
# values that show up in sample .env files and fall back to the project layout.
raw_schema_file = os.environ.get("SCHEMA_FILE")
if raw_schema_file and not _is_placeholder_path(raw_schema_file):
    schema_candidate = Path(raw_schema_file).expanduser()
    if schema_candidate.exists():
        SCHEMA_FILE = schema_candidate
    else:
        SCHEMA_FILE = next((p for p in (PROJECT_DIRECTORY / "database" / "schema_postgres.sql", HERE / "schema_postgres.sql") if p.exists()),
                           PROJECT_DIRECTORY / "database" / "schema_postgres.sql")
else:
    SCHEMA_FILE = next((p for p in (PROJECT_DIRECTORY / "database" / "schema_postgres.sql", HERE / "schema_postgres.sql") if p.exists()),
                       PROJECT_DIRECTORY / "database" / "schema_postgres.sql")
# Render needs 0.0.0.0 to reach the app. Locally 127.0.0.1 is safer.
HOST = os.environ.get("HOST", "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1")
PORT = int(os.environ.get("PORT", "3000"))
MAX_REQUEST_BYTES = 16_384
IMPORT_MAX_BYTES = 5_000_000


def env_on(name, default="off"):
    return os.environ.get(name, default).strip().lower() in ("on", "1", "true", "yes")


# Managers are set only through the environment. Whitespace around the commas is ignored.
MANAGER_IDS = {i.strip() for i in os.environ.get("MANAGER_IDS", "").split(",") if i.strip()}
if not MANAGER_IDS:
    print("WARNING: MANAGER_IDS is not set, so nobody can use the manager features.")

SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "12"))

# NWS asks every client to identify itself. Change the email.
NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
NWS_POINTS_URL = "https://api.weather.gov/points"
GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
NWS_HEADERS = {
    "User-Agent": os.environ.get("NWS_USER_AGENT", "ClosureCall/0.1 (your-email@example.com)"),
    "Accept": "application/geo+json",
}
FEMA_SHELTER_URL = "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/FeatureServer/0/query"

# Grid size for employee locations. Smaller = more accurate NWS point lookups, more NWS calls.
# 0.02 degrees is roughly 1.4 miles. Warning polygons can be small, so don't go much bigger.
CELL_DEG = float(os.environ.get("CELL_DEG", "0.02"))
ALERT_CACHE_SECONDS = 300     # one NWS call per grid cell per 5 minutes
SHELTER_CACHE_SECONDS = 600
SHELTER_BUFFER_MILES = 5      # shelters are fetched around the cell center, so pad the radius
LOCATION_TTL_HOURS = 24       # employee locations older than this are deleted
LIVE_LOCATION_MAX_AGE_MINUTES = 5
MIN_LOCATION_INTERVAL_SECONDS = int(os.environ.get("MIN_LOCATION_INTERVAL_SECONDS", "10"))
# Minimum gap between calls to /api/alerts and /api/shelters per logged-in user.
API_MIN_INTERVAL_SECONDS = int(os.environ.get("API_MIN_INTERVAL_SECONDS", "5"))
# Raw NWS snapshots older than this are deleted, unless a recommendation points at them.
SNAPSHOT_RETENTION_DAYS = int(os.environ.get("SNAPSHOT_RETENTION_DAYS", "30"))

AUTO_SCAN_MINUTES = int(os.environ.get("AUTO_SCAN_MINUTES", "10"))
# When on, the background scan sends facility notifications by itself, with no manager step.
# Default is OFF: review the rules first, then switch it on with AUTO_DECIDE=on.
# Only recommendations at or above the confidence below are sent automatically (high = alert
# Observed, medium = Likely, low = Possible). Anything lower waits for a manager.
AUTO_DECIDE = env_on("AUTO_DECIDE", "off")
AUTO_DECIDE_MIN_CONFIDENCE = os.environ.get("AUTO_DECIDE_MIN_CONFIDENCE", "medium").strip().lower()
CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}
AUTO_SCAN_REPEAT_HOURS = 6    # don't re-recommend the same posture for a facility sooner than this

# All-clear: after a notice, the NWS must stay quiet this long before "normal operations may resume" goes out.
ALL_CLEAR = env_on("ALL_CLEAR", "on")
ALL_CLEAR_HOLD_MINUTES = int(os.environ.get("ALL_CLEAR_HOLD_MINUTES", "20"))

# Where real push/SMS/email delivery happens. If unset, notifications are only recorded
# with status 'simulated'. If set, each notification is POSTed there as JSON.
NOTIFY_WEBHOOK_URL = os.environ.get("NOTIFY_WEBHOOK_URL", "")
NOTIFY_WEBHOOK_TOKEN = os.environ.get("NOTIFY_WEBHOOK_TOKEN", "")


# ======================================================================
# Database
# ======================================================================

APP_SCHEMA = """
CREATE TABLE IF NOT EXISTS location_geo (
    location_id INTEGER PRIMARY KEY REFERENCES locations(location_id),
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    tz TEXT NOT NULL DEFAULT 'UTC'
);
CREATE TABLE IF NOT EXISTS employee_flags (
    user_id TEXT PRIMARY KEY REFERENCES employees(user_id),
    is_essential INTEGER NOT NULL DEFAULT 0,
    telework_eligible INTEGER NOT NULL DEFAULT 1,
    email TEXT,
    phone TEXT,
    location_consent INTEGER NOT NULL DEFAULT 0,
    email_notifications_enabled INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE employee_flags ADD COLUMN IF NOT EXISTS email_notifications_enabled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS employee_location (
    user_id TEXT PRIMARY KEY REFERENCES employees(user_id),
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    cell TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    fetched_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    raw_json TEXT
);
CREATE TABLE IF NOT EXISTS recommendations (
    id SERIAL PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES locations(location_id),
    created_at TEXT NOT NULL,
    posture TEXT NOT NULL,
    confidence TEXT NOT NULL,
    snapshot_id INTEGER REFERENCES snapshots(id),
    rules_version TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    final_posture TEXT,
    decided_by TEXT,
    decided_at TEXT,
    decision_reason TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,              -- 'facility', 'personal', 'shelter' or 'all_clear'
    user_id TEXT NOT NULL REFERENCES employees(user_id),
    recommendation_id INTEGER REFERENCES recommendations(id),
    alert_id TEXT,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL             -- 'simulated', 'sent' or 'failed'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_personal_alert
    ON notifications(user_id, alert_id) WHERE alert_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS decision_log (
    id SERIAL PRIMARY KEY,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    id SERIAL PRIMARY KEY,
    employee_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL
);
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS cleared_at TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS clear_seen_at TEXT;
"""

# Synthetic coordinates, used ONLY when DEMO_GEO=on (testing). Real deployments load real
# coordinates with load_geo.py.
DEMO_CITIES = [
    ("Des Moines", 41.5868, -93.6250, "America/Chicago"),
    ("Kansas City", 39.0997, -94.5786, "America/Chicago"),
    ("Houston", 29.7604, -95.3698, "America/Chicago"),
    ("New Orleans", 29.9511, -90.0715, "America/Chicago"),
    ("Little Rock", 34.7465, -92.2896, "America/Chicago"),
    ("Jackson", 32.2988, -90.1848, "America/Chicago"),
    ("Omaha", 41.2565, -95.9345, "America/Chicago"),
    ("Minneapolis", 44.9778, -93.2650, "America/Chicago"),
    ("Denver", 39.7392, -104.9903, "America/Denver"),
    ("Boise", 43.6150, -116.2023, "America/Boise"),
    ("Missoula", 46.8721, -113.9940, "America/Denver"),
    ("Phoenix", 33.4484, -112.0740, "America/Phoenix"),
    ("Albuquerque", 35.0844, -106.6504, "America/Denver"),
    ("Sacramento", 38.5816, -121.4944, "America/Los_Angeles"),
    ("Portland", 45.5152, -122.6784, "America/Los_Angeles"),
    ("Raleigh", 35.7796, -78.6382, "America/New_York"),
    ("Atlanta", 33.7490, -84.3880, "America/New_York"),
    ("Miami", 25.7617, -80.1918, "America/New_York"),
    ("Buffalo", 42.8864, -78.8784, "America/New_York"),
    ("Albany", 42.6526, -73.7562, "America/New_York"),
]
# Demo flags for facility 1 only (used only when DEMO_FLAGS=on). Replace with real HR data.
DEMO_ESSENTIAL_IDS = ("482917", "305764")
DEMO_NO_TELEWORK_IDS = ("926541",)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Row(tuple):
    """A result row you can read by position (row[0]) or by column name (row["name"])."""

    def __new__(cls, names, values):
        obj = super().__new__(cls, values)
        obj._names = names
        return obj

    def __getitem__(self, key):
        if isinstance(key, str):
            try:
                return tuple.__getitem__(self, self._names.index(key))
            except ValueError:
                raise KeyError(key) from None
        return tuple.__getitem__(self, key)

    def keys(self):
        return list(self._names)


def row_factory(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: Row(names, values)


class Db:
    """Thin wrapper so the SQL in this file can keep using ? placeholders."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return self._conn.execute(sql.replace("?", "%s"), params)

    def script(self, sql):
        """Run several statements at once (no parameters)."""
        self._conn.execute(sql)


_pool = None
_pool_lock = Lock()


def get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            if not DATABASE_URL:
                raise SystemExit("DATABASE_URL is not set. Set it to your Postgres connection string.")
            _pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=DB_POOL_MAX, timeout=30,
                                   kwargs={"row_factory": row_factory}, open=True)
        return _pool


@contextmanager
def get_db():
    """One transaction: commits on success, rolls back on error, then returns the connection."""
    with get_pool().connection() as conn:
        yield Db(conn)


def init_db():
    with get_db() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(7000)")  # two instances starting together take turns
        has_employees = conn.execute("SELECT to_regclass('public.employees') IS NOT NULL").fetchone()[0]
        if not has_employees:
            if not SCHEMA_FILE.exists():
                raise SystemExit(f"Missing {SCHEMA_FILE}. Put schema_postgres.sql there and run again.")
            conn.script(SCHEMA_FILE.read_text(encoding="utf-8"))
        conn.script(APP_SCHEMA)

        # Made-up coordinates are only for testing. Real ones come from load_geo.py.
        if env_on("DEMO_GEO") and conn.execute("SELECT COUNT(*) FROM location_geo").fetchone()[0] == 0:
            for (location_id,) in conn.execute("SELECT location_id FROM locations ORDER BY location_id").fetchall():
                city, lat, lon, tz = DEMO_CITIES[(location_id - 1) % len(DEMO_CITIES)]
                shift = ((location_id - 1) // len(DEMO_CITIES)) * 0.05
                conn.execute(
                    "INSERT INTO location_geo (location_id, lat, lon, tz) VALUES (?, ?, ?, ?)",
                    (location_id, round(lat + shift, 4), round(lon + shift, 4), tz),
                )

        if env_on("DEMO_FLAGS") and conn.execute("SELECT COUNT(*) FROM employee_flags").fetchone()[0] == 0:
            for user_id in DEMO_ESSENTIAL_IDS:
                conn.execute("INSERT INTO employee_flags (user_id, is_essential) "
                             "SELECT user_id, 1 FROM employees WHERE user_id = ? "
                             "ON CONFLICT (user_id) DO NOTHING", (user_id,))
            for user_id in DEMO_NO_TELEWORK_IDS:
                conn.execute("INSERT INTO employee_flags (user_id, telework_eligible) "
                             "SELECT user_id, 0 FROM employees WHERE user_id = ? "
                             "ON CONFLICT (user_id) DO NOTHING", (user_id,))

        # Privacy: snapshots from people's own locations used to store coordinates. Only facility
        # snapshots (whose coordinates match a facility) keep them. Safe to run on every start.
        conn.execute("UPDATE snapshots SET lat = NULL, lon = NULL WHERE lat IS NOT NULL AND NOT EXISTS "
                     "(SELECT 1 FROM location_geo g WHERE g.lat = snapshots.lat AND g.lon = snapshots.lon)")


# ======================================================================
# Employee import (names from your Render database or a CSV)
# ======================================================================

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
USER_ID_RE = re.compile(r"^[0-9]{6}$")  # the schema requires exactly six digits
VALID_DAYS = {"Mon-Fri", "Mon-Thu", "Tue-Sat", "Wed-Sun", "Tue-Fri", "Sun-Thu"}  # schema CHECK list
PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")
TRUTHY = {"1", "true", "yes", "y", "t"}


def to_flag(value):
    """Accept True/False, 1/0 or 'yes'/'no'. Returns None when the value is missing."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    return 1 if str(value).strip().lower() in TRUTHY else 0


def clean_employee(rec):
    """Validate one incoming record. Returns (cleaned, None) or (None, error message)."""
    if not isinstance(rec, dict):
        return None, "record is not an object"
    user_id = str(rec.get("userId", rec.get("user_id", ""))).strip()
    name = str(rec.get("fullName", rec.get("full_name", ""))).strip()
    if not name or not USER_ID_RE.match(user_id):
        return None, f"{user_id or '(blank)'}: userId must be 6 digits and fullName is required"
    try:
        location_id = int(rec.get("locationId", rec.get("location_id")))
    except (TypeError, ValueError):
        return None, f"{user_id}: locationId must be a whole number"
    start = str(rec.get("shiftStart", rec.get("shift_start", "08:00"))).strip()
    end = str(rec.get("shiftEnd", rec.get("shift_end", "17:00"))).strip()
    days = str(rec.get("daysOfWeek", rec.get("days_of_week", "Mon-Fri"))).strip()
    if not TIME_RE.match(start) or not TIME_RE.match(end) or end <= start:
        return None, f"{user_id}: shift times must look like 08:00 and end after they start"
    if days not in VALID_DAYS:
        return None, f"{user_id}: daysOfWeek must be one of {sorted(VALID_DAYS)}"
    phone = rec.get("phone")
    phone = re.sub(r"[\s().-]", "", str(phone)) if phone else None
    if phone and not PHONE_RE.match(phone):
        return None, f"{user_id}: phone number is not valid"
    email = str(rec["email"]).strip() if rec.get("email") else None
    if email and "@" not in email:
        return None, f"{user_id}: email is not valid"
    return {
        "user_id": user_id, "full_name": name, "location_id": location_id,
        "shift_start": start, "shift_end": end, "days_of_week": days,
        "email": email, "phone": phone,
        "is_essential": to_flag(rec.get("isEssential", rec.get("is_essential"))),
        "telework_eligible": to_flag(rec.get("teleworkEligible", rec.get("telework_eligible"))),
    }, None


def upsert_employees(records):
    """Insert or update employees and their contact flags.

    Safe to run repeatedly. It never touches location_consent, so a re-sync does not
    switch anyone's location sharing on or off. Fields left out of a record are left alone.
    """
    summary = {"received": len(records), "added": 0, "updated": 0, "rejected": []}
    with get_db() as conn:
        known_locations = {r[0] for r in conn.execute("SELECT location_id FROM locations")}
        for rec in records:
            emp, error = clean_employee(rec)
            if error:
                summary["rejected"].append(error)
                continue
            if emp["location_id"] not in known_locations:
                summary["rejected"].append(f"{emp['user_id']}: unknown locationId {emp['location_id']}")
                continue

            existed = conn.execute("SELECT 1 FROM employees WHERE user_id = ?", (emp["user_id"],)).fetchone()
            conn.execute(
                "INSERT INTO employees (user_id, full_name, location_id, shift_start, shift_end, days_of_week) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET "
                "full_name = excluded.full_name, location_id = excluded.location_id, "
                "shift_start = excluded.shift_start, shift_end = excluded.shift_end, "
                "days_of_week = excluded.days_of_week",
                (emp["user_id"], emp["full_name"], emp["location_id"], emp["shift_start"],
                 emp["shift_end"], emp["days_of_week"]),
            )
            summary["updated" if existed else "added"] += 1

            if conn.execute("SELECT 1 FROM employee_flags WHERE user_id = ?", (emp["user_id"],)).fetchone():
                conn.execute(
                    "UPDATE employee_flags SET email = COALESCE(?, email), phone = COALESCE(?, phone), "
                    "is_essential = COALESCE(?, is_essential), "
                    "telework_eligible = COALESCE(?, telework_eligible) WHERE user_id = ?",
                    (emp["email"], emp["phone"], emp["is_essential"], emp["telework_eligible"], emp["user_id"]),
                )
            else:
                conn.execute(
                    "INSERT INTO employee_flags (user_id, is_essential, telework_eligible, email, phone) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (emp["user_id"], emp["is_essential"] or 0,
                     1 if emp["telework_eligible"] is None else emp["telework_eligible"],
                     emp["email"], emp["phone"]),
                )
    summary["rejectedCount"] = len(summary["rejected"])
    summary["rejected"] = summary["rejected"][:50]  # keep responses small
    return summary


def update_contacts(records):
    """Set email, phone and the essential/telework flags for people already in the employees table.

    Your names are already loaded from the schema; this is how email/phone get attached so the
    sms and email channels have somewhere to go. Missing fields are left unchanged.
    """
    summary = {"received": len(records), "updated": 0, "rejected": []}
    with get_db() as conn:
        for rec in records:
            if not isinstance(rec, dict):
                summary["rejected"].append("record is not an object")
                continue
            user_id = str(rec.get("userId", rec.get("user_id", ""))).strip()
            phone = rec.get("phone")
            phone = re.sub(r"[\s().-]", "", str(phone)) if phone else None
            email = str(rec["email"]).strip() if rec.get("email") else None
            if phone and not PHONE_RE.match(phone):
                summary["rejected"].append(f"{user_id}: phone number is not valid")
                continue
            if email and "@" not in email:
                summary["rejected"].append(f"{user_id}: email is not valid")
                continue
            if not conn.execute("SELECT 1 FROM employees WHERE user_id = ?", (user_id,)).fetchone():
                summary["rejected"].append(f"{user_id}: no such employee")
                continue
            essential = to_flag(rec.get("isEssential", rec.get("is_essential")))
            telework = to_flag(rec.get("teleworkEligible", rec.get("telework_eligible")))
            conn.execute("INSERT INTO employee_flags (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING", (user_id,))
            conn.execute(
                "UPDATE employee_flags SET email = COALESCE(?, email), phone = COALESCE(?, phone), "
                "is_essential = COALESCE(?, is_essential), telework_eligible = COALESCE(?, telework_eligible) "
                "WHERE user_id = ?", (email, phone, essential, telework, user_id))
            summary["updated"] += 1
    summary["rejectedCount"] = len(summary["rejected"])
    summary["rejected"] = summary["rejected"][:50]
    return summary


# ======================================================================
# Decision log (append-only, hash chained)
# ======================================================================

log_lock = Lock()


def _hash(prev_hash, ts, kind, body):
    return hashlib.sha256(f"{prev_hash}|{ts}|{kind}|{body}".encode("utf-8")).hexdigest()


def append_log(kind, payload):
    """Add one entry. Each entry's hash covers the previous hash, so edits are detectable."""
    with log_lock, get_db() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(7001)")  # keeps the chain intact across instances
        row = conn.execute("SELECT hash FROM decision_log ORDER BY id DESC LIMIT 1").fetchone()
        prev_hash = row["hash"] if row else "GENESIS"
        ts = now_iso()
        body = json.dumps(payload, sort_keys=True)
        conn.execute(
            "INSERT INTO decision_log (ts, kind, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?)",
            (ts, kind, body, prev_hash, _hash(prev_hash, ts, kind, body)),
        )


def verify_log():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM decision_log ORDER BY id").fetchall()
    prev_hash = "GENESIS"
    for row in rows:
        expected = _hash(prev_hash, row["ts"], row["kind"], row["payload_json"])
        if row["prev_hash"] != prev_hash or row["hash"] != expected:
            return {"ok": False, "entries": len(rows), "brokenAtId": row["id"]}
        prev_hash = row["hash"]
    return {"ok": True, "entries": len(rows), "brokenAtId": None}


# ======================================================================
# NWS ingest
# ======================================================================

def fetch_nws_alerts(lat, lon):
    """Return a snapshot dict. Failures are recorded, not hidden."""
    fetched_at = now_iso()
    url = f"{NWS_ALERTS_URL}?{urlencode({'point': f'{lat},{lon}'})}"
    try:
        with urlopen(Request(url, headers=NWS_HEADERS), timeout=10) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        return {"source": "nws_alerts", "ok": True, "fetched_at": fetched_at,
                "error": None, "raw": raw}
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError, OSError) as err:
        return {"source": "nws_alerts", "ok": False, "fetched_at": fetched_at,
                "error": str(err), "raw": None}


def fetch_nws_json(url):
    with urlopen(Request(url, headers=NWS_HEADERS), timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("The National Weather Service returned an invalid response.")
    return data


geocode_cache = {}
geocode_cache_lock = Lock()
nominatim_lock = Lock()
last_nominatim_request = 0.0


def geocode_location(address, location_id):
    global last_nominatim_request

    with geocode_cache_lock:
        cached = geocode_cache.get(location_id)
    if cached:
        return cached

    census_query = urlencode({
        'address': address,
        'benchmark': 'Public_AR_Current',
        'format': 'json',
    })
    census_url = f"{GEOCODER_URL}?{census_query}"
    with urlopen(Request(census_url, headers={"User-Agent": NWS_HEADERS["User-Agent"]}), timeout=15) as resp:
        census_data = json.loads(resp.read().decode("utf-8"))
    if not isinstance(census_data, dict):
        raise ValueError("Census Geocoder returned an invalid response.")
    census_result = census_data.get("result")
    if not isinstance(census_result, dict):
        raise ValueError("Census Geocoder returned an invalid result.")
    matches = census_result.get("addressMatches", [])
    if matches:
        match = matches[0]
        if not isinstance(match, dict) or not isinstance(match.get("coordinates"), dict):
            raise ValueError("Census Geocoder returned invalid coordinates.")
        coordinates = match["coordinates"]
        result = {
            "latitude": float(coordinates["y"]),
            "longitude": float(coordinates["x"]),
            "matchedAddress": matches[0].get("matchedAddress", address),
            "precision": "address",
        }
    else:
        address_parts = [part.strip() for part in address.split(",")]
        if len(address_parts) < 2 or not address_parts[1]:
            raise LookupError("The selected address could not be geocoded.")
        locality = ", ".join(address_parts[1:])
        nominatim_url = "https://nominatim.openstreetmap.org/search?" + urlencode({
            "q": locality,
            "format": "jsonv2",
            "limit": 1,
            "countrycodes": "us",
        })
        with nominatim_lock:
            wait_seconds = 1.0 - (monotonic() - last_nominatim_request)
            if wait_seconds > 0:
                time.sleep(wait_seconds)
            with urlopen(Request(nominatim_url, headers={
                "User-Agent": "FieldcastAdminDashboard/1.0",
                "Accept": "application/json",
            }), timeout=15) as resp:
                nominatim_data = json.loads(resp.read().decode("utf-8"))
            last_nominatim_request = monotonic()
        if not isinstance(nominatim_data, list) or not nominatim_data:
            raise LookupError("The selected address and its locality could not be geocoded.")
        locality_match = nominatim_data[0]
        if not isinstance(locality_match, dict):
            raise ValueError("OpenStreetMap Nominatim returned an invalid result.")
        result = {
            "latitude": float(locality_match["lat"]),
            "longitude": float(locality_match["lon"]),
            "matchedAddress": locality_match.get("display_name", locality),
            "precision": "locality",
        }

    if not (-90 <= result["latitude"] <= 90 and -180 <= result["longitude"] <= 180):
        raise ValueError("Geocoder returned coordinates outside valid ranges.")
    result["latitude"] = round(result["latitude"], 4)
    result["longitude"] = round(result["longitude"], 4)
    with geocode_cache_lock:
        geocode_cache[location_id] = result
    return result


weather_cache = {}
weather_cache_lock = Lock()


def summarize_alerts(raw):
    """Pull out the fields the rules engine cares about. Test/exercise alerts are skipped."""
    if not raw:
        return []
    alerts = []
    for feature in raw.get("features", []):
        p = feature.get("properties", {})
        if p.get("status") not in (None, "Actual"):
            continue
        alerts.append({
            "id": p.get("id") or feature.get("id"),
            "event": p.get("event"),
            "severity": p.get("severity"),    # Minor / Moderate / Severe / Extreme
            "certainty": p.get("certainty"),  # Possible / Likely / Observed ...
            "urgency": p.get("urgency"),      # Future / Expected / Immediate ...
            "effective": p.get("effective"),
            "expires": p.get("expires"),
            "headline": p.get("headline"),
            "area": p.get("areaDesc"),
        })
    return alerts


def save_snapshot(snapshot, lat, lon):
    """Store one NWS fetch. Pass lat=None, lon=None for anything tied to a person's position."""
    with get_db() as conn:
        return conn.execute(
            "INSERT INTO snapshots (source, lat, lon, fetched_at, ok, error, raw_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (snapshot["source"], lat, lon, snapshot["fetched_at"],
             1 if snapshot["ok"] else 0, snapshot["error"],
             json.dumps(snapshot["raw"]) if snapshot["raw"] is not None else None),
        ).fetchone()[0]


def cell_key(lat, lon):
    """Round a location to a grid cell so people nearby share one NWS lookup."""
    iy, ix = round(lat / CELL_DEG), round(lon / CELL_DEG)
    return f"{iy}:{ix}", round(iy * CELL_DEG, 4), round(ix * CELL_DEG, 4)


alert_cache = {}
alert_cache_lock = Lock()
cell_fetch_locks = {}  # one lock per cell so 500 people in one place cause one NWS call


def get_cell_alerts(key, lat, lon):
    """Cached NWS lookup for a grid cell. Only real fetches create snapshots."""
    def cached():
        with alert_cache_lock:
            hit = alert_cache.get(key)
            if hit and monotonic() - hit["at"] < ALERT_CACHE_SECONDS:
                return hit["value"]
        return None

    value = cached()
    if value:
        return value
    with alert_cache_lock:
        lock = cell_fetch_locks.setdefault(key, Lock())
    with lock:
        value = cached()  # someone else may have filled it while we waited
        if value:
            return value
        snapshot = fetch_nws_alerts(lat, lon)
        # Cell lookups come from people's phones, so the snapshot keeps no coordinates.
        snapshot_id = save_snapshot(snapshot, None, None)
        value = {"ok": snapshot["ok"], "fetchedAt": snapshot["fetched_at"],
                 "snapshotId": snapshot_id, "alerts": summarize_alerts(snapshot["raw"])}
        if snapshot["ok"]:  # don't cache failures, so the next request retries
            with alert_cache_lock:
                alert_cache[key] = {"at": monotonic(), "value": value}
        return value


# ======================================================================
# Per-user rate limit (for endpoints that trigger outside calls)
# ======================================================================

rate_marks = {}  # (user_id, bucket) -> monotonic time of last allowed call
rate_lock = Lock()


def too_fast(user_id, bucket, seconds):
    """True if this user called this bucket less than `seconds` ago. Otherwise records the call."""
    now = monotonic()
    with rate_lock:
        last = rate_marks.get((user_id, bucket))
        if last is not None and now - last < seconds:
            return True
        rate_marks[(user_id, bucket)] = now
        return False


# ======================================================================
# FEMA shelters
# ======================================================================

def haversine_miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


shelter_cache = {}
shelter_cache_lock = Lock()


def fetch_shelters(lat, lon, radius_miles=50, limit=3):
    """Nearest open shelters from FEMA. Usually empty unless a major event is under way.

    The FEMA call is made once per grid cell and cached; distances are then worked out
    from the caller's exact position, so people in the same cell still get correct miles.
    """
    key, clat, clon = cell_key(lat, lon)
    with shelter_cache_lock:
        hit = shelter_cache.get(key)
    fresh = hit and monotonic() - hit["at"] < SHELTER_CACHE_SECONDS

    if not fresh:
        params = {
            "where": "1=1", "geometry": f"{clon},{clat}", "geometryType": "esriGeometryPoint",
            "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
            "distance": str(radius_miles + SHELTER_BUFFER_MILES), "units": "esriSRUnit_StatuteMile",
            "outFields": "*", "returnGeometry": "true", "outSR": "4326", "f": "json",
        }
        try:
            with urlopen(Request(f"{FEMA_SHELTER_URL}?{urlencode(params)}"), timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (URLError, TimeoutError, json.JSONDecodeError, ValueError, OSError) as err:
            return {"ok": False, "shelters": [], "error": str(err), "fetchedAt": now_iso()}
        found = []
        for feature in data.get("features", []):
            a, g = feature.get("attributes", {}), feature.get("geometry") or {}
            if a.get("SHELTER_STATUS_CODE") not in (None, "OPEN") or "x" not in g:
                continue
            found.append({"name": a.get("SHELTER_NAME"), "address": a.get("ADDRESS"),
                          "city": a.get("CITY"), "state": a.get("STATE"),
                          "lat": g["y"], "lon": g["x"]})
        hit = {"at": monotonic(), "shelters": found, "fetchedAt": now_iso()}
        with shelter_cache_lock:
            shelter_cache[key] = hit

    shelters = []
    for s in hit["shelters"]:
        miles = round(haversine_miles(lat, lon, s["lat"], s["lon"]), 1)
        if miles <= radius_miles:
            shelters.append({**s, "miles": miles})
    shelters.sort(key=lambda s: s["miles"])
    return {"ok": True, "shelters": shelters[:limit], "fetchedAt": hit["fetchedAt"]}


# ======================================================================
# Housekeeping (keeps tables and in-memory caches from growing forever)
# ======================================================================

def prune_caches():
    """Drop expired cache entries, idle per-cell locks, old rate-limit marks and expired sessions."""
    now = monotonic()
    with alert_cache_lock:
        for k in [k for k, v in alert_cache.items() if now - v["at"] > ALERT_CACHE_SECONDS]:
            del alert_cache[k]
        for k in [k for k, lock in cell_fetch_locks.items() if k not in alert_cache and not lock.locked()]:
            del cell_fetch_locks[k]
    with shelter_cache_lock:
        for k in [k for k, v in shelter_cache.items() if now - v["at"] > SHELTER_CACHE_SECONDS]:
            del shelter_cache[k]
    with rate_lock:
        for k in [k for k, t in rate_marks.items() if now - t > 3600]:
            del rate_marks[k]
    with sessions_lock:
        for k in [k for k, (_user, expires) in sessions.items() if expires < now]:
            del sessions[k]


def purge_old_snapshots():
    """Delete raw NWS snapshots past SNAPSHOT_RETENTION_DAYS, except ones a recommendation cites."""
    if SNAPSHOT_RETENTION_DAYS <= 0:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=SNAPSHOT_RETENTION_DAYS)).isoformat()
    with get_db() as conn:
        return conn.execute(
            "DELETE FROM snapshots WHERE fetched_at < ? AND id NOT IN "
            "(SELECT snapshot_id FROM recommendations WHERE snapshot_id IS NOT NULL)", (cutoff,)).rowcount


# ======================================================================
# Rules engine (pure: same inputs always give the same output)
# ======================================================================

RULES_VERSION = "2026-10-10-draft2"
POSTURE_ORDER = ["normal", "delay", "early_dismissal", "telework", "closure"]
POSTURE_RANK = {p: i for i, p in enumerate(POSTURE_ORDER)}
POSTURE_LABEL = {
    "normal": "normal operations", "delay": "delayed arrival",
    "early_dismissal": "early dismissal", "telework": "unscheduled telework",
    "closure": "full closure",
}
ACT_NOW_URGENCY = {"Immediate", "Expected"}
LIKELY_CERTAINTY = {"Observed", "Likely"}

# Highest posture first. Each rule matches on NWS severity, urgency and certainty.
# These cutoffs are a DRAFT: before submitting, tie each one to an NWS or OPM source.
ANCHOR_TODO = ("Draft mapping of NWS CAP severity/urgency/certainty to postures. "
               "Cite the NWS definition and the OPM operating-status category before submission.")
RULES = [
    {"id": "R1", "posture": "closure", "severity": {"Extreme"},
     "urgency": ACT_NOW_URGENCY, "certainty": LIKELY_CERTAINTY, "anchor": ANCHOR_TODO},
    {"id": "R2", "posture": "telework", "severity": {"Severe"},
     "urgency": ACT_NOW_URGENCY, "certainty": LIKELY_CERTAINTY, "anchor": ANCHOR_TODO},
    {"id": "R3", "posture": "early_dismissal", "severity": {"Severe", "Extreme"},
     "urgency": {"Future"}, "certainty": LIKELY_CERTAINTY, "anchor": ANCHOR_TODO},
    # R4 no longer matches Moderate alerts (routine heat advisories, fog and the like).
    {"id": "R4", "posture": "delay", "severity": {"Severe", "Extreme"},
     "urgency": {"Immediate", "Expected", "Future"},
     "certainty": {"Observed", "Likely", "Possible"}, "anchor": ANCHOR_TODO},
]

# Personal (location-based) alerts use the same bar as telework/closure.
PERSONAL_ALERT_RULE = {"severity": {"Severe", "Extreme"},
                       "urgency": ACT_NOW_URGENCY, "certainty": LIKELY_CERTAINTY}


def alert_matches(rule, alert):
    return (alert.get("severity") in rule["severity"]
            and alert.get("urgency") in rule["urgency"]
            and alert.get("certainty") in rule["certainty"])


def describe_rule(rule):
    return (f"severity {'/'.join(sorted(rule['severity']))}, "
            f"urgency {'/'.join(sorted(rule['urgency']))}, "
            f"certainty {'/'.join(sorted(rule['certainty']))}")


def evaluate(facility_name, snapshot_meta, alerts):
    """Turn NWS alerts into a graded posture, with the reasoning attached."""
    considered, best = [], None
    for alert in alerts:
        matched = next((r for r in RULES if alert_matches(r, alert)), None)
        considered.append({**alert, "matchedRule": matched["id"] if matched else None,
                           "impliedPosture": matched["posture"] if matched else "normal"})
        if matched and (best is None or POSTURE_RANK[matched["posture"]] > POSTURE_RANK[best[0]["posture"]]):
            best = (matched, alert)

    posture = best[0]["posture"] if best else "normal"
    fetched = snapshot_meta["fetched_at"]
    inputs = [{"source": "NWS active alerts (api.weather.gov)", "fetchedAt": fetched,
               "snapshotId": snapshot_meta.get("snapshot_id"), "ok": snapshot_meta["ok"],
               "error": snapshot_meta.get("error")}]
    changes = []

    if not snapshot_meta["ok"]:
        confidence = "low"
        rationale = (f"The system could not retrieve NWS alert data for {facility_name} at {fetched}, "
                     "so it is defaulting to normal operations with low confidence. "
                     "Check weather.gov manually before relying on this recommendation.")
        changes.append("A successful NWS fetch would replace this default with a real evaluation.")
        threshold = None
        headline = None
    elif best is None:
        confidence = "high"
        below = f" ({len(alerts)} active alert(s) fall below every threshold)" if alerts else ""
        rationale = (f"As of {fetched}, the NWS reports no active alerts at {facility_name} "
                     f"that meet any closure threshold{below}. Recommended posture: normal operations.")
        changes.append("Any new alert with severity Severe or higher would trigger rule R4 (delay) or above.")
        threshold = None
        headline = None
    else:
        rule, alert = best
        confidence = {"Observed": "high", "Likely": "medium"}.get(alert.get("certainty"), "low")
        headline = alert.get("headline") or alert.get("event")
        threshold = {
            "rule": rule["id"], "posture": rule["posture"], "requires": describe_rule(rule),
            "observed": f"severity {alert.get('severity')}, urgency {alert.get('urgency')}, "
                        f"certainty {alert.get('certainty')}",
            "anchor": rule["anchor"],
        }
        rationale = (f"As of {fetched}, the NWS has an active {alert.get('event')} "
                     f"({alert.get('severity')} severity, {alert.get('urgency')} urgency, "
                     f"{alert.get('certainty')} certainty) covering {facility_name}. "
                     f"That meets rule {rule['id']}, so the system recommends {POSTURE_LABEL[posture]}. "
                     f"Confidence is {confidence}. A human decision-maker should confirm before anyone is notified.")
        higher = [r for r in RULES if POSTURE_RANK[r["posture"]] > POSTURE_RANK[posture]]
        if higher:
            nxt = min(higher, key=lambda r: POSTURE_RANK[r["posture"]])
            changes.append(f"Would escalate to {POSTURE_LABEL[nxt['posture']]} if an alert reaches {describe_rule(nxt)}.")
        else:
            changes.append("Already at the highest posture.")
        if alert.get("expires"):
            changes.append(f"The triggering alert expires {alert['expires']}; the posture would relax when it ends or is cancelled.")

    return {"posture": posture, "label": POSTURE_LABEL[posture], "confidence": confidence,
            "rulesVersion": RULES_VERSION, "headline": headline, "thresholdCrossed": threshold,
            "inputs": inputs, "alertsConsidered": considered,
            "whatWouldChange": changes, "rationale": rationale}


# ======================================================================
# Employee status and notification package
# ======================================================================

DAY_INDEX = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}


def work_days(spec):
    """'Sun-Thu' -> {6, 0, 1, 2, 3}. Handles ranges that wrap past Sunday."""
    first, last = spec.split("-")
    day, days = DAY_INDEX[first], set()
    while True:
        days.add(day)
        if day == DAY_INDEX[last]:
            return days
        day = (day + 1) % 7


def local_now(tz_name):
    try:
        return datetime.now(ZoneInfo(tz_name))
    except ZoneInfoNotFoundError:
        return datetime.now(timezone.utc)


def minutes_until(now_local, hhmm):
    hour, minute = map(int, hhmm.split(":"))
    target = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return int((target - now_local).total_seconds() // 60)


def employee_status(emp, now_local):
    if now_local.weekday() not in work_days(emp["days_of_week"]):
        return "off_today"
    clock = now_local.strftime("%H:%M")
    if clock >= emp["shift_end"]:
        return "shift_ended"
    return "on_shift" if clock >= emp["shift_start"] else "upcoming"


def pick_channels(emp, urgency):
    channels = []
    if urgency == "high":
        if emp["location_consent"]:
            channels.append("push")
        if emp["phone"]:
            channels.append("sms")
    else:
        if emp["location_consent"]:
            channels.append("push")
    if emp["email"] and emp["email_notifications_enabled"]:
        channels.append("email")
    return channels or ["none_on_file"]


def build_messages(name, posture, headline, groups_present):
    why = f" Reason: {headline}." if headline else ""
    label = POSTURE_LABEL[posture]
    out = {}
    if "essential" in groups_present:
        out["essential"] = (f"{name}: {label} has been announced.{why} As essential personnel, your "
                            "reporting requirements are not changed by this message. "
                            "Contact your supervisor for instructions.")
    standard = {
        "delay": f"{name} has a delayed arrival.{why} Do not travel yet. Wait for your supervisor's update on the new start time.",
        "early_dismissal": f"{name} is dismissing early.{why} Wrap up and leave safely.",
    }
    if "standard" in groups_present:
        out["standard"] = standard.get(posture, "")
    if "telework_eligible" in groups_present:
        out["telework_eligible"] = (f"{name} is under {label}.{why} Do not report to the building. "
                                    "Work remotely today.")
    if "supervisor_contact" in groups_present:
        out["supervisor_contact"] = (f"{name} is under {label}.{why} Do not report to the building. "
                                     "You are not telework-eligible, so contact your supervisor about your status today.")
    return out


def build_package(loc, posture, now_local, headline):
    """Who gets notified, who doesn't (and why), what they're told, and on which channel."""
    empty = {"posture": posture, "recipients": [], "excluded": [], "messages": {},
             "counts": {"included": 0, "excluded": 0, "byGroup": {}}}
    if posture == "normal":
        return empty

    with get_db() as conn:
        rows = conn.execute(
            """SELECT e.user_id, e.full_name, e.shift_start, e.shift_end, e.days_of_week,
                      COALESCE(f.is_essential, 0) AS is_essential,
                      COALESCE(f.telework_eligible, 1) AS telework_eligible,
                      f.email, f.phone, COALESCE(f.location_consent, 0) AS location_consent,
                      COALESCE(f.email_notifications_enabled, 0) AS email_notifications_enabled
               FROM employees e LEFT JOIN employee_flags f ON f.user_id = e.user_id
               WHERE e.location_id = ? ORDER BY e.user_id""",
            (loc["location_id"],),
        ).fetchall()

    recipients, excluded, by_group = [], [], {}
    for emp in rows:
        status = employee_status(emp, now_local)
        if status == "off_today":
            excluded.append({"userId": emp["user_id"], "name": emp["full_name"],
                             "reason": f"not scheduled today ({emp['days_of_week']})"})
            continue
        if status == "shift_ended":
            excluded.append({"userId": emp["user_id"], "name": emp["full_name"],
                             "reason": f"shift already ended at {emp['shift_end']}"})
            continue

        if emp["is_essential"]:
            group, reason = "essential", "essential personnel: reporting requirements unchanged"
        elif posture in ("telework", "closure"):
            if emp["telework_eligible"]:
                group, reason = "telework_eligible", "scheduled today and telework-eligible"
            else:
                group, reason = "supervisor_contact", "scheduled today, not telework-eligible"
        else:
            group, reason = "standard", "scheduled today"

        urgency = "high" if status == "on_shift" or (
            status == "upcoming" and minutes_until(now_local, emp["shift_start"]) <= 120) else "normal"
        by_group[group] = by_group.get(group, 0) + 1
        recipients.append({"userId": emp["user_id"], "name": emp["full_name"], "group": group,
                           "status": status, "urgency": urgency,
                           "channels": pick_channels(emp, urgency), "reason": reason})

    return {"posture": posture, "recipients": recipients, "excluded": excluded,
            "messages": build_messages(loc["name"], posture, headline, set(by_group)),
            "counts": {"included": len(recipients), "excluded": len(excluded), "byGroup": by_group}}


# ======================================================================
# Notification delivery
# ======================================================================

def queue_notification(conn, kind, user_id, channel, message, recommendation_id=None, alert_id=None):
    """Record a notification. Returns its id, or None if the (user, alert) pair was already sent."""
    row = conn.execute(
        "INSERT INTO notifications (created_at, kind, user_id, recommendation_id, alert_id, "
        "channel, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'simulated') "
        "ON CONFLICT DO NOTHING RETURNING id",
        (now_iso(), kind, user_id, recommendation_id, alert_id, channel, message),
    ).fetchone()
    return row[0] if row else None


def deliver(notification_id, kind, user_id, channel, message):
    """Hand one notification to the real sender. Stays 'simulated' until NOTIFY_WEBHOOK_URL is set.

    The webhook receives {"notificationId", "kind", "userId", "channels": [...], "message"} and
    is where you plug in your push (Expo/FCM/APNs), SMS (Twilio) or email provider. Delivery
    never runs inside a database transaction, so a slow provider can't lock the database.
    """
    if not NOTIFY_WEBHOOK_URL:
        return "simulated"
    headers = {"Content-Type": "application/json"}
    if NOTIFY_WEBHOOK_TOKEN:
        headers["Authorization"] = f"Bearer {NOTIFY_WEBHOOK_TOKEN}"
    body = json.dumps({"notificationId": notification_id, "kind": kind, "userId": user_id,
                       "channels": channel.split(","), "message": message}).encode("utf-8")
    try:
        with urlopen(Request(NOTIFY_WEBHOOK_URL, data=body, headers=headers, method="POST"), timeout=10):
            status = "sent"
    except (URLError, TimeoutError, OSError):
        status = "failed"
    with get_db() as conn:
        conn.execute("UPDATE notifications SET status = ? WHERE id = ?", (status, notification_id))
    return status


# ======================================================================
# Personal (location-based) alerts
# ======================================================================

SHELTER_EVENT_WORDS = ("hurricane", "tropical", "storm surge", "flood", "fire", "evacuat",
                       "tsunami", "dam", "volcano", "earthquake")


def guidance_for(event):
    e = (event or "").lower()
    if "tornado" in e:
        return "Take shelter now on the lowest floor of a sturdy building, away from windows. Do not drive to a shelter."
    if "flood" in e:
        return "Move to higher ground. Never drive through flooded roads."
    if any(w in e for w in ("hurricane", "tropical", "storm surge")):
        return "Follow local evacuation orders and check open shelters."
    if any(w in e for w in ("winter", "blizzard", "ice")):
        return "Avoid travel and stay indoors if you can."
    if "heat" in e:
        return "Stay in a cool place, drink water, and check on others."
    if "fire" in e or "red flag" in e:
        return "Be ready to evacuate and follow local officials."
    return "Follow instructions from local officials."


def shelter_relevant(event):
    e = (event or "").lower()
    return not ("tornado" in e or "thunderstorm" in e)  # these call for sheltering in place


def needs_shelter_followup(alert):
    """FEMA follow-up is for emergencies where people may have to leave, not routine severe weather."""
    event = (alert.get("event") or "").lower()
    if not shelter_relevant(event):
        return False
    return alert.get("severity") == "Extreme" or any(w in event for w in SHELTER_EVENT_WORDS)


def compose_personal_message(alert):
    return " ".join([f"{alert.get('event')}: {alert.get('headline') or 'active near your location'}.",
                     guidance_for(alert.get("event"))])


def compose_shelter_message(alert, shelters):
    nearest = "; ".join(
        f"{s['name']}, {s['address'] or 'address not listed'} ({s['miles']} mi)" for s in shelters)
    return (f"FEMA follow-up for the {alert.get('event')} near you. Nearest open shelters: {nearest}. "
            "Shelter status can change, so confirm with local officials before you travel.")


def process_location(user_id, lat, lon):
    """Store one location, check NWS for that spot, notify this person if needed.

    Returns None if the update came in too fast (caller sends 429), else a result dict.
    """
    key, clat, clon = cell_key(lat, lon)
    now = datetime.now(timezone.utc)
    with get_db() as conn:
        prev = conn.execute("SELECT updated_at FROM employee_location WHERE user_id = ?", (user_id,)).fetchone()
        flags = conn.execute(
            "SELECT email, email_notifications_enabled FROM employee_flags WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    if prev:
        try:
            age = (now - datetime.fromisoformat(prev["updated_at"])).total_seconds()
        except ValueError:
            age = MIN_LOCATION_INTERVAL_SECONDS
        if age < MIN_LOCATION_INTERVAL_SECONDS:
            return None

    cutoff = (now - timedelta(hours=LOCATION_TTL_HOURS)).isoformat()
    with get_db() as conn:  # keep only the latest point per person, and purge stale ones
        conn.execute("INSERT INTO employee_location (user_id, lat, lon, cell, updated_at) "
                     "VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, "
                     "lon = excluded.lon, cell = excluded.cell, updated_at = excluded.updated_at",
                     (user_id, lat, lon, key, now.isoformat()))
        conn.execute("DELETE FROM employee_location WHERE updated_at < ?", (cutoff,))

    result = get_cell_alerts(key, clat, clon)
    urgent = [a for a in result["alerts"] if alert_matches(PERSONAL_ALERT_RULE, a) and a.get("id")]
    new_notifications = []
    notification_channels = "push,email" if (
        flags and flags["email"] and flags["email_notifications_enabled"]
    ) else "push"

    for alert in urgent:
        # Step 1: the immediate alert, once per person per NWS alert.
        message = compose_personal_message(alert)
        with get_db() as conn:
            notif_id = queue_notification(conn, "personal", user_id, notification_channels, message, alert_id=alert["id"])
        if notif_id:
            status = deliver(notif_id, "personal", user_id, notification_channels, message)
            append_log("personal_alert", {"userId": user_id, "alertId": alert["id"],  # no coordinates
                                          "event": alert.get("event"), "severity": alert.get("severity"),
                                          "snapshotId": result["snapshotId"]})
            new_notifications.append({"alertId": alert["id"], "kind": "personal", "event": alert.get("event"),
                                      "message": message, "status": status, "shelters": []})

        # Step 2: FEMA follow-up. Retried on later updates until shelters show up, then sent once.
        if not needs_shelter_followup(alert):
            continue
        followup_key = f"{alert['id']}#shelter"
        with get_db() as conn:
            done = conn.execute("SELECT 1 FROM notifications WHERE user_id = ? AND alert_id = ?",
                                (user_id, followup_key)).fetchone()
        if done:
            continue
        shelter_result = fetch_shelters(lat, lon)
        if not shelter_result["shelters"]:
            continue
        shelter_message = compose_shelter_message(alert, shelter_result["shelters"])
        with get_db() as conn:
            shelter_notif_id = queue_notification(conn, "shelter", user_id, notification_channels, shelter_message,
                                                  alert_id=followup_key)
        if shelter_notif_id:
            status = deliver(shelter_notif_id, "shelter", user_id, notification_channels, shelter_message)
            append_log("shelter_followup", {"userId": user_id, "alertId": alert["id"],
                                            "shelterCount": len(shelter_result["shelters"])})
            new_notifications.append({"alertId": followup_key, "kind": "shelter", "event": alert.get("event"),
                                      "message": shelter_message, "status": status,
                                      "shelters": shelter_result["shelters"]})
    return {"nwsOk": result["ok"], "checkedAt": result["fetchedAt"], "newNotifications": new_notifications}


# ======================================================================
# Recommendations (shared by the API and the background scan)
# ======================================================================

def load_location(location_id):
    with get_db() as conn:
        return conn.execute(
            "SELECT l.location_id, l.name, g.lat, g.lon, g.tz FROM locations l "
            "JOIN location_geo g ON g.location_id = l.location_id WHERE l.location_id = ?",
            (location_id,),
        ).fetchone()


def finalize_decision(rec, action, final, reason, decided_by):
    """Record a decision and queue + send the notifications. Used by managers and by auto-send.

    Returns the notification package, or None if someone else already decided this one.
    """
    loc = load_location(rec["location_id"])
    headline = json.loads(rec["detail_json"])["recommendation"].get("headline")
    package = build_package(loc, final, local_now(loc["tz"]), headline)

    queued = []  # (notification id, user id, channel, message)
    with get_db() as conn:
        updated = conn.execute(
            "UPDATE recommendations SET status = ?, final_posture = ?, decided_by = ?, decided_at = ?, "
            "decision_reason = ? WHERE id = ? AND status = 'pending'",
            ("approved" if action == "approve" else "overridden", final, decided_by,
             now_iso(), reason or None, rec["id"]),
        )
        if updated.rowcount == 0:
            return None
        for r in package["recipients"]:
            channel, message = ",".join(r["channels"]), package["messages"][r["group"]]
            notif_id = queue_notification(conn, "facility", r["userId"], channel, message,
                                          recommendation_id=rec["id"])
            queued.append((notif_id, r["userId"], channel, message))
    append_log("decision", {
        "recommendationId": rec["id"], "action": action, "recommendedPosture": rec["posture"],
        "finalPosture": final, "reason": reason or None, "decidedBy": decided_by,
        "notificationsQueued": package["counts"]["included"],
    })
    for notif_id, user_id, channel, message in queued:  # after the commit, never inside it
        if notif_id and channel != "none_on_file":
            deliver(notif_id, "facility", user_id, channel, message)
    return package


def create_recommendation(loc, requested_by, only_if_actionable=False, auto_decide=False):
    """Fetch fresh NWS data for a facility and store a PENDING recommendation.

    With only_if_actionable (used by the background scan), nothing is stored when the
    answer is 'normal' or the NWS could not be reached, and repeats are suppressed.
    With auto_decide, a recommendation that is not 'normal' and meets AUTO_DECIDE_MIN_CONFIDENCE is
    approved on the spot (decided_by 'auto') and its notifications go out immediately.
    Returns (rec_id, rec, package) or None if nothing was created.
    """
    snapshot = fetch_nws_alerts(loc["lat"], loc["lon"])  # always fresh for a decision
    alerts = summarize_alerts(snapshot["raw"])
    meta = {"ok": snapshot["ok"], "fetched_at": snapshot["fetched_at"],
            "error": snapshot["error"], "snapshot_id": None}
    rec = evaluate(loc["name"], meta, alerts)

    if only_if_actionable:
        if not snapshot["ok"] or rec["posture"] == "normal":
            return None
        repeat_cutoff = (datetime.now(timezone.utc) - timedelta(hours=AUTO_SCAN_REPEAT_HOURS)).isoformat()
        with get_db() as conn:
            # A notice that was already cleared doesn't suppress a brand-new alert of the same kind.
            dup = conn.execute(
                "SELECT 1 FROM recommendations WHERE location_id = ? AND posture = ? AND "
                "(status = 'pending' OR (created_at > ? AND cleared_at IS NULL))",
                (loc["location_id"], rec["posture"], repeat_cutoff)).fetchone()
        if dup:
            return None

    snapshot_id = save_snapshot(snapshot, loc["lat"], loc["lon"])
    meta["snapshot_id"] = snapshot_id
    rec = evaluate(loc["name"], meta, alerts)  # pure, so re-running just adds the snapshot id
    package = build_package(loc, rec["posture"], local_now(loc["tz"]), rec["headline"])

    with get_db() as conn:
        rec_id = conn.execute(
            "INSERT INTO recommendations (location_id, created_at, posture, confidence, snapshot_id, "
            "rules_version, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (loc["location_id"], now_iso(), rec["posture"], rec["confidence"], snapshot_id,
             RULES_VERSION, json.dumps({"recommendation": rec})),
        ).fetchone()[0]
    append_log("recommendation", {
        "recommendationId": rec_id, "locationId": loc["location_id"], "posture": rec["posture"],
        "confidence": rec["confidence"], "snapshotId": snapshot_id, "rulesVersion": RULES_VERSION,
        "thresholdCrossed": rec["thresholdCrossed"], "requestedBy": requested_by,
        "recipientIds": [r["userId"] for r in package["recipients"]],
        "excludedCount": package["counts"]["excluded"],
    })
    if (auto_decide and rec["posture"] != "normal"
            and CONFIDENCE_RANK.get(rec["confidence"], 0) >= CONFIDENCE_RANK.get(AUTO_DECIDE_MIN_CONFIDENCE, 1)):
        with get_db() as conn:
            row = conn.execute("SELECT * FROM recommendations WHERE id = ?", (rec_id,)).fetchone()
        sent = finalize_decision(row, "approve", rec["posture"], "", "auto")
        if sent is not None:
            package = sent
    return rec_id, rec, package


# ======================================================================
# All-clear
# ======================================================================

def check_all_clear(loc):
    """If a facility has an open notice and the NWS has stayed quiet for ALL_CLEAR_HOLD_MINUTES,
    send one all-clear to the people who were told. Returns True if one was sent."""
    with get_db() as conn:
        open_recs = conn.execute(
            "SELECT id, final_posture FROM recommendations WHERE location_id = ? "
            "AND status IN ('approved', 'overridden') AND final_posture <> 'normal' "
            "AND cleared_at IS NULL ORDER BY id", (loc["location_id"],)).fetchall()
    if not open_recs:
        return False

    snapshot = fetch_nws_alerts(loc["lat"], loc["lon"])
    if not snapshot["ok"]:
        return False  # never clear on a failed fetch
    meta = {"ok": True, "fetched_at": snapshot["fetched_at"], "error": None, "snapshot_id": None}
    current = evaluate(loc["name"], meta, summarize_alerts(snapshot["raw"]))

    ids = [r["id"] for r in open_recs]
    now = datetime.now(timezone.utc)
    with get_db() as conn:
        if current["posture"] != "normal":  # still active, or re-escalated: restart the hold timer
            conn.execute("UPDATE recommendations SET clear_seen_at = NULL WHERE id = ANY(?)", (ids,))
            return False
        conn.execute("UPDATE recommendations SET clear_seen_at = COALESCE(clear_seen_at, ?) "
                     "WHERE id = ANY(?)", (now.isoformat(), ids))
        first_quiet = conn.execute("SELECT MAX(clear_seen_at) FROM recommendations WHERE id = ANY(?)",
                                   (ids,)).fetchone()[0]
    if now - datetime.fromisoformat(first_quiet) < timedelta(minutes=ALL_CLEAR_HOLD_MINUTES):
        return False

    posture = max((r["final_posture"] for r in open_recs), key=lambda p: POSTURE_RANK.get(p, 0))
    message = (f"{loc['name']}: the {POSTURE_LABEL[posture]} notice has ended. The NWS shows no active "
               "alerts that meet our thresholds, so normal operations may resume. "
               "Check with your supervisor if you are unsure when to report.")
    now_local = local_now(loc["tz"])
    queued = []
    with get_db() as conn:
        claimed = conn.execute("UPDATE recommendations SET cleared_at = ? "
                               "WHERE id = ANY(?) AND cleared_at IS NULL", (now_iso(), ids))
        if claimed.rowcount == 0:
            return False  # another instance got there first
        people = conn.execute(
            "SELECT DISTINCT ON (n.user_id) n.user_id, n.channel, e.shift_start, e.shift_end, e.days_of_week "
            "FROM notifications n JOIN employees e ON e.user_id = n.user_id "
            "WHERE n.kind = 'facility' AND n.recommendation_id = ANY(?) AND n.channel <> 'none_on_file' "
            "ORDER BY n.user_id, n.id DESC", (ids,)).fetchall()
        for p in people:
            if employee_status(p, now_local) not in ("on_shift", "upcoming"):
                continue  # shift over or not working today: an all-clear would just be noise
            notif_id = queue_notification(conn, "all_clear", p["user_id"], p["channel"], message,
                                          recommendation_id=ids[-1])
            queued.append((notif_id, p["user_id"], p["channel"], message))
    append_log("all_clear", {"locationId": loc["location_id"], "recommendationIds": ids,
                             "clearedPosture": posture, "notificationsQueued": len(queued),
                             "holdMinutes": ALL_CLEAR_HOLD_MINUTES})
    for notif_id, user_id, channel, msg in queued:  # after the commit, never inside it
        if notif_id:
            deliver(notif_id, "all_clear", user_id, channel, msg)
    return True


# ======================================================================
# Background scan
# ======================================================================

SCAN_LOCK_KEY = 7002


def scan_facilities():
    """Check every facility once. With AUTO_DECIDE on, notifications go out without a manager step.

    Facilities with no coordinates (nothing in location_geo) are skipped.
    """
    with get_db() as conn:
        ids = [r[0] for r in conn.execute("SELECT location_id FROM location_geo ORDER BY location_id")]
    created = 0
    for location_id in ids:
        loc = load_location(location_id)
        if loc and create_recommendation(loc, "auto-scan", only_if_actionable=True, auto_decide=AUTO_DECIDE):
            created += 1
        if loc and ALL_CLEAR:
            try:
                check_all_clear(loc)
            except Exception as err:  # one bad facility must not stop the scan
                print(f"All-clear error at location {location_id}: {err}")
        time.sleep(0.5)  # be polite to the NWS
    return created


def scan_once():
    """Run one scan, but only if no other instance is already running one.

    A Postgres session-level advisory lock is held on a dedicated connection for the whole scan,
    so two copies of the server never scan (or send duplicate notices) at the same time.
    Returns the number of new recommendations, or None if another instance has the lock.
    """
    with get_pool().connection() as conn:
        conn.autocommit = True  # no open transaction while the scan runs
        if not conn.execute("SELECT pg_try_advisory_lock(%s)", (SCAN_LOCK_KEY,)).fetchone()[0]:
            return None
        try:
            created = scan_facilities()
            purged = purge_old_snapshots()
            prune_caches()
            if purged:
                print(f"Cleanup: removed {purged} old snapshot(s).")
            return created
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (SCAN_LOCK_KEY,))
            conn.autocommit = False  # the pool hands this connection to other code next


def scan_loop():
    while True:
        try:
            created = scan_once()
            if created:
                print(f"Auto-scan: {created} new recommendation(s).")
        except Exception as err:  # never let the scan thread die
            print(f"Auto-scan error: {err}")
        time.sleep(AUTO_SCAN_MINUTES * 60)


# ======================================================================
# HTTP handler
# ======================================================================

ROUTES = [(m, re.compile(p), name, access) for m, p, name, access in [
    ("GET", r"/api/health", "h_health", "public"),
    ("POST", r"/api/login", "h_login", "public"),
    ("POST", r"/api/logout", "h_logout", "auth"),
    ("GET", r"/api/locations", "h_locations", "public"),
    ("GET", r"/api/weather", "h_weather", "public"),
    ("GET", r"/api/me", "h_me", "auth"),
    ("PUT", r"/api/me/notification-preferences", "h_notification_preferences_update", "auth"),
    ("GET", r"/api/employees", "h_employees_list", "manager"),
    ("GET", r"/api/admin/employee-locations", "h_employee_locations", "manager"),
    ("PUT", r"/api/admin/employees/([0-9]{6})", "h_employee_update", "manager"),
    ("GET", r"/api/locations", "h_locations", "manager"),
    ("GET", r"/api/locations/(\d+)", "h_location_get", "auth"),
    ("PUT", r"/api/locations/(\d+)", "h_location_put", "manager"),
    ("GET", r"/api/alerts", "h_alerts", "auth"),
    ("GET", r"/api/shelters", "h_shelters", "auth"),
    ("GET", r"/api/my/shelters", "h_my_shelters", "auth"),
    ("GET", r"/api/snapshots", "h_snapshots", "manager"),
    ("GET", r"/api/snapshots/(\d+)", "h_snapshot_detail", "manager"),
    ("GET", r"/api/recommendations", "h_rec_list", "manager"),
    ("POST", r"/api/recommendations", "h_rec_create", "manager"),
    ("GET", r"/api/recommendations/(\d+)", "h_rec_get", "manager"),
    ("POST", r"/api/recommendations/(\d+)/decision", "h_rec_decide", "manager"),
    ("POST", r"/api/admin/employees/import", "h_employees_import", "manager"),
    ("POST", r"/api/admin/employees/contacts", "h_employees_contacts", "manager"),
    ("POST", r"/api/location/consent", "h_consent", "auth"),
    ("POST", r"/api/location", "h_location_update", "auth"),
    ("GET", r"/api/my/notifications", "h_my_notifications", "auth"),
    ("GET", r"/api/decision-log", "h_log", "manager"),
    ("GET", r"/api/decision-log/verify", "h_log_verify", "manager"),
    ("GET", r"/api/entries", "h_entries_list", "auth"),
    ("POST", r"/api/entries", "h_entries_create", "auth"),
]]

sessions = {}  # token -> (user_id, expires at monotonic time). In memory: a restart logs everyone out.
sessions_lock = Lock()


class ClosureCallHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIRECTORY), **kwargs)

    # ----- routing -----
    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def dispatch(self, method):
        parts = urlsplit(self.path)
        route, query = parts.path, parse_qs(parts.query)

        for route_method, pattern, name, access in ROUTES:
            match = pattern.fullmatch(route) if route_method == method else None
            if not match:
                continue
            employee = self.current_employee()
            if access != "public" and employee is None:
                self.send_json({"error": "Login required."}, status=401)
                return
            if access == "manager" and employee["user_id"] not in MANAGER_IDS:
                self.send_json({"error": "Manager access required."}, status=403)
                return
            getattr(self, name)(employee, query, *match.groups())
            return

        if method == "GET" and not route.startswith("/api/"):
            if route == "/":
                # The landing page is the front door; it lives in /landing/ so its relative asset paths resolve.
                self.send_response(302)
                self.send_header("Location", "/landing/")
                self.end_headers()
                return
            if route in ("/dashboard", "/index.html"):
                employee = self.current_employee()
                if employee is None:
                    self.send_response(302)
                    self.send_header("Location", "/login.html")
                    self.end_headers()
                    return
                if employee["user_id"] not in MANAGER_IDS:
                    self.send_response(302)
                    self.send_header("Location", "/employee.html")
                    self.end_headers()
                    return
            if route == "/dashboard":
                self.path = "/index.html"
            super().do_GET()
            return
        self.send_json({"error": "API route not found."}, status=404)

    # ----- basic -----
    def h_health(self, employee, query):
        self.send_json({"status": "ok", "storage": "postgres", "time": now_iso(),
                        "autoScanMinutes": AUTO_SCAN_MINUTES, "autoDecide": AUTO_DECIDE,
                        "allClear": ALL_CLEAR,
                        "delivery": "webhook" if NOTIFY_WEBHOOK_URL else "simulated"})

    def h_login(self, employee, query):
        client = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                  or self.client_address[0])
        if too_fast(client, "login", 2):
            self.send_json({"error": "Too many attempts. Wait a moment and try again."}, status=429)
            return
        payload = self.read_json_object()
        if payload is None:
            return
        user_id = payload.get("userId")
        if not isinstance(user_id, str) or not re.fullmatch(r"[0-9]{6}", user_id):
            self.send_json({"error": "Enter a valid six-digit ID."}, status=400)
            return
        is_manager = user_id in MANAGER_IDS
        with get_db() as conn:
            row = conn.execute("SELECT user_id, full_name FROM employees WHERE user_id = ?",
                               (user_id,)).fetchone()
        if row is None and not is_manager:  # NOTE: ID-only login is a demo stub. Replace with real authentication.
            self.send_json({"error": "Unknown employee."}, status=401)
            return
        token = secrets.token_urlsafe(24)
        with sessions_lock:
            sessions[token] = (user_id, monotonic() + SESSION_HOURS * 3600)
        self.send_json({"token": token, "userId": user_id,
                        "name": row["full_name"] if row else "Fieldcast Administrator",
                        "isManager": is_manager},
                       headers={"Set-Cookie": self.session_cookie(token)})

    def h_logout(self, employee, query):
        token = self.session_token()
        if token:
            with sessions_lock:
                sessions.pop(token, None)
        self.send_json({"ok": True}, headers={"Set-Cookie": self.session_cookie("", clear=True)})

    def h_me(self, employee, query):
        with get_db() as conn:
            row = conn.execute(
                "SELECT e.user_id, e.full_name, e.location_id, e.shift_start, e.shift_end, e.days_of_week, "
                "COALESCE(f.location_consent, 0) AS consent, f.email, "
                "COALESCE(f.email_notifications_enabled, 0) AS email_notifications_enabled "
                "FROM employees e LEFT JOIN employee_flags f ON f.user_id = e.user_id WHERE e.user_id = ?",
                (employee["user_id"],),
            ).fetchone()
        self.send_json({"userId": row["user_id"], "name": row["full_name"],
                        "locationId": row["location_id"], "shiftStart": row["shift_start"],
                        "shiftEnd": row["shift_end"], "daysOfWeek": row["days_of_week"],
                        "locationSharing": bool(row["consent"]),
                        "email": row["email"] or "",
                        "emailNotificationsEnabled": bool(row["email_notifications_enabled"]),
                        "isManager": row["user_id"] in MANAGER_IDS})

    def h_notification_preferences_update(self, employee, query):
        payload = self.read_json_object()
        if payload is None:
            return
        email = payload.get("email")
        enabled = payload.get("emailNotificationsEnabled")
        if not isinstance(email, str) or len(email.strip()) > 254:
            self.send_json({"error": "Enter a valid email address."}, status=400)
            return
        email = email.strip()
        if not isinstance(enabled, bool):
            self.send_json({"error": "emailNotificationsEnabled must be true or false."}, status=400)
            return
        if enabled and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            self.send_json({"error": "Enter a valid email address to enable email notifications."}, status=400)
            return
        if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            self.send_json({"error": "Enter a valid email address."}, status=400)
            return
        with get_db() as conn:
            conn.execute(
                "INSERT INTO employee_flags (user_id, email, email_notifications_enabled) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, "
                "email_notifications_enabled = excluded.email_notifications_enabled",
                (employee["user_id"], email or None, int(enabled)),
            )
        self.send_json({"email": email, "emailNotificationsEnabled": enabled})

    # ----- roster (dashboard) -----
    def h_employees_list(self, employee, query):
        with get_db() as conn:
            rows = conn.execute(
                "SELECT e.user_id, e.full_name, e.phone_number, e.shift_start, e.shift_end, e.days_of_week, "
                "e.location_id, l.name AS location_name, l.address AS location_address, g.tz "
                "FROM employees e JOIN locations l ON l.location_id = e.location_id "
                "LEFT JOIN location_geo g ON g.location_id = e.location_id "
                "ORDER BY lower(e.full_name), e.user_id").fetchall()
        self.send_json([{
            "userId": r["user_id"], "fullName": r["full_name"],
            "phoneNumber": r["phone_number"],
            "shiftStart": r["shift_start"], "shiftEnd": r["shift_end"],
            "daysOfWeek": r["days_of_week"], "locationId": r["location_id"],
            "locationName": r["location_name"], "locationAddress": r["location_address"],
            "locationTimezone": r["tz"],
        } for r in rows])

    def h_employee_locations(self, employee, query):
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=LIVE_LOCATION_MAX_AGE_MINUTES)).isoformat()
        with get_db() as conn:
            rows = conn.execute(
                "SELECT e.user_id, e.full_name, l.lat, l.lon, l.updated_at "
                "FROM employee_location l "
                "JOIN employees e ON e.user_id = l.user_id "
                "JOIN employee_flags f ON f.user_id = l.user_id "
                "WHERE f.location_consent = 1 AND l.updated_at >= ? "
                "ORDER BY lower(e.full_name), e.user_id",
                (cutoff,),
            ).fetchall()
        self.send_json([{
            "userId": row["user_id"],
            "fullName": row["full_name"],
            "latitude": row["lat"],
            "longitude": row["lon"],
            "updatedAt": row["updated_at"],
        } for row in rows])

    def h_employee_update(self, employee, query, user_id):
        payload = self.read_json_object()
        if payload is None:
            return
        normalized, error = clean_employee({
            "userId": user_id,
            "fullName": payload.get("fullName"),
            "phone": payload.get("phoneNumber"),
            "locationId": payload.get("locationId"),
            "shiftStart": payload.get("shiftStart"),
            "shiftEnd": payload.get("shiftEnd"),
            "daysOfWeek": payload.get("daysOfWeek"),
        })
        if error:
            self.send_json({"error": error}, status=400)
            return
        if not normalized["phone"]:
            self.send_json({"error": "A valid phone number is required."}, status=400)
            return

        with get_db() as conn:
            if not conn.execute("SELECT 1 FROM locations WHERE location_id = ?",
                                (normalized["location_id"],)).fetchone():
                self.send_json({"error": "Selected location was not found."}, status=400)
                return
            old = conn.execute(
                "SELECT full_name, phone_number, location_id, shift_start, shift_end, days_of_week "
                "FROM employees WHERE user_id = ?", (user_id,),
            ).fetchone()
            if old is None:
                self.send_json({"error": "Employee not found."}, status=404)
                return
            conn.execute(
                "UPDATE employees SET full_name = ?, phone_number = ?, location_id = ?, "
                "shift_start = ?, shift_end = ?, days_of_week = ? WHERE user_id = ?",
                (normalized["full_name"], normalized["phone"], normalized["location_id"],
                 normalized["shift_start"], normalized["shift_end"], normalized["days_of_week"], user_id),
            )
            conn.execute(
                "INSERT INTO employee_flags (user_id, phone) VALUES (?, ?) "
                "ON CONFLICT (user_id) DO UPDATE SET phone = excluded.phone",
                (user_id, normalized["phone"]),
            )
            updated = conn.execute(
                "SELECT e.user_id, e.full_name, e.phone_number, e.shift_start, e.shift_end, "
                "e.days_of_week, e.location_id, l.name AS location_name, "
                "l.address AS location_address, g.tz "
                "FROM employees e JOIN locations l ON l.location_id = e.location_id "
                "LEFT JOIN location_geo g ON g.location_id = e.location_id "
                "WHERE e.user_id = ?", (user_id,),
            ).fetchone()

        append_log("employee_updated", {
            "updatedBy": employee["user_id"],
            "userId": user_id,
            "before": dict(old),
            "after": {
                "fullName": updated["full_name"],
                "phoneNumber": updated["phone_number"],
                "locationId": updated["location_id"],
                "shiftStart": updated["shift_start"],
                "shiftEnd": updated["shift_end"],
                "daysOfWeek": updated["days_of_week"],
            },
        })
        self.send_json({
            "userId": updated["user_id"],
            "fullName": updated["full_name"],
            "phoneNumber": updated["phone_number"],
            "shiftStart": updated["shift_start"],
            "shiftEnd": updated["shift_end"],
            "daysOfWeek": updated["days_of_week"],
            "locationId": updated["location_id"],
            "locationName": updated["location_name"],
            "locationAddress": updated["location_address"],
            "locationTimezone": updated["tz"],
        })

    def h_locations(self, employee, query):
        with get_db() as conn:
            rows = conn.execute(
                "SELECT l.location_id, l.name, l.address, g.lat, g.lon "
                "FROM locations l LEFT JOIN location_geo g ON g.location_id = l.location_id "
                "ORDER BY lower(l.name), l.location_id"
            ).fetchall()
        self.send_json([{
            "locationId": row["location_id"],
            "name": row["name"],
            "address": row["address"],
            "latitude": row["lat"],
            "longitude": row["lon"],
        } for row in rows])

    # ----- facilities -----
    def h_locations(self, employee, query):
        with get_db() as conn:
            has_address = conn.execute(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'locations' "
                "AND column_name = 'address')"
            ).fetchone()[0]
            address_field = "l.address" if has_address else "NULL"
            rows = conn.execute(
                f"SELECT l.location_id, l.name, {address_field} AS address, g.lat, g.lon "
                "FROM locations l LEFT JOIN location_geo g ON g.location_id = l.location_id "
                "ORDER BY l.name"
            ).fetchall()
        self.send_json([
            {"locationId": row["location_id"], "name": row["name"], "address": row["address"],
             "latitude": row["lat"], "longitude": row["lon"]}
            for row in rows
        ])

    def h_weather(self, employee, query):
        raw_location_id = query.get("locationId", [""])[0]
        try:
            location_id = int(raw_location_id)
        except (TypeError, ValueError):
            self.send_json({"error": "A valid locationId is required."}, status=400)
            return

        with get_db() as conn:
            has_address = conn.execute(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'locations' "
                "AND column_name = 'address')"
            ).fetchone()[0]
            address_field = "l.address" if has_address else "NULL"
            loc = conn.execute(
                f"SELECT l.location_id, l.name, {address_field} AS address, g.lat, g.lon "
                "FROM locations l LEFT JOIN location_geo g ON g.location_id = l.location_id "
                "WHERE l.location_id = ?",
                (location_id,),
            ).fetchone()
        if loc is None:
            self.send_json({"error": "Location not found."}, status=404)
            return

        with weather_cache_lock:
            cached = weather_cache.get(location_id)
            if cached and monotonic() - cached["cachedAt"] < ALERT_CACHE_SECONDS:
                self.send_json(cached["value"])
                return

        address = loc["address"]
        geocoded = None
        try:
            if address and address.strip():
                try:
                    geocoded = geocode_location(address, location_id)
                    latitude, longitude = geocoded["latitude"], geocoded["longitude"]
                except (URLError, TimeoutError, json.JSONDecodeError, ValueError, LookupError,
                        KeyError, TypeError, OSError):
                    if loc["lat"] is None or loc["lon"] is None:
                        raise
                    latitude, longitude = loc["lat"], loc["lon"]
                    geocoded = {"precision": "configured-site", "matchedAddress": None}
            elif loc["lat"] is not None and loc["lon"] is not None:
                latitude, longitude = loc["lat"], loc["lon"]
                geocoded = {"precision": "configured-site", "matchedAddress": None}
            else:
                self.send_json({"error": "This work site has no address or configured coordinates."}, status=404)
                return

            points = fetch_nws_json(f"{NWS_POINTS_URL}/{latitude},{longitude}")
            point_properties = points.get("properties")
            if not isinstance(point_properties, dict):
                raise ValueError("The National Weather Service returned an invalid point response.")
            forecast_url = point_properties.get("forecastHourly")
            if not forecast_url:
                raise ValueError("The National Weather Service did not provide an hourly forecast URL.")
            hourly = fetch_nws_json(forecast_url)
            forecast_properties = hourly.get("properties")
            if not isinstance(forecast_properties, dict):
                raise ValueError("The National Weather Service returned an invalid forecast response.")
            periods = forecast_properties.get("periods", [])
            if not periods:
                raise ValueError("The National Weather Service returned no hourly forecast periods.")
            if not isinstance(periods[0], dict):
                raise ValueError("The National Weather Service returned an invalid hourly forecast period.")
        except (URLError, TimeoutError, json.JSONDecodeError, ValueError, LookupError,
                KeyError, TypeError, OSError) as err:
            self.send_json({"error": f"Unable to load the National Weather Service forecast: {err}"}, status=502)
            return

        period = periods[0]
        probability = (period.get("probabilityOfPrecipitation") or {}).get("value")
        humidity = (period.get("relativeHumidity") or {}).get("value")
        alert_snapshot = fetch_nws_alerts(latitude, longitude)
        snapshot_id = save_snapshot(alert_snapshot, latitude, longitude)
        alerts = []
        alerts_error = None
        if alert_snapshot["ok"]:
            for feature in (alert_snapshot["raw"] or {}).get("features", []):
                if not isinstance(feature, dict):
                    continue
                properties = feature.get("properties") or {}
                if not isinstance(properties, dict):
                    continue
                if properties.get("status") not in (None, "Actual"):
                    continue
                alerts.append({
                    "id": properties.get("id") or feature.get("id"),
                    "event": properties.get("event"),
                    "severity": properties.get("severity"),
                    "headline": properties.get("headline"),
                    "geometry": feature.get("geometry"),
                })
        else:
            alerts_error = f"Active NWS alerts could not be loaded: {alert_snapshot['error']}"

        result = {
            "location": {
                "id": location_id,
                "name": loc["name"],
                "address": address,
                "matchedAddress": geocoded["matchedAddress"],
                "geocodePrecision": geocoded["precision"],
            },
            "coordinates": {"latitude": latitude, "longitude": longitude},
            "forecast": {
                "startTime": period.get("startTime"),
                "shortForecast": period.get("shortForecast"),
                "temperature": period.get("temperature"),
                "temperatureUnit": period.get("temperatureUnit"),
                "windSpeed": period.get("windSpeed"),
                "windDirection": period.get("windDirection"),
                "probabilityOfPrecipitation": probability,
                "relativeHumidity": humidity,
            },
            "alerts": alerts,
            "alertsError": alerts_error,
            "snapshotId": snapshot_id,
            "updatedAt": now_iso(),
        }
        with weather_cache_lock:
            weather_cache[location_id] = {"cachedAt": monotonic(), "value": result}
        self.send_json(result)

    def h_location_get(self, employee, query, location_id):
        loc = load_location(int(location_id))
        if loc is None:
            self.send_json({"error": "Location not found."}, status=404)
            return
        with get_db() as conn:
            headcount = conn.execute("SELECT COUNT(*) FROM employees WHERE location_id = ?",
                                     (loc["location_id"],)).fetchone()[0]
        self.send_json({"locationId": loc["location_id"], "name": loc["name"], "lat": loc["lat"],
                        "lon": loc["lon"], "tz": loc["tz"], "headcount": headcount})

    def h_location_put(self, employee, query, location_id):
        payload = self.read_json_object()
        if payload is None:
            return
        try:
            lat, lon = float(payload["lat"]), float(payload["lon"])
            tz = payload.get("tz", "UTC")
            ZoneInfo(tz)
        except (KeyError, TypeError, ValueError, ZoneInfoNotFoundError):
            self.send_json({"error": "Need numeric lat, lon and a valid IANA tz."}, status=400)
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            self.send_json({"error": "lat or lon out of range."}, status=400)
            return
        with get_db() as conn:
            if not conn.execute("SELECT 1 FROM locations WHERE location_id = ?", (int(location_id),)).fetchone():
                self.send_json({"error": "Location not found."}, status=404)
                return
            conn.execute("INSERT INTO location_geo (location_id, lat, lon, tz) VALUES (?, ?, ?, ?) "
                         "ON CONFLICT (location_id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, "
                         "tz = excluded.tz",
                         (int(location_id), round(lat, 4), round(lon, 4), tz))
        self.h_location_get(employee, query, location_id)

    # ----- employee import -----
    def h_employees_import(self, employee, query):
        payload = self.read_json_object(max_bytes=IMPORT_MAX_BYTES)
        if payload is None:
            return
        records = payload.get("employees")
        if not isinstance(records, list) or not records:
            self.send_json({"error": "Send {\"employees\": [ ... ]} with at least one record."}, status=400)
            return
        summary = upsert_employees(records)
        append_log("employee_import", {"importedBy": employee["user_id"], "received": summary["received"],
                                       "added": summary["added"], "updated": summary["updated"],
                                       "rejected": summary["rejectedCount"]})
        self.send_json(summary)

    def h_employees_contacts(self, employee, query):
        payload = self.read_json_object(max_bytes=IMPORT_MAX_BYTES)
        if payload is None:
            return
        records = payload.get("employees")
        if not isinstance(records, list) or not records:
            self.send_json({"error": "Send {\"employees\": [ ... ]} with at least one record."}, status=400)
            return
        summary = update_contacts(records)
        append_log("contacts_update", {"updatedBy": employee["user_id"], "received": summary["received"],
                                       "updated": summary["updated"], "rejected": summary["rejectedCount"]})
        self.send_json(summary)

    # ----- weather and shelters -----
    def parse_coords(self, query):
        try:
            lat = round(float(query.get("lat", [""])[0]), 4)
            lon = round(float(query.get("lon", [""])[0]), 4)
        except ValueError:
            self.send_json({"error": "lat and lon must be numbers."}, status=400)
            return None
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            self.send_json({"error": "lat or lon out of range."}, status=400)
            return None
        return lat, lon

    def rate_limited(self, employee, bucket):
        """Sends a 429 and returns True if this user is calling too often."""
        if too_fast(employee["user_id"], bucket, API_MIN_INTERVAL_SECONDS):
            self.send_json({"error": f"Please wait {API_MIN_INTERVAL_SECONDS} seconds between requests."},
                           status=429)
            return True
        return False

    def h_alerts(self, employee, query):
        coords = self.parse_coords(query)
        if coords is None or self.rate_limited(employee, "alerts"):
            return
        snapshot = fetch_nws_alerts(*coords)
        snapshot_id = save_snapshot(snapshot, None, None)  # the point belongs to the caller: don't store it
        self.send_json({"snapshotId": snapshot_id, "source": snapshot["source"],
                        "fetchedAt": snapshot["fetched_at"], "ok": snapshot["ok"],
                        "error": snapshot["error"], "alerts": summarize_alerts(snapshot["raw"])})

    def h_shelters(self, employee, query):
        coords = self.parse_coords(query)
        if coords is None or self.rate_limited(employee, "shelters"):
            return
        self.send_json(fetch_shelters(*coords))

    def h_my_shelters(self, employee, query):
        with get_db() as conn:
            row = conn.execute("SELECT lat, lon, updated_at FROM employee_location WHERE user_id = ?",
                               (employee["user_id"],)).fetchone()
        if row is None:
            self.send_json({"error": "No shared location yet. Turn on location sharing in the mobile app."},
                           status=404)
            return
        result = fetch_shelters(row["lat"], row["lon"])
        result["locationUpdatedAt"] = row["updated_at"]
        self.send_json(result)

    def h_snapshots(self, employee, query):
        with get_db() as conn:
            rows = conn.execute("SELECT id, source, lat, lon, fetched_at, ok, error "
                                "FROM snapshots ORDER BY id DESC LIMIT 20").fetchall()
        self.send_json([dict(r) for r in rows])

    def h_snapshot_detail(self, employee, query, snapshot_id):
        with get_db() as conn:
            row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (int(snapshot_id),)).fetchone()
        if row is None:
            self.send_json({"error": "Snapshot not found."}, status=404)
            return
        data = dict(row)
        raw_json = data.pop("raw_json")
        data["raw"] = json.loads(raw_json) if raw_json else None
        self.send_json(data)

    # ----- recommendations and decisions -----
    def h_rec_list(self, employee, query):
        status = query.get("status", [""])[0]
        sql = ("SELECT r.id, r.location_id, l.name AS location_name, r.created_at, r.posture, r.confidence, "
               "r.status, r.final_posture FROM recommendations r JOIN locations l ON l.location_id = r.location_id ")
        params = ()
        if status:
            sql, params = sql + "WHERE r.status = ? ", (status,)
        with get_db() as conn:
            rows = conn.execute(sql + "ORDER BY r.id DESC LIMIT 50", params).fetchall()
        self.send_json([dict(r) for r in rows])

    def h_rec_create(self, employee, query):
        payload = self.read_json_object()
        if payload is None:
            return
        loc = load_location(payload.get("locationId") if isinstance(payload.get("locationId"), int) else -1)
        if loc is None:
            self.send_json({"error": "Unknown locationId, or that facility has no coordinates yet."}, status=404)
            return
        rec_id, rec, package = create_recommendation(loc, employee["user_id"])
        self.send_json({"id": rec_id, "status": "pending", "recommendation": rec, "package": package}, status=201)

    def h_rec_get(self, employee, query, rec_id):
        with get_db() as conn:
            row = conn.execute("SELECT * FROM recommendations WHERE id = ?", (int(rec_id),)).fetchone()
        if row is None:
            self.send_json({"error": "Recommendation not found."}, status=404)
            return
        data = dict(row)
        data["detail"] = json.loads(data.pop("detail_json"))
        self.send_json(data)

    def h_rec_decide(self, employee, query, rec_id):
        payload = self.read_json_object()
        if payload is None:
            return
        action = payload.get("action")
        reason = (payload.get("reason") or "").strip() if isinstance(payload.get("reason"), str) else ""
        if action not in ("approve", "override"):
            self.send_json({"error": "action must be 'approve' or 'override'."}, status=400)
            return

        with get_db() as conn:
            rec = conn.execute("SELECT * FROM recommendations WHERE id = ?", (int(rec_id),)).fetchone()
        if rec is None:
            self.send_json({"error": "Recommendation not found."}, status=404)
            return
        if rec["status"] != "pending":
            self.send_json({"error": "This recommendation already has a decision."}, status=409)
            return

        final = rec["posture"]
        if action == "override":
            final = payload.get("posture")
            if final not in POSTURE_RANK:
                self.send_json({"error": f"posture must be one of {POSTURE_ORDER}."}, status=400)
                return
            if not reason:
                self.send_json({"error": "An override requires a reason."}, status=400)
                return

        package = finalize_decision(rec, action, final, reason, employee["user_id"])
        if package is None:
            self.send_json({"error": "This recommendation already has a decision."}, status=409)
            return
        self.send_json({"id": int(rec_id), "status": "approved" if action == "approve" else "overridden",
                        "finalPosture": final, "package": package})

    # ----- employee location (mobile app) -----
    def h_consent(self, employee, query):
        payload = self.read_json_object()
        if payload is None:
            return
        if not isinstance(payload.get("consent"), bool):
            self.send_json({"error": "consent must be true or false."}, status=400)
            return
        consent = payload["consent"]
        with get_db() as conn:
            conn.execute("INSERT INTO employee_flags (user_id, location_consent) VALUES (?, ?) "
                         "ON CONFLICT(user_id) DO UPDATE SET location_consent = excluded.location_consent",
                         (employee["user_id"], 1 if consent else 0))
            if not consent:  # turning sharing off also deletes the stored location
                conn.execute("DELETE FROM employee_location WHERE user_id = ?", (employee["user_id"],))
        self.send_json({"locationSharing": consent})

    def h_location_update(self, employee, query):
        payload = self.read_json_object()
        if payload is None:
            return
        try:
            lat, lon = float(payload["lat"]), float(payload["lon"])
        except (KeyError, TypeError, ValueError):
            self.send_json({"error": "lat and lon must be numbers."}, status=400)
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            self.send_json({"error": "lat or lon out of range."}, status=400)
            return

        with get_db() as conn:
            flag = conn.execute("SELECT location_consent FROM employee_flags WHERE user_id = ?",
                                (employee["user_id"],)).fetchone()
        if not flag or not flag["location_consent"]:
            self.send_json({"error": "Location sharing is off. Turn it on first."}, status=403)
            return

        result = process_location(employee["user_id"], lat, lon)
        if result is None:
            self.send_json({"error": f"Updates are limited to one every {MIN_LOCATION_INTERVAL_SECONDS} seconds."},
                           status=429)
            return
        self.send_json(result)

    def h_my_notifications(self, employee, query):
        with get_db() as conn:
            rows = conn.execute("SELECT id, created_at, kind, alert_id, channel, message, status "
                                "FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20",
                                (employee["user_id"],)).fetchall()
        self.send_json([dict(r) for r in rows])

    # ----- decision log -----
    def h_log(self, employee, query):
        with get_db() as conn:
            rows = conn.execute("SELECT * FROM decision_log ORDER BY id DESC LIMIT 100").fetchall()
        self.send_json([{**dict(r), "payload": json.loads(r["payload_json"])} for r in rows])

    def h_log_verify(self, employee, query):
        self.send_json(verify_log())

    # ----- entries (from the original Fieldcast code) -----
    def h_entries_list(self, employee, query):
        with get_db() as conn:
            rows = conn.execute("SELECT id, employee_id, title, description, created_at "
                                "FROM entries ORDER BY id DESC").fetchall()
        self.send_json([{"id": r["id"], "employeeId": r["employee_id"], "title": r["title"],
                         "description": r["description"], "createdAt": r["created_at"]} for r in rows])

    def h_entries_create(self, employee, query):
        payload = self.read_json_object()
        if payload is None:
            return
        title, description = payload.get("title"), payload.get("description", "")
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
            self.send_json({"error": "Title must be between 1 and 120 characters."}, status=400)
            return
        if not isinstance(description, str) or len(description) > 1000:
            self.send_json({"error": "Description must be 1,000 characters or fewer."}, status=400)
            return
        created_at = now_iso()
        with get_db() as conn:
            entry_id = conn.execute("INSERT INTO entries (employee_id, title, description, created_at) "
                                    "VALUES (?, ?, ?, ?) RETURNING id",
                                    (employee["user_id"], title.strip(), description.strip(), created_at)
                                    ).fetchone()[0]
        self.send_json({"id": entry_id, "employeeId": employee["user_id"], "title": title.strip(),
                        "description": description.strip(), "createdAt": created_at}, status=201)

    # ----- shared helpers -----
    def session_cookie(self, token, clear=False):
        secure = self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https"
        cookie = f"fieldcastSession={token}; Path=/; HttpOnly; SameSite=Lax"
        if clear:
            cookie += "; Max-Age=0"
        else:
            cookie += f"; Max-Age={SESSION_HOURS * 3600}"
        if secure:
            cookie += "; Secure"
        return cookie

    def session_token(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[len("Bearer "):]
        for cookie in self.headers.get("Cookie", "").split(";"):
            name, separator, value = cookie.strip().partition("=")
            if separator and name == "fieldcastSession":
                return value
        return ""

    def current_employee(self):
        token = self.session_token()
        if not token:
            return None
        with sessions_lock:
            entry = sessions.get(token)
            if entry and entry[1] < monotonic():
                del sessions[token]
                entry = None
        return {"user_id": entry[0]} if entry else None

    def read_json_object(self, max_bytes=MAX_REQUEST_BYTES):
        """Read a JSON object body. Sends the error itself and returns None on failure."""
        try:
            body_length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self.send_json({"error": "Invalid Content-Length header."}, status=400)
            return None
        if body_length <= 0:
            self.send_json({"error": "Request body is required."}, status=400)
            return None
        if body_length > max_bytes:
            self.send_json({"error": f"Request body must be {max_bytes:,} bytes or fewer."}, status=413)
            return None
        try:
            payload = json.loads(self.rfile.read(body_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"error": "Request body must contain valid JSON."}, status=400)
            return None
        if not isinstance(payload, dict):
            self.send_json({"error": "Request body must be a JSON object."}, status=400)
            return None
        return payload

    def send_json(self, payload, status=200, headers=None):
        response = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(response)


def main():
    init_db()
    if AUTO_SCAN_MINUTES > 0:
        Thread(target=scan_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), ClosureCallHandler)
    print(f"Closure Call server running at http://{HOST}:{PORT}")
    print("Database: PostgreSQL (DATABASE_URL)")
    print(f"Facility auto-scan: {'every %d min' % AUTO_SCAN_MINUTES if AUTO_SCAN_MINUTES else 'off'}")
    print(f"Auto-send without manager approval: {'ON (min confidence ' + AUTO_DECIDE_MIN_CONFIDENCE + ')' if AUTO_DECIDE else 'off'}")
    print(f"All-clear messages: {'ON (hold ' + str(ALL_CLEAR_HOLD_MINUTES) + ' min)' if ALL_CLEAR else 'off'}")
    print(f"Notification delivery: {'webhook' if NOTIFY_WEBHOOK_URL else 'simulated (no NOTIFY_WEBHOOK_URL)'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Closure Call server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()