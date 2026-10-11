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

To run the separate read-only roster API, start a second server:

```powershell
python backend/mobile_api.py
```

It listens on <http://127.0.0.1:3001> by default. Set `MOBILE_API_HOST` or
`MOBILE_API_PORT` to change its bind address or port. This read-only endpoint is
not used by the native employee app.

The native employee app is in `mobile/`. It signs in with an employee ID,
requests consent for background location sharing, and posts locations to the
main backend to check for personal NWS alerts. See [mobile/README.md](mobile/README.md)
for setup. ID-only sign-in and local notifications are prototype behavior;
production authentication and remote push delivery are not configured.

Employees can also sign in from the website at `/login.html`. Employee accounts
open the web employee portal at `/employee.html`, where they can see their work
schedule and personal alerts. Optional browser location sharing requires explicit
permission and only sends updates while the portal remains open; background
sharing requires the native mobile app. Manager IDs listed in `MANAGER_IDS`
open the admin dashboard, even when they are not part of the employee roster.
Other valid employee IDs open the employee portal. Employees can save an email
address and opt in to work-site and personal email notifications from their
portal. Real email delivery requires the organization's notification webhook to
be configured with an email provider.

The Employees page reads the employee roster from SQLite through
`GET /api/employees`. Employee details shown there come from the database;
working/off-shift status is calculated from each employee's workdays and shift
times. Dashboard alert and work-site edits are sample frontend state and reset
when the page reloads. The mobile server exposes `GET /api/health` and
`GET /api/employees`; the main server also provides login, weather-alert
snapshots, and SQLite-backed field reports.

Managers can edit an employee's name, phone, work site, and schedule from the
Employees page. Changes are saved through `PUT /api/admin/employees/<userId>`.
Sign in with a manager ID configured in `MANAGER_IDS`; employee IDs are fixed,
and working status is recalculated from the saved schedule.

Managers can view recent live locations shared by employees on the Live locations
page. The manager-only `GET /api/admin/employee-locations` endpoint returns only
employees who opted in through the mobile app; turning sharing off deletes that
employee's stored location, and locations without a device update in the last five
minutes are excluded from the live view. Stored employee locations are deleted
after 24 hours.

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
phone number and location ID, name, and address. `database/fieldcast.db` is the local SQLite
roster used by the standalone mobile API. The main dashboard backend uses
PostgreSQL through `DATABASE_URL`; on its first startup against an empty
database, it seeds the roster from `database/schema_postgres.sql` and adds its
application tables.

To create or rebuild the seeded database from the project root (replaces the
existing database file):

```powershell
python -c "import sqlite3; from pathlib import Path; p = Path('database/fieldcast.db'); p.unlink(missing_ok=True); db = sqlite3.connect(p); db.executescript(Path('database/schema.sql').read_text(encoding='utf-8')); db.close()"
```

## Deploy to Render

The root `render.yaml` is a Render Blueprint for the Python web service. Sync
the Blueprint after changing it so Render uses its build command, which
installs `requirements.txt` before compiling the backend. Configure the
Blueprint's `DATABASE_URL` environment variable in Render with the connection
URL for the existing Render PostgreSQL database; keep that credential in
Render and do not commit it. The backend uses PostgreSQL, not the SQLite
`DB_PATH` setting. On first startup with an empty database, it initializes the
roster from `database/schema_postgres.sql`.

## Project structure

- `frontend/` — HTML, CSS, and browser JavaScript
- `backend/server.py` — dashboard server and mobile-app API
- `backend/mobile_api.py` — standalone read-only employee API for the mobile app
- `database/schema.sql` — location and employee tables plus roster seed data
- `database/fieldcast.db` — populated SQLite employee database
- `render.yaml` — Render Blueprint for the web service and persistent disk
