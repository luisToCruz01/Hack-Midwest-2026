import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit


PROJECT_DIRECTORY = Path(__file__).resolve().parent.parent
FRONTEND_DIRECTORY = PROJECT_DIRECTORY / "frontend"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "3000"))
MAX_REQUEST_BYTES = 16_384

entries: list[dict[str, int | str]] = []
entries_lock = Lock()
next_entry_id = 1


class FieldcastHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIRECTORY), **kwargs)

    def do_GET(self):
        route = urlsplit(self.path).path

        if route == "/api/health":
            self.send_json({"status": "ok", "storage": "in-memory"})
            return

        if route == "/api/entries":
            with entries_lock:
                current_entries = list(reversed(entries))
            self.send_json(current_entries)
            return

        if route.startswith("/api/"):
            self.send_json({"error": "API route not found."}, status=404)
            return

        if route == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        route = urlsplit(self.path).path
        if route != "/api/entries":
            self.send_json({"error": "API route not found."}, status=404)
            return

        content_length = self.headers.get("Content-Length")
        try:
            body_length = int(content_length or "0")
        except ValueError:
            self.send_json({"error": "Invalid Content-Length header."}, status=400)
            return

        if body_length <= 0 or body_length > MAX_REQUEST_BYTES:
            self.send_json({"error": "Request body must be between 1 and 16,384 bytes."}, status=413)
            return

        try:
            payload = json.loads(self.rfile.read(body_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"error": "Request body must contain valid JSON."}, status=400)
            return

        if not isinstance(payload, dict):
            self.send_json({"error": "Request body must be a JSON object."}, status=400)
            return

        title = payload.get("title")
        description = payload.get("description", "")
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
            self.send_json({"error": "Title must be between 1 and 120 characters."}, status=400)
            return
        if not isinstance(description, str) or len(description) > 1000:
            self.send_json({"error": "Description must be 1,000 characters or fewer."}, status=400)
            return

        global next_entry_id
        with entries_lock:
            entry = {
                "id": next_entry_id,
                "title": title.strip(),
                "description": description.strip(),
                "createdAt": "Just now",
            }
            next_entry_id += 1
            entries.append(entry)

        self.send_json(entry, status=201)

    def send_json(self, payload, status=200):
        response = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response)


def main():
    server = ThreadingHTTPServer((HOST, PORT), FieldcastHandler)
    print(f"Fieldcast frontend server running at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Fieldcast server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
