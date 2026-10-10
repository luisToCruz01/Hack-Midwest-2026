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

Open <http://127.0.0.1:3000>. Set the `PORT` environment variable to use a
different port.

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

## Employee database

`database/fieldcast.db` is a SQLite database seeded with 200 numbered locations
and 30 employees per location (6,000 employees total). Location 001 preserves
the original roster; the other employees are synthetic sample data. User IDs
are stored as text to preserve leading zeros. The SQL schema and roster data
are in `database/schema.sql`.

To create or rebuild the seeded database from the project root (replaces the
existing database file):

```powershell
python -c "import sqlite3; from pathlib import Path; p = Path('database/fieldcast.db'); p.unlink(missing_ok=True); db = sqlite3.connect(p); db.executescript(Path('database/schema.sql').read_text(encoding='utf-8')); db.close()"
```

## Project structure

- `frontend/` — HTML, CSS, and browser JavaScript
- `backend/server.py` — dashboard server and mobile-app API
- `backend/mobile_api.py` — standalone read-only employee API for the mobile app
- `database/schema.sql` — location and employee tables plus roster seed data
- `database/fieldcast.db` — populated SQLite employee database
