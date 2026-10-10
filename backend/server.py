"""Standard library only. Run:  python server.py
Put this file in a subfolder (like backend/) next to your frontend/ folder,
since PROJECT_DIRECTORY below is the parent of this file's folder.

Routes
  GET  /api/health
  POST /api/login                 {"employeeId": "emp001"}  -> {"token": ...}
  GET  /api/alerts?lat=..&lon=..  fetches live NWS alerts, saves a snapshot
  GET  /api/snapshots             recent snapshot metadata
  GET  /api/snapshots/<id>        full snapshot including the raw NWS payload
  GET  /api/locations             all work-site locations from the roster database
  GET  /api/weather?locationId=.. geocodes a location and returns live NWS conditions
  GET  /api/entries
  POST /api/entries               needs "Authorization: Bearer <token>"
"""
import json
import os
import secrets
import sqlite3
import time
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
NWS_POINTS_URL = "https://api.weather.gov/points"
GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
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
geocode_cache: dict[int, dict] = {}
geocode_cache_lock = Lock()
nominatim_lock = Lock()
last_nominatim_request = 0.0


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
        if not isinstance(raw, dict) or not isinstance(raw.get("features", []), list):
            raise ValueError("NWS alerts returned an invalid response.")
        return {"source": "nws_alerts", "ok": True, "fetched_at": fetched_at,
                "error": None, "raw": raw}
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError) as err:
        return {"source": "nws_alerts", "ok": False, "fetched_at": fetched_at,
                "error": str(err), "raw": None}


