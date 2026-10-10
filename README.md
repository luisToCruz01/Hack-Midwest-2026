# Hack Midwest 2026

A starter full-stack app with a plain HTML/CSS/JavaScript frontend, an Express
backend, and a SQLite database.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

From the project root, install dependencies and start the server:

```powershell
npm install
npm start
```

Open <http://localhost:3000>. The SQLite database is created automatically at
`database/app.sqlite` the first time the server starts.

## Project structure

- `frontend/` — browser UI and styles
- `backend/server.js` — Express server and JSON API
- `database/schema.sql` — SQLite schema

The API provides `GET /api/health`, `GET /api/entries`, and `POST /api/entries`.