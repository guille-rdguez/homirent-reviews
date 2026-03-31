#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import errno
import functools
import hashlib
import hmac
import json
import os
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer, ThreadingMixIn
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest


ROOT = Path(__file__).resolve().parent
DEFAULT_AUTH_USER = "admin"
DEFAULT_AUTH_HASH = (
    "a1c9242db87c2a5eddcbe2d90454822297a7c5e84cea7f7a2d3dbc82ffefa21c"
)
DEFAULT_SESSION_HOURS = 12


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Servidor local para homirent.reviews"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host a usar. Ejemplo: 127.0.0.1 o 0.0.0.0",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=4173,
        help="Puerto del servidor local",
    )
    parser.add_argument(
        "--port-tries",
        type=int,
        default=10,
        help="Cuantos puertos consecutivos intentar si el inicial ya esta ocupado",
    )
    return parser.parse_args()


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_session_hours(value: str | None) -> float:
    try:
        hours = float(value or DEFAULT_SESSION_HOURS)
    except ValueError:
        return float(DEFAULT_SESSION_HOURS)
    return hours if hours > 0 else float(DEFAULT_SESSION_HOURS)


def auth_config() -> dict[str, str | int]:
    username = os.environ.get("DASHBOARD_USERNAME", DEFAULT_AUTH_USER)
    explicit_hash = os.environ.get("DASHBOARD_PASSWORD_HASH")
    plain_password = os.environ.get("DASHBOARD_PASSWORD")
    password_hash = explicit_hash or (
        sha256_hex(f"{username}::{plain_password}")
        if plain_password
        else DEFAULT_AUTH_HASH
    )
    session_secret = os.environ.get("DASHBOARD_SESSION_SECRET", password_hash)
    session_ttl_seconds = round(parse_session_hours(os.environ.get("DASHBOARD_SESSION_HOURS")) * 3600)
    return {
        "username": username,
        "password_hash": password_hash,
        "session_secret": session_secret,
        "session_ttl_seconds": session_ttl_seconds,
    }