def fetch_json(url, headers):
    try:
        with urlopen(Request(url, headers=headers), timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError(f"Unable to fetch live weather data: {error}") from error
    if not isinstance(data, (dict, list)):
        raise RuntimeError("Weather service returned an invalid response.")
    return data


def geocode_location(address, location_id):
    global last_nominatim_request

    with geocode_cache_lock:
        cached = geocode_cache.get(location_id)
    if cached:
        return cached

    census_url = (
        f"{GEOCODER_URL}?{urlencode({'address': address, 'benchmark': 'Public_AR_Current', 'format': 'json'})}"
    )
    census_data = fetch_json(census_url, {"User-Agent": NWS_HEADERS["User-Agent"]})
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
            "matchedAddress": match.get("matchedAddress", address),
            "precision": "address",
        }
    else:
        address_parts = [part.strip() for part in address.split(",")]
        if len(address_parts) < 2 or not address_parts[1]:
            raise LookupError("The selected address could not be geocoded.")
        locality = ", ".join(address_parts[1:])
        params = urlencode({
            "q": locality,
            "format": "jsonv2",
            "limit": 1,
            "countrycodes": "us",
        })
        with nominatim_lock:
            wait_seconds = 1.0 - (time.monotonic() - last_nominatim_request)
            if wait_seconds > 0:
                time.sleep(wait_seconds)
            nominatim_data = fetch_json(
                f"https://nominatim.openstreetmap.org/search?{params}",
                {"User-Agent": "FieldcastAdminDashboard/1.0", "Accept": "application/json"},
            )
            last_nominatim_request = time.monotonic()

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

        if route == "/api/locations":
            try:
                database_uri = f"{DATABASE_PATH.as_uri()}?mode=ro"
                with sqlite3.connect(database_uri, uri=True) as database:
                    locations = database.execute(
                        """
                        SELECT location_id, name, address
                        FROM locations
                        ORDER BY name COLLATE NOCASE
                        """
                    ).fetchall()
            except sqlite3.Error as error:
                self.log_error("Unable to read location database: %s", error)
                self.send_json({"error": "Unable to load locations from the database."}, status=500)
                return

            self.send_json([
                {"locationId": location_id, "name": name, "address": address}
                for location_id, name, address in locations
            ])
            return

        if route == "/api/weather":
            self.handle_weather(parse_qs(parts.query))
            return

        if route == "/api/employees":
            try:
                database_uri = f"{DATABASE_PATH.as_uri()}?mode=ro"
                with sqlite3.connect(database_uri, uri=True) as database:
                    employees = database.execute(
                        """
                        SELECT e.user_id, e.full_name, e.shift_start, e.shift_end,
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
                    "shiftStart": shift_start,
                    "shiftEnd": shift_end,
                    "daysOfWeek": days_of_week,
                    "locationId": location_id,
                    "locationName": location_name,
                    "locationAddress": location_address,
                }
                for (
                    user_id, full_name, shift_start, shift_end, days_of_week,
                    location_id, location_name, location_address,
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

    def handle_weather(self, query):
        raw_location_id = query.get("locationId", [""])[0]
        if not raw_location_id.isdigit() or len(raw_location_id) > 3:
            self.send_json({"error": "locationId must be a number."}, status=400)
            return

        try:
            database_uri = f"{DATABASE_PATH.as_uri()}?mode=ro"
            with sqlite3.connect(database_uri, uri=True) as database:
                location = database.execute(
                    "SELECT location_id, name, address FROM locations WHERE location_id = ?",
                    (int(raw_location_id),),
                ).fetchone()
        except sqlite3.Error as error:
            self.log_error("Unable to read location database: %s", error)
            self.send_json({"error": "Unable to load the selected work site."}, status=500)
            return

        if location is None:
            self.send_json({"error": "Selected work site was not found."}, status=404)
            return
        location_id, name, address = location

        try:
            geocoded = geocode_location(address, location_id)
            latitude = geocoded["latitude"]
            longitude = geocoded["longitude"]

            point_data = fetch_json(
                f"{NWS_POINTS_URL}/{latitude},{longitude}",
                NWS_HEADERS,
            )
            point_properties = point_data.get("properties")
            if not isinstance(point_properties, dict):
                raise ValueError("NWS point response is missing its properties.")
            hourly_url = point_properties.get("forecastHourly")
            if not isinstance(hourly_url, str):
                raise ValueError("NWS point response is missing its hourly forecast URL.")
            forecast_data = fetch_json(hourly_url, NWS_HEADERS)
            forecast_properties = forecast_data.get("properties")
            if not isinstance(forecast_properties, dict):
                raise ValueError("NWS forecast response is missing its properties.")
            periods = forecast_properties.get("periods", [])
            if not isinstance(periods, list) or not periods:
                raise ValueError("NWS did not return an hourly forecast for this location.")
            period = periods[0]
            if not isinstance(period, dict):
                raise ValueError("NWS returned an invalid hourly forecast period.")

            alert_snapshot = fetch_nws_alerts(latitude, longitude)
            snapshot_id = save_snapshot(alert_snapshot, latitude, longitude)
            alert_features = []
            alerts_error = None
            if alert_snapshot["ok"]:
                for feature in alert_snapshot["raw"].get("features", []):
                    if not isinstance(feature, dict):
                        continue
                    properties = feature.get("properties", {})
                    if not isinstance(properties, dict):
                        continue
                    alert_features.append({
                        "event": properties.get("event"),
                        "severity": properties.get("severity"),
                        "headline": properties.get("headline"),
                        "effective": properties.get("effective"),
                        "expires": properties.get("expires"),
                        "geometry": feature.get("geometry"),
                    })
            else:
                alerts_error = "Active NWS alerts are temporarily unavailable."

            precipitation = period.get("probabilityOfPrecipitation") or {}
            humidity = period.get("relativeHumidity") or {}
            if not isinstance(precipitation, dict) or not isinstance(humidity, dict):
                raise ValueError("NWS returned invalid hourly forecast measurements.")
            self.send_json({
                "location": {
                    "id": location_id,
                    "name": name,
                    "address": address,
                    "matchedAddress": geocoded["matchedAddress"],
                    "geocodePrecision": geocoded["precision"],
                },
                "coordinates": {"latitude": latitude, "longitude": longitude},
                "forecast": {
                    "startTime": period.get("startTime"),
                    "temperature": period.get("temperature"),
                    "temperatureUnit": period.get("temperatureUnit"),
                    "windSpeed": period.get("windSpeed"),
                    "windDirection": period.get("windDirection"),
                    "probabilityOfPrecipitation": precipitation.get("value"),
                    "relativeHumidity": humidity.get("value"),
                    "shortForecast": period.get("shortForecast"),
                },
                "alerts": alert_features,
                "alertsError": alerts_error,
                "snapshotId": snapshot_id,
                "updatedAt": now_iso(),
            })
        except LookupError as error:
            self.send_json({"error": str(error)}, status=422)
        except (RuntimeError, ValueError, TypeError, KeyError) as error:
            self.log_error("Unable to load NWS weather for location %s: %s", location_id, error)
            self.send_json({"error": "Unable to load live weather for the selected work site."}, status=502)

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