"""Standard library only. Run:  python server.py
Put this file in a subfolder (like backend/) next to your frontend/ folder,
since PROJECT_DIRECTORY below is the parent of this file's folder.

Routes
  GET  /api/health
  POST /api/login                 {"employeeId": "emp001"}  -> {"token": ...}
  GET  /api/alerts?lat=..&lon=..  fetches live NWS alerts, saves a snapshot
  GET  /api/snapshots             recent snapshot metadata
  GET  /api/snapshots/<id>        full snapshot including the raw NWS payload
  GET  /api/entries
  POST /api/entries               needs "Authorization: Bearer <token>"
"""
import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.error import URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen


PROJECT_DIRECTORY = Path(__file__).resolve().parent.parent
FRONTEND_DIRECTORY = PROJECT_DIRECTORY / "frontend"
DATABASE_PATH = PROJECT_DIRECTORY / "database" / "fieldcast.db"
DB_PATH = Path(os.environ.get("DB_PATH", PROJECT_DIRECTORY / "closure_call.db"))
ROSTER_SCHEMA_PATH = PROJECT_DIRECTORY / "database" / "schema.sql"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "3000"))
MAX_REQUEST_BYTES = 16_384

# NWS asks every client to identify itself. Change the email.
NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
NWS_HEADERS = {
    "User-Agent": os.environ.get("NWS_USER_AGENT", "ClosureCall/0.1 (your-email@example.com)"),
    "Accept": "application/geo+json",
}

# Stub login: synthetic employees only. Replace with real auth later.
DEMO_EMPLOYEES = {
    "emp001": "Demo Employee One",
    "emp002": "Demo Employee Two",
}
sessions: dict[str, str] = {}  # token -> employee_id
sessions_lock = Lock()


# ---------- helpers ----------

