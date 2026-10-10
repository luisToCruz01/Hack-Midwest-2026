# Fieldcast Admin Dashboard

A frontend prototype for managing employees, schedules, alerts, and work-site
details. The Python server serves the static frontend and provides a small
in-memory starter API. A SQLite database contains the employee roster.

## Requirements

- Python 3.10 or newer

## Run locally

From the project root, start the server:

```powershell
python backend/server.py
```

Open <http://127.0.0.1:3000>. Set the `PORT` environment variable to use a
different port.

The dashboard’s employees, schedules, alerts, and work-site edits are sample
frontend state and reset when the page reloads. The starter `GET /api/entries`
and `POST /api/entries` endpoints also keep data in memory only.

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
- `backend/server.py` — Python static-file server and in-memory JSON API
- `database/schema.sql` — location and employee tables plus roster seed data
- `database/fieldcast.db` — populated SQLite employee database
