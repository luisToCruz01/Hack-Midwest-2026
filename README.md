# Fieldcast Admin Dashboard

A dashboard prototype for employee schedules and work-site details, alongside
a starter mobile API for employee login, alerts, and field reports. The
employee roster and mobile reports are stored in SQLite.

## Requirements

- Python 3.10 or newer

## Run locally

From the project root, start the server:

```powershell
python backend/server.py
```

Open <http://127.0.0.1:3000> for the landing page (it redirects to `/landing/`).
The admin dashboard is at <http://127.0.0.1:3000/dashboard>. Set the `PORT`
environment variable to use a different port.

To run the standalone read-only API for the mobile app, start a second server:

```powershell
python backend/mobile_api.py
```

It listens on <http://127.0.0.1:3001> by default. Set `MOBILE_API_HOST` or
`MOBILE_API_PORT` to change its bind address or port.

The Employees page reads the employee roster from SQLite through
`GET /api/employees`. Employee details shown there come from the database;
working/off-shift status is calculated from each employee's workdays and shift
times. Dashboard alert and work-site edits are sample frontend state and reset
when the page reloads. The mobile server exposes `GET /api/health` and
`GET /api/employees`; the main server also provides login, weather-alert
snapshots, and SQLite-backed field reports.

The overview work-site selector lists locations from the main database. The
map geocodes a selected location's address with the U.S. Census Geocoder, then
falls back to its locality through OpenStreetMap Nominatim. If geocoding is
unavailable, it uses the saved site coordinates. It shows the NWS hourly
temperature, wind, precipitation probability, humidity, and active alert
polygons on OpenStreetMap tiles through Leaflet. Internet access is required,
but no map API key. Configure or update fallback coordinates through the
manager-only `PUT /api/locations/<id>` endpoint.

## Employee database

`database/fieldcast.db` is a SQLite database seeded with the 200 supplied
location names and street addresses and 30 employees per location (6,000
employees total). Addresses are stored separately from location names.
Location 001 preserves the original roster, with its first employee named
Andrew Youssef; the other employees and their phone numbers are synthetic
sample data. Andrew's supplied phone number is stored as provided. User IDs
are stored as text to preserve leading zeros. The SQL schema and roster data
are in `database/schema.sql`. Employee API responses include each person's
phone number and location ID, name, and address. On startup, the backend
applies this seed schema to its active database (`closure_call.db` by default),
alongside the entries and alert snapshot tables.

To create or rebuild the seeded database from the project root (replaces the
existing database file):

```powershell
python -c "import sqlite3; from pathlib import Path; p = Path('database/fieldcast.db'); p.unlink(missing_ok=True); db = sqlite3.connect(p); db.executescript(Path('database/schema.sql').read_text(encoding='utf-8')); db.close()"
```

## Deploy to Render

The root `render.yaml` is a Render Blueprint for the Python web service. In
Render, choose **New > Blueprint**, connect this repository, and deploy the
`fieldcast` service. The Blueprint mounts a persistent disk at `/var/data` and
stores the SQLite database at `/var/data/closure_call.db`; the roster is
initialized automatically when the service starts. The service uses a Starter
plan because Render persistent disks require a paid instance. SQLite on a
persistent disk is intended for this single service instance, not horizontal
scaling.

## Project structure

- `frontend/` — HTML, CSS, and browser JavaScript
- `backend/server.py` — dashboard server and mobile-app API
- `backend/mobile_api.py` — standalone read-only employee API for the mobile app
- `database/schema.sql` — location and employee tables plus roster seed data
- `database/fieldcast.db` — populated SQLite employee database
- `render.yaml` — Render Blueprint for the web service and persistent disk