def now_iso():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:  # commits on success, rolls back on error
            yield conn
    finally:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        location_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(locations)")
        }
        if location_columns and "address" not in location_columns:
            conn.execute(
                "ALTER TABLE locations ADD COLUMN address TEXT NOT NULL DEFAULT ''"
            )
        employee_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(employees)")
        }
        if employee_columns and "phone_number" not in employee_columns:
            conn.execute(
                "ALTER TABLE employees ADD COLUMN phone_number TEXT NOT NULL DEFAULT ''"
            )
        conn.executescript(ROSTER_SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id TEXT,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                lat REAL,
                lon REAL,
                fetched_at TEXT NOT NULL,
                ok INTEGER NOT NULL,
                error TEXT,
                raw_json TEXT
            );
            """
        )


# ---------- NWS ingest ----------

def fetch_nws_alerts(lat, lon):
    """Return a snapshot dict. Failures are recorded, not hidden."""
    fetched_at = now_iso()
    url = f"{NWS_ALERTS_URL}?{urlencode({'point': f'{lat},{lon}'})}"
    try:
        with urlopen(Request(url, headers=NWS_HEADERS), timeout=10) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        return {"source": "nws_alerts", "ok": True, "fetched_at": fetched_at,
                "error": None, "raw": raw}
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError) as err:
        return {"source": "nws_alerts", "ok": False, "fetched_at": fetched_at,
                "error": str(err), "raw": None}


def summarize_alerts(raw):
    """Pull out the fields the rules engine will care about."""
    if not raw:
        return []
    alerts = []
    for feature in raw.get("features", []):
        p = feature.get("properties", {})
        alerts.append({
            "event": p.get("event"),
            "severity": p.get("severity"),    # Minor / Moderate / Severe / Extreme
            "certainty": p.get("certainty"),  # Possible / Likely / Observed ...
            "urgency": p.get("urgency"),      # Future / Expected / Immediate ...
            "effective": p.get("effective"),
            "expires": p.get("expires"),
            "headline": p.get("headline"),
        })
    return alerts


def save_snapshot(snapshot, lat, lon):
    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO snapshots (source, lat, lon, fetched_at, ok, error, raw_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                snapshot["source"], lat, lon, snapshot["fetched_at"],
                1 if snapshot["ok"] else 0, snapshot["error"],
                json.dumps(snapshot["raw"]) if snapshot["raw"] is not None else None,
            ),
        )
        return cursor.lastrowid


# ---------- HTTP handler ----------

class ClosureCallHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIRECTORY), **kwargs)

    # ----- GET -----
    def do_GET(self):
        parts = urlsplit(self.path)
        route = parts.path

        if route == "/api/health":
            self.send_json({"status": "ok", "storage": "sqlite", "time": now_iso()})
            return

        if route == "/api/alerts":
            self.handle_alerts(parse_qs(parts.query))
            return

        if route == "/api/snapshots":
            with get_db() as conn:
                rows = conn.execute(
                    "SELECT id, source, lat, lon, fetched_at, ok, error "
                    "FROM snapshots ORDER BY id DESC LIMIT 20"
                ).fetchall()
            self.send_json([dict(r) for r in rows])
            return

        if route.startswith("/api/snapshots/"):
            self.handle_snapshot_detail(route.rsplit("/", 1)[-1])
            return

        if route == "/api/employees":
            try:
                database_uri = f"{DATABASE_PATH.as_uri()}?mode=ro"
                with sqlite3.connect(database_uri, uri=True) as database:
                    employees = database.execute(
                        """
                        SELECT e.user_id, e.full_name, e.phone_number,
                               e.shift_start, e.shift_end,
                               e.days_of_week, l.location_id, l.name, l.address
                        FROM employees AS e
                        JOIN locations AS l ON l.location_id = e.location_id
                        ORDER BY full_name COLLATE NOCASE
                        """
                    ).fetchall()
            except sqlite3.Error as error:
                self.log_error("Unable to read employee database: %s", error)
                self.send_json({"error": "Unable to load employees from the database."}, status=500)
                return

            self.send_json([
                {
                    "userId": user_id,
                    "fullName": full_name,
                    "phoneNumber": phone_number,
                    "shiftStart": shift_start,
                    "shiftEnd": shift_end,
                    "daysOfWeek": days_of_week,
                    "locationId": location_id,
                    "locationName": location_name,
                    "locationAddress": location_address,
                }
                for (
                    user_id, full_name, phone_number, shift_start, shift_end,
                    days_of_week, location_id, location_name, location_address,
                ) in employees
            ])
            return

        if route == "/api/entries":
            with get_db() as conn:
                rows = conn.execute(
                    "SELECT id, employee_id, title, description, created_at "
                    "FROM entries ORDER BY id DESC"
                ).fetchall()
            self.send_json([self.entry_json(r) for r in rows])
            return

        if route.startswith("/api/"):
            self.send_json({"error": "API route not found."}, status=404)
            return

        if route == "/":
            self.path = "/index.html"
        super().do_GET()

    def handle_alerts(self, query):
        try:
            lat = round(float(query.get("lat", [""])[0]), 4)
            lon = round(float(query.get("lon", [""])[0]), 4)
        except ValueError:
            self.send_json({"error": "lat and lon must be numbers."}, status=400)
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            self.send_json({"error": "lat or lon out of range."}, status=400)
            return

        snapshot = fetch_nws_alerts(lat, lon)
        snapshot_id = save_snapshot(snapshot, lat, lon)
        self.send_json({
            "snapshotId": snapshot_id,
            "source": snapshot["source"],
            "fetchedAt": snapshot["fetched_at"],
            "ok": snapshot["ok"],
            "error": snapshot["error"],
            "alerts": summarize_alerts(snapshot["raw"]),
        })

    def handle_snapshot_detail(self, raw_id):
        if not raw_id.isdigit():
            self.send_json({"error": "Snapshot id must be a number."}, status=400)
            return
        with get_db() as conn:
            row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (int(raw_id),)).fetchone()
        if row is None:
            self.send_json({"error": "Snapshot not found."}, status=404)
            return
        data = dict(row)
        data["raw"] = json.loads(data.pop("raw_json")) if data["raw_json"] else None
        self.send_json(data)

    # ----- POST -----
    def do_POST(self):
        route = urlsplit(self.path).path

        if route == "/api/login":
            self.handle_login()
        elif route == "/api/entries":
            self.handle_create_entry()
        else:
            self.send_json({"error": "API route not found."}, status=404)

    def handle_login(self):
        payload = self.read_json_object()
        if payload is None:
            return
        employee_id = payload.get("employeeId")
        if employee_id not in DEMO_EMPLOYEES:
            self.send_json({"error": "Unknown employee."}, status=401)
            return
        token = secrets.token_urlsafe(24)
        with sessions_lock:
            sessions[token] = employee_id
        self.send_json({"token": token, "employeeId": employee_id,
                        "name": DEMO_EMPLOYEES[employee_id]})

    def handle_create_entry(self):
        employee_id = self.current_employee()
        if employee_id is None:
            self.send_json({"error": "Login required."}, status=401)
            return

        payload = self.read_json_object()
        if payload is None:
            return

        title = payload.get("title")
        description = payload.get("description", "")
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
            self.send_json({"error": "Title must be between 1 and 120 characters."}, status=400)
            return
        if not isinstance(description, str) or len(description) > 1000:
            self.send_json({"error": "Description must be 1,000 characters or fewer."}, status=400)
            return

        created_at = now_iso()
        with get_db() as conn:
            cursor = conn.execute(
                "INSERT INTO entries (employee_id, title, description, created_at) "
                "VALUES (?, ?, ?, ?)",
                (employee_id, title.strip(), description.strip(), created_at),
            )
            entry_id = cursor.lastrowid

        self.send_json({
            "id": entry_id,
            "employeeId": employee_id,
            "title": title.strip(),
            "description": description.strip(),
            "createdAt": created_at,
        }, status=201)

    # ----- shared helpers -----
    def current_employee(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        with sessions_lock:
            return sessions.get(header[len("Bearer "):])

    def read_json_object(self):
        """Read and validate a JSON object body. Sends the error itself and returns None on failure."""
        try:
            body_length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self.send_json({"error": "Invalid Content-Length header."}, status=400)
            return None

        if body_length <= 0:
            self.send_json({"error": "Request body is required."}, status=400)
            return None
        if body_length > MAX_REQUEST_BYTES:
            self.send_json({"error": "Request body must be 16,384 bytes or fewer."}, status=413)
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

    @staticmethod
    def entry_json(row):
        return {
            "id": row["id"],
            "employeeId": row["employee_id"],
            "title": row["title"],
            "description": row["description"],
            "createdAt": row["created_at"],
        }

    def send_json(self, payload, status=200):
        response = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), ClosureCallHandler)
    print(f"Closure Call server running at http://{HOST}:{PORT}")
    print(f"Database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Closure Call server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()