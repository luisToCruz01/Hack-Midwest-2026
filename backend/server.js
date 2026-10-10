import Database from "better-sqlite3";
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(backendDirectory, "..");
const databasePath = path.join(projectDirectory, "database", "app.sqlite");
const schemaPath = path.join(projectDirectory, "database", "schema.sql");
const frontendDirectory = path.join(projectDirectory, "frontend");

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.exec(readFileSync(schemaPath, "utf8"));

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get("/api/health", (_request, response) => {
  database.prepare("SELECT 1").get();
  response.json({ status: "ok", database: "connected" });
});

app.get("/api/entries", (_request, response) => {
  const entries = database
    .prepare(
      "SELECT id, title, description, created_at AS createdAt FROM entries ORDER BY id DESC",
    )
    .all();

  response.json(entries);
});

app.post("/api/entries", (request, response) => {
  const { title, description = "" } = request.body ?? {};

  if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > 120) {
    response.status(400).json({ error: "Title must be between 1 and 120 characters." });
    return;
  }

  if (typeof description !== "string" || description.length > 1000) {
    response.status(400).json({ error: "Description must be 1,000 characters or fewer." });
    return;
  }

  const result = database
    .prepare("INSERT INTO entries (title, description) VALUES (?, ?)")
    .run(title.trim(), description.trim());
  const entry = database
    .prepare(
      "SELECT id, title, description, created_at AS createdAt FROM entries WHERE id = ?",
    )
    .get(result.lastInsertRowid);

  response.status(201).json(entry);
});

app.use(express.static(frontendDirectory));

app.listen(port, () => {
  console.log(`Hack Midwest app running at http://localhost:${port}`);
});
