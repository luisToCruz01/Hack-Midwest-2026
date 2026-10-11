# Fieldcast Safety Dashboard

A web dashboard for employee schedules, work-site weather, and safety alerts.
The main backend stores the employee roster in PostgreSQL; a separate SQLite
database supports the standalone read-only mobile API.

## Requirements

- Python 3.10 or newer

## Run locally

From the project root, start the server:

```powershell
python backend/server.py
```

Open <http://127.0.0.1:3000>. Set the `PORT` environment variable to use a
different port.

To run the standalone read-only API for the mobile app, start a second server:

```powershell
python backend/mobile_api.py
```

It listens on <http://127.0.0.1:3001> by default. Set `MOBILE_API_HOST` or
`MOBILE_API_PORT` to change its bind address or port.

The Employees page reads the employee roster from PostgreSQL through
`GET /api/employees`. Employee details shown there come from the database;
working/off-shift status is calculated from each employee's workdays and shift
times. Dashboard alert and work-site edits are sample frontend state and reset
when the page reloads. The mobile server exposes `GET /api/health` and
`GET /api/employees`; the main server also provides login, weather-alert
snapshots, and field reports.

The overview work-site selector lists locations from the main database. The
map geocodes a selected location's address with the U.S. Census Geocoder, then
falls back to its locality through OpenStreetMap Nominatim. If geocoding is
unavailable, it uses the saved site coordinates. It shows the NWS hourly
temperature, wind, precipitation probability, humidity, and active alert
polygons on OpenStreetMap tiles through Leaflet. Internet access is required,
but no map API key. Configure or update fallback coordinates through the
manager-only `PUT /api/locations/<id>` endpoint.

Sign-in is role-aware: managers open the admin dashboard; employees open a
personal alerts page. Sign-in currently accepts only a six-digit user ID and
is a demo stub, not secure authentication.

Employees can opt in to location-based personal NWS alerts on the employee
page. In this website, location checks run about once a minute only while that
page is open and visible; browsers may pause background tabs. The latest
location is deleted when location sharing is turned off and otherwise expires
after 24 hours. Email alerts are a separate employee opt-in and require an
email address on the employee profile.

To enable Gmail email delivery, copy the following settings to
`backend/.env` locally, or configure them as environment variables in your
deployment platform. Do not commit credentials:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_ADDRESS=
```

For Gmail, enable 2-Step Verification and generate an App Password for the
account; use that App Password as `SMTP_PASSWORD`, not the account password.
The health endpoint reports `smtp` only when the SMTP credentials are
configured. Load employee email addresses through the manager employee
contacts import; each employee must opt in on their alerts page. An email
record marked `sent` means Gmail accepted the message for sending, not that it
arrived in the recipient's inbox.

Managers can review recent notification records in the dashboard's Delivery
log, including simulated, sent, and failed statuses. Alternatively,
`NOTIFY_WEBHOOK_URL` hands records to a custom delivery service. A `sent`
record means the provider accepted the request; it does not confirm delivery
to or receipt by the recipient.

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