def base64url_encode(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def base64url_decode(value: str) -> str:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii")).decode("utf-8")


def create_session(username: str) -> dict[str, str]:
    config = auth_config()
    exp = int(time.time()) + int(config["session_ttl_seconds"])
    payload = base64url_encode(json.dumps({"u": username, "exp": exp}, separators=(",", ":")))
    signature = hmac.new(
        str(config["session_secret"]).encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "username": username,
        "sessionToken": f"{payload}.{signature}",
        "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp)),
    }


def verify_session_token(token: str) -> dict[str, str]:
    if not token:
        raise ValueError("Sesion requerida")

    parts = token.split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("Sesion invalida")

    payload, signature = parts
    config = auth_config()
    expected = hmac.new(
        str(config["session_secret"]).encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(signature, expected):
        raise ValueError("Sesion invalida")

    try:
        decoded = json.loads(base64url_decode(payload))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Sesion invalida") from exc

    if decoded.get("u") != config["username"] or not isinstance(decoded.get("exp"), int):
        raise ValueError("Sesion invalida")

    if decoded["exp"] <= int(time.time()):
        raise ValueError("Sesion expirada")

    return {
        "username": str(decoded["u"]),
        "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(decoded["exp"])),
    }


def validate_credentials(username: str, password: str) -> bool:
    config = auth_config()
    digest = sha256_hex(f"{username}::{password}")
    return username == config["username"] and hmac.compare_digest(
        digest, str(config["password_hash"])
    )


def supabase_config() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get(
        "SUPABASE_DASHBOARD_KEY"
    )
    if not url or not key:
        raise RuntimeError(
            "Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para el dashboard seguro"
        )
    return url, key


def supabase_headers(extra_headers: dict[str, str] | None = None) -> dict[str, str]:
    _, key = supabase_config()
    headers = {"apikey": key}
    if not key.startswith("sb_"):
        headers["Authorization"] = f"Bearer {key}"
    if extra_headers:
        headers.update(extra_headers)
    return headers


def supabase_json(path: str) -> list[dict]:
    url, _ = supabase_config()
    req = urlrequest.Request(
        f"{url}/rest/v1/{path}",
        headers=supabase_headers(),
    )
    with urlrequest.urlopen(req, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize_whitespace(value: str) -> str:
    return " ".join(str(value or "").strip().split())


def create_property(name: str, city: str) -> dict:
    normalized_name = normalize_whitespace(name)
    normalized_city = normalize_whitespace(city)
    if not normalized_name or not normalized_city:
        raise RuntimeError("Nombre y ciudad son obligatorios")

    url, _ = supabase_config()
    payload = json.dumps(
        {
            "id": str(uuid.uuid4()),
            "name": normalized_name,
            "city": normalized_city,
            "active": True,
        }
    ).encode("utf-8")
    req = urlrequest.Request(
        f"{url}/rest/v1/properties",
        headers=supabase_headers(
            {
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            }
        ),
        data=payload,
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=25) as response:
        raw = response.read().decode("utf-8").strip()
        created_rows = json.loads(raw) if raw else []
        property_row = created_rows[0] if isinstance(created_rows, list) else created_rows
        if not isinstance(property_row, dict) or not property_row.get("id"):
            raise RuntimeError("Supabase no devolvio el complejo creado")
        return property_row


def delete_review(review_id: str) -> bool:
    normalized_id = review_id.strip()
    if not normalized_id:
        raise RuntimeError("Review invalida")

    url, _ = supabase_config()
    req = urlrequest.Request(
        f"{url}/rest/v1/reviews?id=eq.{urlparse.quote(normalized_id, safe='')}",
        headers=supabase_headers({"Prefer": "return=representation"}),
        method="DELETE",
    )
    with urlrequest.urlopen(req, timeout=25) as response:
        raw = response.read().decode("utf-8").strip()
        deleted_rows = json.loads(raw) if raw else []
        return bool(deleted_rows)


def fetch_dashboard_data() -> dict[str, list[dict]]:
    return {
        "properties": supabase_json(
            "properties?select=id,city,name&active=eq.true&order=city,name"
        ),
        "reviews": supabase_json(
            "reviews?select=id,guest_name,room_name,rating,comment,would_return,source,created_at,property_id,properties(name,city)&order=created_at.desc&limit=2000"
        ),
    }


class ReusableTCPServer(ThreadingMixIn, TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class DashboardRequestHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.handle_api():
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.handle_api():
            return
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Metodo no permitido")

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.endswith(".html") or path.startswith("/api/") or path == "/":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_api(self) -> bool:
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/"):
            return False

        routes = {
            ("POST", "/api/dashboard-login"): self.handle_dashboard_login,
            ("GET", "/api/dashboard-session"): self.handle_dashboard_session,
            ("GET", "/api/dashboard-data"): self.handle_dashboard_data,
            ("POST", "/api/dashboard-create-property"): self.handle_dashboard_create_property,
            ("POST", "/api/dashboard-delete-review"): self.handle_dashboard_delete_review,
            ("POST", "/api/dashboard-logout"): self.handle_dashboard_logout,
        }

        handler = routes.get((self.command, path))
        if not handler:
            allowed = sorted(method for method, route in routes if route == path)
            if allowed:
                self.send_json(
                    HTTPStatus.METHOD_NOT_ALLOWED,
                    {"ok": False, "error": "Metodo no permitido"},
                )
                return True
            self.send_json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "Ruta API no encontrada"},
            )
            return True

        handler()
        return True

    def read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None

        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def bearer_token(self) -> str:
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[7:].strip()
        return ""

    def require_session(self) -> dict[str, str]:
        token = self.bearer_token()
        if not token:
            raise ValueError("Sesion requerida")
        return verify_session_token(token)

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def handle_dashboard_login(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        if not username or not password:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Usuario y contraseña son obligatorios"},
            )
            return

        if not validate_credentials(username, password):
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"ok": False, "error": "Usuario o contraseña incorrectos"},
            )
            return

        self.send_json(HTTPStatus.OK, {"ok": True, **create_session(username)})

    def handle_dashboard_session(self) -> None:
        try:
            session = self.require_session()
        except ValueError as exc:
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"ok": False, "error": str(exc)},
            )
            return

        self.send_json(HTTPStatus.OK, {"ok": True, **session})

    def handle_dashboard_data(self) -> None:
        try:
            self.require_session()
            data = fetch_dashboard_data()
        except ValueError as exc:
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"ok": False, "error": str(exc)},
            )
            return
        except RuntimeError as exc:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": str(exc)},
            )
            return
        except urlerror.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace").strip()
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "ok": False,
                    "error": details or f"Supabase devolvio {exc.code}",
                },
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo conectar a Supabase: {exc.reason}"},
            )
            return

        self.send_json(HTTPStatus.OK, {"ok": True, **data})

    def handle_dashboard_create_property(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        name = str(payload.get("name", ""))
        city = str(payload.get("city", ""))
        if not name.strip() or not city.strip():
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Nombre y ciudad son obligatorios"},
            )
            return

        try:
            self.require_session()
            property_row = create_property(name, city)
        except ValueError as exc:
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"ok": False, "error": str(exc)},
            )
            return
        except RuntimeError as exc:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": str(exc)},
            )
            return
        except urlerror.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace").strip()
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "ok": False,
                    "error": details or f"Supabase devolvio {exc.code}",
                },
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo conectar a Supabase: {exc.reason}"},
            )
            return

        self.send_json(HTTPStatus.OK, {"ok": True, "property": property_row})

    def handle_dashboard_delete_review(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        review_id = str(payload.get("reviewId", "")).strip()
        if not review_id:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "reviewId es obligatorio"},
            )
            return

        try:
            self.require_session()
            deleted = delete_review(review_id)
        except ValueError as exc:
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"ok": False, "error": str(exc)},
            )
            return
        except RuntimeError as exc:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": str(exc)},
            )
            return
        except urlerror.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace").strip()
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "ok": False,
                    "error": details or f"Supabase devolvio {exc.code}",
                },
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo conectar a Supabase: {exc.reason}"},
            )
            return

        if not deleted:
            self.send_json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "La review ya no existe o no se pudo borrar"},
            )
            return

        self.send_json(HTTPStatus.OK, {"ok": True, "deleted": True})

    def handle_dashboard_logout(self) -> None:
        self.send_json(HTTPStatus.OK, {"ok": True})


