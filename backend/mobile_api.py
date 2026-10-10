import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PROJECT_DIRECTORY = Path(__file__).resolve().parent.parent
DATABASE_PATH = PROJECT_DIRECTORY / "database" / "fieldcast.db"
HOST = os.environ.get("MOBILE_API_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOBILE_API_PORT", "3001"))


class MobileAPIHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlsplit(self.path).path

        if route == "/api/health":
            self.send_json({"status": "ok"})
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
                self.send_json(
                    {"error": "Unable to load employees from the database."},
                    status=500,
                )
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

        self.send_json({"error": "API route not found."}, status=404)

    def send_json(self, payload, status=200):
        response = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response)


def main():
    server = ThreadingHTTPServer((HOST, PORT), MobileAPIHandler)
    print(f"Fieldcast mobile API running at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Fieldcast mobile API.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
