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

The Employees page reads the employee roster from SQLite through
`GET /api/employees`. Employee details shown there come from the database;
working/off-shift status is calculated from each employee's workdays and shift
times. Alerts and work-site edits are sample frontend state and reset when the
page reloads. The starter `GET /api/entries` and `POST /api/entries` endpoints
also keep data in memory only.

## Employee database

`database/fieldcast.db` is a SQLite database seeded with the 30 employees,
their shift times, workdays, and user IDs. User IDs are stored as text to
preserve leading zeros. The SQL schema and roster data are in
`database/schema.sql`. To create or refresh the database from the project root:

```powershell
python -c "import sqlite3; db = sqlite3.connect('database/fieldcast.db'); db.executescript(open('database/schema.sql', encoding='utf-8').read()); db.close()"
```

## Project structure

- `frontend/` — HTML, CSS, and browser JavaScript
- `backend/server.py` — Python static-file server and in-memory JSON API
- `database/schema.sql` — employee table definition and roster seed data
- `database/fieldcast.db` — populated SQLite employee database