def print_environment_hints() -> None:
    if not (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_DASHBOARD_KEY")
    ):
        print(
            "Aviso: falta SUPABASE_SERVICE_ROLE_KEY; el dashboard seguro no podra leer datos."
        )
    if not os.environ.get("DASHBOARD_SESSION_SECRET"):
        print(
            "Aviso: DASHBOARD_SESSION_SECRET no esta definido; para produccion conviene configurarlo en el entorno."
        )


def main() -> None:
    load_dotenv(ROOT / ".env")
    args = parse_args()
    handler = functools.partial(DashboardRequestHandler, directory=str(ROOT))
    max_tries = max(1, args.port_tries)

    last_error: OSError | None = None
    httpd = None
    chosen_port = args.port

    for candidate in range(args.port, args.port + max_tries):
        try:
            httpd = ReusableTCPServer((args.host, candidate), handler)
            chosen_port = candidate
            break
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            last_error = exc

    if httpd is None:
        raise RuntimeError(
            f"No encontre un puerto libre entre {args.port} y {args.port + max_tries - 1}"
        ) from last_error

    with httpd:
        base_url = f"http://{args.host}:{chosen_port}"
        print("Servidor local listo")
        print(f"Raiz: {ROOT}")
        if chosen_port != args.port:
            print(f"Puerto {args.port} ocupado, usando {chosen_port}")
        print(f"Inicio: {base_url}/")
        print(f"Formulario: {base_url}/form.html")
        print(f"Dashboard: {base_url}/dashboard.html")
        print(f"API Login: {base_url}/api/dashboard-login")
        print_environment_hints()
        print("Presiona Ctrl+C para detenerlo.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")


if __name__ == "__main__":
    main()
