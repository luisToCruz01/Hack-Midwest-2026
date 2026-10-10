# Fieldcast Admin Dashboard

A frontend prototype for managing employees, schedules, alerts, and work-site
details. The Python server serves the static frontend and provides a small
in-memory starter API; it does not use a database.

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

## Project structure

- `frontend/` — HTML, CSS, and browser JavaScript
- `backend/server.py` — Python static-file server and in-memory JSON API
- `database/schema.sql` — unused starter schema; this prototype does not connect
  to a database
