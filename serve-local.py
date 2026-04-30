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
import re
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
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
DEFAULT_CLOUDBEDS_API_BASE_URL = "https://api.cloudbeds.com/api/v1.3"
DEFAULT_CLOUDBEDS_SYNC_WINDOW_DAYS = 14
DEFAULT_CLOUDBEDS_BATCH_SIZE = 200


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


def is_placeholder_env_value(value: str | None) -> bool:
    normalized = normalize_whitespace(value).lower()
    if not normalized:
        return True
    return (
        normalized.startswith("tu_")
        or "pega_aqui" in normalized
        or "example" in normalized
        or normalized in {"xxx", "xxxx"}
    )


def decode_jwt_payload(token: str | None) -> dict | None:
    raw = normalize_whitespace(token)
    parts = raw.split(".")
    if len(parts) != 3:
        return None
    try:
        return json.loads(base64url_decode(parts[1]))
    except (ValueError, json.JSONDecodeError):
        return None


def is_service_role_capable_key(value: str | None) -> bool:
    raw = normalize_whitespace(value)
    if not raw or is_placeholder_env_value(raw):
        return False
    if raw.startswith("sb_secret_"):
        return True
    payload = decode_jwt_payload(raw)
    return bool(isinstance(payload, dict) and payload.get("role") == "service_role")


def supabase_config() -> tuple[str, str]:
    raw_url = os.environ.get("SUPABASE_URL")
    raw_service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    raw_dashboard_key = os.environ.get("SUPABASE_DASHBOARD_KEY")
    url = "" if is_placeholder_env_value(raw_url) else str(raw_url)
    if is_service_role_capable_key(raw_service_role_key):
        key = str(raw_service_role_key)
    elif is_service_role_capable_key(raw_dashboard_key):
        key = str(raw_dashboard_key)
    else:
        key = ""
    if not url or not key:
        raise RuntimeError(
            "Faltan SUPABASE_URL y una SUPABASE_SERVICE_ROLE_KEY real. La SUPABASE_DASHBOARD_KEY actual no tiene permisos suficientes para leer el dashboard interno."
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


def normalize_key(value: str | None) -> str:
    normalized = normalize_whitespace(value).lower()
    replacements = str.maketrans(
        {
            "á": "a",
            "é": "e",
            "í": "i",
            "ó": "o",
            "ú": "u",
            "ü": "u",
            "ñ": "n",
        }
    )
    return normalized.translate(replacements)


def slugify(value: str | None) -> str:
    raw = normalize_key(value)
    chars = []
    prev_sep = False
    for ch in raw:
        if ch.isalnum():
            chars.append(ch)
            prev_sep = False
            continue
        if not prev_sep:
            chars.append("_")
            prev_sep = True
    return "".join(chars).strip("_")


def ensure_list(value: object) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def pick(source: dict | None, keys: list[str]) -> object | None:
    for key in keys:
        if not isinstance(source, dict):
            return None
        value = source.get(key)
        if value not in (None, ""):
            return value
    return None


def parse_csv_env(name: str) -> list[str]:
    return [chunk.strip() for chunk in str(os.environ.get(name, "")).split(",") if chunk.strip()]


def parse_cloudbeds_data(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("data", "result", "reservations", "hotels"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("reservations", "hotels"):
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def parse_cloudbeds_object(payload: object) -> dict:
    if not isinstance(payload, dict):
        return {}
    for key in ("data", "result"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    return payload


def to_iso_date(value: object) -> str | None:
    raw = normalize_whitespace(value)
    if not raw:
        return None
    if len(raw) >= 10 and raw[4:5] == "-" and raw[7:8] == "-":
        return raw[:10]
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def to_iso_datetime(value: object) -> str | None:
    raw = normalize_whitespace(value)
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def subtract_days_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def cloudbeds_config() -> dict[str, object]:
    api_key = normalize_whitespace(os.environ.get("CLOUDBEDS_API_KEY"))
    if not api_key:
        raise RuntimeError("Falta CLOUDBEDS_API_KEY en el entorno")
    try:
        window_days = int(os.environ.get("CLOUDBEDS_DEFAULT_SYNC_WINDOW_DAYS", DEFAULT_CLOUDBEDS_SYNC_WINDOW_DAYS))
    except ValueError:
        window_days = DEFAULT_CLOUDBEDS_SYNC_WINDOW_DAYS
    return {
        "api_key": api_key,
        "base_url": normalize_whitespace(os.environ.get("CLOUDBEDS_API_BASE_URL")) or DEFAULT_CLOUDBEDS_API_BASE_URL,
        "configured_property_ids": parse_csv_env("CLOUDBEDS_PROPERTY_IDS"),
        "source_account_id": normalize_whitespace(os.environ.get("CLOUDBEDS_SOURCE_ACCOUNT_ID")) or None,
        "group_account_id": normalize_whitespace(os.environ.get("CLOUDBEDS_GROUP_ACCOUNT_ID")) or None,
        "sync_secret": normalize_whitespace(os.environ.get("CLOUDBEDS_SYNC_SECRET")) or None,
        "default_window_days": max(1, window_days),
    }


def cloudbeds_json(path: str, params: dict[str, object] | None = None) -> object:
    config = cloudbeds_config()
    query = urlparse.urlencode(
        {
            key: ",".join(str(item) for item in value)
            if isinstance(value, list)
            else str(value)
            for key, value in (params or {}).items()
            if value not in (None, "")
        }
    )
    url = f"{str(config['base_url']).rstrip('/')}/{path}"
    if query:
        url = f"{url}?{query}"
    req = urlrequest.Request(
        url,
        headers={
            "x-api-key": str(config["api_key"]),
            "Accept": "application/json",
        },
    )
    with urlrequest.urlopen(req, timeout=35) as response:
        raw = response.read().decode("utf-8").strip()
        return json.loads(raw) if raw else {}


def supabase_upsert_reservations(rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    url, _ = supabase_config()
    payload = json.dumps(rows).encode("utf-8")
    req = urlrequest.Request(
        f"{url}/rest/v1/reservations?on_conflict=cloudbeds_reservation_id",
        headers=supabase_headers(
            {
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=representation",
            }
        ),
        data=payload,
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=35) as response:
        raw = response.read().decode("utf-8").strip()
        return json.loads(raw) if raw else []


def build_cloudbeds_indexes(payload: dict[str, list[dict]]) -> dict[str, dict[str, dict]]:
    by_cloudbeds_id: dict[str, dict] = {}
    by_property_name: dict[str, dict] = {}
    for listing in payload["listings"]:
        candidates = [
            normalize_whitespace(listing.get("external_listing_id")),
            normalize_whitespace(listing.get("external_property_id")),
            normalize_whitespace((listing.get("metadata") or {}).get("cloudbedsPropertyId")),
        ]
        for candidate in candidates:
            if candidate:
                by_cloudbeds_id[candidate] = listing
    for prop in payload["properties"]:
        key = normalize_key(prop.get("name"))
        if key:
            by_property_name[key] = prop
    return {
        "by_cloudbeds_id": by_cloudbeds_id,
        "by_property_name": by_property_name,
    }


def load_cloudbeds_sync_context() -> dict[str, object]:
    try:
        listings = supabase_json(
            "external_listings?select=id,property_id,source_account_id,external_listing_id,external_property_id,display_name,metadata&connector=eq.cloudbeds&active=eq.true"
        )
        accounts = supabase_json(
            "source_accounts?select=id,connector,label,external_account_id&connector=eq.cloudbeds&active=eq.true"
        )
        properties = supabase_json("properties?select=id,name,city&active=eq.true")
    except urlerror.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            details
            or "No se pudo leer external_listings/source_accounts/properties. Corre primero la migracion de Supabase."
        ) from exc
    payload = {
        "listings": listings if isinstance(listings, list) else [],
        "accounts": accounts if isinstance(accounts, list) else [],
        "properties": properties if isinstance(properties, list) else [],
    }
    payload["indexes"] = build_cloudbeds_indexes(payload)
    return payload


def resolve_cloudbeds_source_account_id(
    mapping: dict | None,
    accounts: list[dict],
    config: dict[str, object],
) -> str | None:
    explicit = str(config.get("source_account_id") or "").strip()
    if explicit:
        return explicit
    if isinstance(mapping, dict) and mapping.get("source_account_id"):
        return str(mapping["source_account_id"])
    group_account_id = str(config.get("group_account_id") or "").strip()
    if group_account_id:
        for account in accounts:
            if normalize_whitespace(account.get("external_account_id")) == group_account_id:
                return str(account.get("id") or "") or None
    if len(accounts) == 1:
        return str(accounts[0].get("id") or "") or None
    return None


def resolve_cloudbeds_mapping(
    cloudbeds_property_id: str,
    property_name: str,
    indexes: dict[str, dict[str, dict]],
) -> tuple[dict | None, str | None]:
    direct = indexes["by_cloudbeds_id"].get(cloudbeds_property_id)
    if direct:
        return direct, "cloudbeds_property_id"
    fallback = indexes["by_property_name"].get(normalize_key(property_name))
    if fallback:
        return {
            "id": None,
            "property_id": fallback.get("id"),
            "source_account_id": None,
        }, "property_name"
    return None, None


def fetch_cloudbeds_sources(property_id: str | None) -> dict[str, str]:
    try:
        payload = cloudbeds_json("getSources", {"propertyID": property_id} if property_id else {})
    except (RuntimeError, urlerror.HTTPError, urlerror.URLError):
        return {}
    mapping: dict[str, str] = {}
    for row in parse_cloudbeds_data(payload):
        source_id = normalize_whitespace(pick(row, ["sourceID", "sourceId", "id"]))
        source_name = normalize_whitespace(pick(row, ["sourceName", "name", "title"]))
        if source_id and source_name:
            mapping[source_id] = source_name
    return mapping


def extract_guest(record: dict) -> tuple[str | None, str | None]:
    primary_name = normalize_whitespace(
        pick(record, ["guestName", "mainGuestName", "guest_name", "name", "customerName"])
    )
    if not primary_name:
        primary_name = normalize_whitespace(
            " ".join(
                [
                    normalize_whitespace(pick(record, ["guestFirstName", "firstName"])),
                    normalize_whitespace(pick(record, ["guestLastName", "lastName"])),
                ]
            )
        )
    guests = ensure_list(record.get("guests"))
    primary_guest = guests[0] if guests and isinstance(guests[0], dict) else {}
    fallback_name = normalize_whitespace(
        " ".join(
            [
                normalize_whitespace(pick(primary_guest, ["firstName", "guestFirstName"])),
                normalize_whitespace(pick(primary_guest, ["lastName", "guestLastName"])),
            ]
        )
    ) or normalize_whitespace(
        pick(primary_guest, ["name", "guestName", "fullName", "email"])
    )
    email = normalize_whitespace(
        pick(record, ["guestEmail", "email", "guest_email"])
        or pick(primary_guest, ["email", "guestEmail"])
    )
    return primary_name or fallback_name or None, email or None


def extract_room_name(record: dict) -> str | None:
    direct = normalize_whitespace(
        pick(record, ["roomName", "roomTypeName", "assignedRoomName", "roomType", "room"])
    )
    if direct:
        return direct
    rooms = ensure_list(record.get("rooms"))
    first_room = rooms[0] if rooms and isinstance(rooms[0], dict) else {}
    fallback = normalize_whitespace(
        pick(first_room, ["roomName", "roomTypeName", "roomType", "name"])
    )
    return fallback or None


def normalize_channel(source_name: str | None, source_id: str | None) -> str:
    key = normalize_key(source_name or source_id)
    if not key:
        return "unknown"
    if "booking" in key:
        return "booking"
    if "expedia" in key:
        return "expedia"
    if "airbnb" in key:
        return "airbnb"
    if "vrbo" in key or "homeaway" in key:
        return "vrbo"
    if any(token in key for token in ("website", "booking_engine", "walk_in", "walkin", "direct")):
        return "direct"
    return slugify(source_name or source_id) or "unknown"


def normalize_reservation_status(status: object) -> str:
    key = slugify(str(status or ""))
    if not key:
        return "unknown"
    mapping = {
        "checked_out": "checked_out",
        "checked_in": "checked_in",
        "in_house": "checked_in",
        "confirmed": "confirmed",
        "pending": "pending",
        "in_progress": "pending",
        "not_confirmed": "pending",
        "canceled": "cancelled",
        "cancelled": "cancelled",
        "no_show": "cancelled",
    }
    return mapping.get(key, key)


def chunk_rows(rows: list[dict], size: int = DEFAULT_CLOUDBEDS_BATCH_SIZE) -> list[list[dict]]:
    return [rows[index:index + size] for index in range(0, len(rows), size)]


def normalize_cloudbeds_reservation(
    record: dict,
    property_id_hint: str | None,
    property_name_hint: str | None,
    source_map: dict[str, str],
    context: dict[str, object],
    config: dict[str, object],
) -> dict[str, object]:
    reservation_id = normalize_whitespace(
        pick(record, ["reservationID", "reservationId", "id"])
    )
    if not reservation_id:
        return {"skip": {"reason": "missing_reservation_id"}}

    cloudbeds_property_id = normalize_whitespace(
        pick(record, ["propertyID", "propertyId", "hotelID", "hotelId"])
    ) or normalize_whitespace(property_id_hint)
    property_name = normalize_whitespace(
        pick(record, ["propertyName", "hotelName"])
    ) or normalize_whitespace(property_name_hint)
    mapping, match_type = resolve_cloudbeds_mapping(
        cloudbeds_property_id,
        property_name,
        context["indexes"],
    )
    if not mapping or not mapping.get("property_id"):
        return {
            "skip": {
                "reason": "missing_property_mapping",
                "reservationID": reservation_id,
                "cloudbedsPropertyId": cloudbeds_property_id,
                "propertyName": property_name,
            }
        }

    source_id = normalize_whitespace(pick(record, ["sourceID", "sourceId"]))
    source_name = normalize_whitespace(
        pick(record, ["sourceName", "source", "sourceLabel"])
    ) or source_map.get(source_id, "")
    guest_name, guest_email = extract_guest(record)
    source_account_id = resolve_cloudbeds_source_account_id(
        mapping,
        context["accounts"],
        config,
    )

    return {
        "row": {
            "property_id": mapping.get("property_id"),
            "source_account_id": source_account_id,
            "listing_id": mapping.get("id"),
            "connector": "cloudbeds",
            "channel": normalize_channel(source_name, source_id),
            "cloudbeds_reservation_id": reservation_id,
            "external_reservation_id": normalize_whitespace(
                pick(
                    record,
                    [
                        "thirdPartyIdentifier",
                        "externalReservationId",
                        "externalReservationID",
                        "confirmationNumber",
                    ],
                )
            )
            or None,
            "guest_name": guest_name,
            "guest_email": guest_email,
            "room_name": extract_room_name(record),
            "status": normalize_reservation_status(
                pick(record, ["status", "reservationStatus"])
            ),
            "check_in": to_iso_date(
                pick(record, ["startDate", "checkIn", "arrivalDate", "check_in"])
            ),
            "check_out": to_iso_date(
                pick(record, ["endDate", "checkOut", "departureDate", "check_out"])
            ),
            "booked_at": to_iso_datetime(
                pick(record, ["bookingDate", "createdAt", "created_at", "reservationCreatedAt"])
            ),
            "cancelled_at": to_iso_datetime(
                pick(record, ["cancelDate", "cancelledAt", "canceledAt"])
            ),
            "raw_payload": record,
            "metadata": {
                "connector": "cloudbeds",
                "cloudbedsPropertyId": cloudbeds_property_id or None,
                "cloudbedsPropertyName": property_name or None,
                "sourceId": source_id or None,
                "sourceName": source_name or None,
                "propertyMatchType": match_type,
                "syncedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
        }
    }


def build_reservation_query(payload: dict, property_id: str | None, default_window_days: int) -> dict[str, object]:
    query: dict[str, object] = {}
    passthrough = [
        "status",
        "includeGuestsDetails",
        "resultsFrom",
        "resultsTo",
        "checkInFrom",
        "checkInTo",
        "CheckInFrom",
        "CheckInTo",
        "checkOutFrom",
        "checkOutTo",
        "CheckOutFrom",
        "CheckOutTo",
        "checkedOutFrom",
        "checkedOutTo",
        "modifiedFrom",
        "modifiedTo",
    ]
    for key in passthrough:
        if payload.get(key) not in (None, ""):
            query[key] = payload[key]
    if property_id:
        query["propertyID"] = property_id
    query["includeGuestsDetails"] = "false" if payload.get("includeGuestsDetails") is False else "true"
    has_window = any(query.get(key) for key in ("checkInFrom", "CheckInFrom", "checkOutFrom", "CheckOutFrom", "checkedOutFrom", "modifiedFrom"))
    if not has_window:
        query["checkedOutFrom"] = subtract_days_iso(default_window_days)
        query["checkedOutTo"] = datetime.now(timezone.utc).date().isoformat()
        query.setdefault("status", "checked_out")
    query.setdefault("resultsFrom", "1")
    query.setdefault("resultsTo", "500")
    return query


def resolve_cloudbeds_targets(requested_property_ids: list[str]) -> list[dict]:
    config = cloudbeds_config()
    property_ids = requested_property_ids or list(config["configured_property_ids"])
    try:
        payload = cloudbeds_json("getHotels", {"propertyID": property_ids} if property_ids else {})
        hotels = parse_cloudbeds_data(payload)
    except (RuntimeError, urlerror.HTTPError, urlerror.URLError):
        hotels = [{"propertyID": property_id} for property_id in property_ids] if property_ids else [{"propertyID": None}]
    normalized = []
    seen: set[str] = set()
    for hotel in hotels:
        property_id = normalize_whitespace(
            pick(hotel, ["propertyID", "propertyId", "id", "hotelID", "hotelId"])
        )
        property_name = normalize_whitespace(
            pick(hotel, ["propertyName", "name", "hotelName", "title"])
        )
        if property_id:
            if property_id in seen:
                continue
            seen.add(property_id)
        normalized.append({"propertyID": property_id or None, "propertyName": property_name or ""})
    return normalized or [{"propertyID": None, "propertyName": ""}]


def sync_cloudbeds_reservations(payload: dict | None = None) -> dict[str, object]:
    body = payload or {}
    config = cloudbeds_config()
    requested_property_ids = [normalize_whitespace(item) for item in ensure_list(body.get("propertyIds")) if normalize_whitespace(item)]
    reservation_ids = [normalize_whitespace(item) for item in ensure_list(body.get("reservationIds")) if normalize_whitespace(item)]
    property_targets = resolve_cloudbeds_targets(requested_property_ids)
    if reservation_ids and len(property_targets) > 1:
        raise RuntimeError(
            "reservationIds requiere una sola propiedad objetivo. Envia propertyIds con un solo Cloudbeds propertyID"
        )
    context = load_cloudbeds_sync_context()
    rows: list[dict] = []
    skipped: list[dict] = []
    reservations_fetched = 0

    for target in property_targets:
        source_map = fetch_cloudbeds_sources(target["propertyID"])
        if reservation_ids:
            for reservation_id in reservation_ids:
                reservation_payload = cloudbeds_json(
                    "getReservation",
                    {
                        "reservationID": reservation_id,
                        **({"propertyID": target["propertyID"]} if target["propertyID"] else {}),
                    },
                )
                reservation = parse_cloudbeds_object(reservation_payload)
                reservations_fetched += 1
                normalized = normalize_cloudbeds_reservation(
                    reservation,
                    target["propertyID"],
                    target["propertyName"],
                    source_map,
                    context,
                    config,
                )
                if normalized.get("skip"):
                    skipped.append(normalized["skip"])
                    continue
                rows.append(normalized["row"])
            continue

        reservation_payload = cloudbeds_json(
            "getReservations",
            build_reservation_query(body, target["propertyID"], int(config["default_window_days"])),
        )
        reservations = parse_cloudbeds_data(reservation_payload)
        reservations_fetched += len(reservations)
        for reservation in reservations:
            normalized = normalize_cloudbeds_reservation(
                reservation,
                target["propertyID"],
                target["propertyName"],
                source_map,
                context,
                config,
            )
            if normalized.get("skip"):
                skipped.append(normalized["skip"])
                continue
            rows.append(normalized["row"])

    upserted = 0
    for chunk in chunk_rows(rows):
        saved = supabase_upsert_reservations(chunk)
        upserted += len(saved) if isinstance(saved, list) and saved else len(chunk)

    return {
        "mode": "reservation_ids" if reservation_ids else "window_sync",
        "propertiesScanned": len(property_targets),
        "reservationsFetched": reservations_fetched,
        "reservationsPrepared": len(rows),
        "reservationsUpserted": upserted,
        "skipped": skipped,
        "skippedCount": len(skipped),
        "propertyTargets": property_targets,
    }


DEFAULT_INBOUND_MATCH_THRESHOLD = 0.85
INBOUND_REVIEW_LOOKBACK_DAYS = 120


def inbound_config() -> dict[str, object]:
    try:
        threshold = float(os.environ.get("INBOUND_AUTO_MATCH_THRESHOLD", DEFAULT_INBOUND_MATCH_THRESHOLD))
    except ValueError:
        threshold = DEFAULT_INBOUND_MATCH_THRESHOLD
    if threshold <= 0 or threshold > 1:
        threshold = DEFAULT_INBOUND_MATCH_THRESHOLD
    return {
        "secret": normalize_whitespace(os.environ.get("INBOUND_EMAIL_SECRET")) or None,
        "threshold": threshold,
    }


def strip_html_text(html: str | None) -> str:
    raw = str(html or "")
    raw = re.sub(r"<style[\s\S]*?</style>", " ", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<script[\s\S]*?</script>", " ", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = raw.replace("&nbsp;", " ").replace("&amp;", "&")
    return normalize_whitespace(raw)


def extract_first_match(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match and match.group(1):
            return normalize_whitespace(match.group(1))
    return ""


def extract_rating(corpus: str) -> int | None:
    patterns = [
        r"(?:rating|calificacion|calificación|stars|estrellas)[^\d]{0,10}([1-5](?:[.,]\d)?)(?:\s*/\s*5)?",
        r"([1-5](?:[.,]\d)?)\s*/\s*5",
        r"([1-5])\s*(?:stars|estrellas)\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, corpus, flags=re.IGNORECASE)
        if not match:
            continue
        try:
            rating = round(float(match.group(1).replace(",", ".")))
        except ValueError:
            continue
        if 1 <= rating <= 5:
            return rating
    return None


def extract_review_text(raw_text: str | None, raw_html: str | None) -> str:
    text = normalize_whitespace(raw_text or strip_html_text(raw_html))
    if not text:
        return ""
    labeled = extract_first_match(
        text,
        [r"(?:review|comentario|comment|feedback)\s*[:\-]\s*[\"“]?(.{10,500})[\"”]?"],
    )
    if labeled:
        return labeled
    quoted = extract_first_match(text, [r"[\"“](.{12,500}?)[\"”]"])
    if quoted:
        return quoted
    parts = [
        normalize_whitespace(part)
        for part in re.split(r"(?<=[.!?])\s+", text)
        if normalize_whitespace(part)
    ]
    long_parts = [part for part in parts if len(part) >= 20]
    return long_parts[0] if long_parts else ""


def infer_inbound_channel(
    from_email: str,
    subject: str,
    raw_text: str,
    raw_html: str,
    source_account: dict | None,
) -> str | None:
    direct = normalize_key((source_account or {}).get("connector"))
    if direct in {"airbnb", "booking", "expedia"}:
        return direct
    corpus = normalize_key(" ".join(filter(None, [from_email, subject, raw_text, strip_html_text(raw_html), str((source_account or {}).get("label") or "")])))
    if not corpus:
        return None
    if "airbnb" in corpus:
        return "airbnb"
    if "booking.com" in corpus or "booking com" in corpus or "booking" in corpus:
        return "booking"
    if "expedia" in corpus:
        return "expedia"
    if "vrbo" in corpus or "homeaway" in corpus:
        return "vrbo"
    return None


def infer_inbound_connector(explicit_connector: object, source_account: dict | None, channel_guess: str | None) -> str:
    explicit = normalize_whitespace(explicit_connector)
    if explicit:
        return explicit
    account_connector = normalize_whitespace((source_account or {}).get("connector"))
    if account_connector and account_connector != "email":
        return account_connector
    if channel_guess == "airbnb" and account_connector == "airbnb":
        return "airbnb"
    return account_connector or "email"


def classify_inbound_message(subject: str, raw_text: str, raw_html: str, channel_guess: str | None) -> str:
    corpus = normalize_key(" ".join(filter(None, [subject, raw_text, strip_html_text(raw_html)])))
    if any(token in corpus for token in ("review", "resena", "reseña", "rating", "stars", "estrellas", "calificacion", "calificación")):
        return "review_notification"
    if any(token in corpus for token in ("reservation confirmed", "reservation confirmation", "confirmacion de reserva", "confirmación de reserva", "new reservation", "nueva reserva")):
        return "reservation_confirmation"
    if any(token in corpus for token in ("message from your guest", "mensaje de tu huesped", "mensaje de tu huésped", "guest message")):
        return "guest_message"
    if any(token in corpus for token in ("leave a review", "deja una resena", "deja una reseña", "share your feedback")):
        return "post_stay_prompt"
    if channel_guess == "airbnb" and "guest" in corpus:
        return "guest_message"
    return "other"


def parse_inbound_fields(raw_text: str, raw_html: str, subject: str, headers: dict) -> dict[str, object]:
    corpus = "\n".join(
        filter(
            None,
            [
                normalize_whitespace(raw_text),
                strip_html_text(raw_html),
                normalize_whitespace(subject),
                "\n".join(f"{key}: {value}" for key, value in headers.items()),
            ],
        )
    )
    return {
        "guestName": extract_first_match(
            corpus,
            [
                r"(?:guest|hu[eé]sped|traveler|traveller|usuario)\s*(?:name)?\s*[:\-]\s*([A-ZÁÉÍÓÚÑ][^\n<]{2,80})",
                r"review from\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'’.\-\s]{2,80})",
                r"reseña de\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'’.\-\s]{2,80})",
            ],
        )
        or None,
        "externalReservationId": extract_first_match(
            corpus,
            [r"(?:reservation|booking|confirmation|reserva)\s*(?:id|code|number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9\-]{5,40})"],
        )
        or None,
        "externalReviewId": extract_first_match(
            corpus,
            [r"(?:review)\s*(?:id|number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9_\-]{4,60})"],
        )
        or None,
        "listingIdHint": extract_first_match(
            corpus,
            [r"(?:listing|anuncio|propiedad)\s*(?:id|code|number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9_\-]{3,60})"],
        )
        or None,
        "listingName": extract_first_match(
            corpus,
            [r"(?:listing|anuncio|property|propiedad|accommodation)\s*(?:name)?\s*[:\-]\s*([^\n<]{3,120})"],
        )
        or None,
        "rating": extract_rating(corpus),
        "reviewText": extract_review_text(raw_text, raw_html) or None,
    }


def inbound_message_hash(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(
            {
                "fromEmail": payload.get("fromEmail") or "",
                "subject": payload.get("subject") or "",
                "receivedAt": payload.get("receivedAt") or "",
                "rawText": payload.get("rawText") or "",
                "rawHtml": payload.get("rawHtml") or "",
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()


def supabase_request_json(
    path: str,
    method: str = "GET",
    payload: object | None = None,
    prefer: str | None = None,
) -> object:
    url, _ = supabase_config()
    headers = supabase_headers()
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    req = urlrequest.Request(
        f"{url}/rest/v1/{path}",
        headers=headers,
        data=data,
        method=method,
    )
    with urlrequest.urlopen(req, timeout=35) as response:
        raw = response.read().decode("utf-8").strip()
        return json.loads(raw) if raw else ([] if prefer and "representation" in prefer else {})


def find_source_account(
    source_account_id: str | None,
    external_account_id: str | None,
    inbox_address: str | None,
    connector: str | None,
) -> dict | None:
    if source_account_id:
        rows = supabase_request_json(
            f"source_accounts?select=*&id=eq.{urlparse.quote(source_account_id, safe='')}&limit=1"
        )
        return rows[0] if isinstance(rows, list) and rows else None
    if connector and external_account_id:
        rows = supabase_request_json(
            f"source_accounts?select=*&connector=eq.{urlparse.quote(connector, safe='')}&external_account_id=eq.{urlparse.quote(external_account_id, safe='')}&limit=1"
        )
        if isinstance(rows, list) and rows:
            return rows[0]
    if connector and inbox_address:
        rows = supabase_request_json(
            f"source_accounts?select=*&connector=eq.{urlparse.quote(connector, safe='')}&inbox_address=eq.{urlparse.quote(inbox_address, safe='')}&limit=1"
        )
        if isinstance(rows, list) and rows:
            return rows[0]
    if inbox_address:
        rows = supabase_request_json(
            f"source_accounts?select=*&inbox_address=eq.{urlparse.quote(inbox_address, safe='')}&limit=1"
        )
        return rows[0] if isinstance(rows, list) and rows else None
    return None


def find_existing_inbound_message(connector: str, external_message_id: str | None, internal_hash: str) -> dict | None:
    if external_message_id:
        rows = supabase_request_json(
            f"inbound_messages?select=*&connector=eq.{urlparse.quote(connector, safe='')}&external_message_id=eq.{urlparse.quote(external_message_id, safe='')}&limit=1"
        )
        if isinstance(rows, list) and rows:
            return rows[0]
    rows = supabase_request_json(
        "inbound_messages?select=*&order=received_at.desc&limit=50"
    )
    if isinstance(rows, list):
        for row in rows:
            if normalize_whitespace((row.get("metadata") or {}).get("internal_message_hash")) == internal_hash:
                return row
    return None


def store_inbound_message(payload: dict | None = None) -> dict[str, object]:
    body = payload or {}
    source_account = find_source_account(
        normalize_whitespace(body.get("sourceAccountId")) or None,
        normalize_whitespace(body.get("externalAccountId")) or None,
        normalize_whitespace(body.get("inboxAddress")) or None,
        normalize_whitespace(body.get("accountConnector") or body.get("connector")) or None,
    )
    raw_text = normalize_whitespace(body.get("text") or body.get("rawText"))
    raw_html = str(body.get("html") or body.get("rawHtml") or "")
    subject = normalize_whitespace(body.get("subject"))
    from_email = normalize_whitespace(body.get("fromEmail") or body.get("from_email"))
    received_at = to_iso_datetime(body.get("receivedAt") or body.get("received_at"))
    headers = body.get("headers") if isinstance(body.get("headers"), dict) else {}
    channel_guess = infer_inbound_channel(from_email, subject, raw_text, raw_html, source_account)
    connector = infer_inbound_connector(body.get("connector"), source_account, channel_guess)
    message_type = classify_inbound_message(subject, raw_text, raw_html, channel_guess)
    parsed_fields = parse_inbound_fields(raw_text, raw_html, subject, headers)
    internal_hash = inbound_message_hash(
        {
            "fromEmail": from_email,
            "subject": subject,
            "receivedAt": received_at,
            "rawText": raw_text,
            "rawHtml": raw_html,
        }
    )
    external_message_id = normalize_whitespace(body.get("externalMessageId") or body.get("messageId")) or None
    existing = find_existing_inbound_message(connector, external_message_id, internal_hash)
    row = {
        "source_account_id": (source_account or {}).get("id"),
        "connector": connector,
        "channel_guess": channel_guess,
        "external_message_id": external_message_id,
        "thread_id": normalize_whitespace(body.get("threadId")) or None,
        "from_email": from_email or None,
        "subject": subject or None,
        "received_at": received_at,
        "parse_status": "parsed",
        "raw_text": raw_text or None,
        "raw_html": raw_html or None,
        "headers": headers,
        "metadata": {
            "provider": normalize_whitespace(body.get("provider")) or "manual",
            "inbox_address": normalize_whitespace(body.get("inboxAddress")) or (source_account or {}).get("inbox_address"),
            "message_type": message_type,
            "parsed_fields": parsed_fields,
            "ingested_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "internal_message_hash": internal_hash,
        },
    }
    if existing and existing.get("id"):
        updated = supabase_request_json(
            f"inbound_messages?id=eq.{urlparse.quote(str(existing['id']), safe='')}",
            method="PATCH",
            payload=row,
            prefer="return=representation",
        )
        message = updated[0] if isinstance(updated, list) and updated else {**existing, **row}
    else:
        inserted = supabase_request_json(
            "inbound_messages",
            method="POST",
            payload=row,
            prefer="return=representation",
        )
        message = inserted[0] if isinstance(inserted, list) and inserted else row
    return {
        "message": message,
        "sourceAccount": source_account,
        "classification": {
            "connector": connector,
            "channelGuess": channel_guess,
            "messageType": message_type,
            "parsedFields": parsed_fields,
        },
    }


def listing_name_score(parsed_listing_name: str | None, listing: dict) -> tuple[float, str | None]:
    target = normalize_key(parsed_listing_name)
    if not target:
        return 0.0, None
    candidates = [
        normalize_key(listing.get("display_name")),
        normalize_key(listing.get("external_listing_id")),
        normalize_key(listing.get("external_property_id")),
    ]
    for candidate in candidates:
        if candidate and candidate == target:
            return 0.65, "listing_name_exact"
    for candidate in candidates:
        if candidate and (candidate in target or target in candidate):
            return 0.35, "listing_name_partial"
    return 0.0, None


def is_date_window_match(received_at: str | None, reservation: dict) -> bool:
    if not received_at or not reservation.get("check_out"):
        return False
    try:
        review_dt = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
        checkout_dt = datetime.fromisoformat(f"{reservation['check_out']}T00:00:00+00:00")
    except ValueError:
        return False
    diff_days = (review_dt - checkout_dt).days
    return -2 <= diff_days <= 45


def load_inbound_processing_context(message: dict) -> dict[str, list[dict]]:
    channel = normalize_whitespace(message.get("channel_guess"))
    channel_filter = f"&channel=eq.{urlparse.quote(channel, safe='')}" if channel else ""
    listings = supabase_request_json(
        f"external_listings?select=id,property_id,source_account_id,connector,channel,external_listing_id,external_property_id,display_name,metadata&active=eq.true{channel_filter}&limit=500"
    )
    reservations = supabase_request_json(
        f"reservations?select=id,property_id,listing_id,source_account_id,channel,external_reservation_id,guest_name,room_name,check_in,check_out,status&check_out=gte.{subtract_days_iso(INBOUND_REVIEW_LOOKBACK_DAYS)}{channel_filter}&order=check_out.desc&limit=1000"
    )
    return {
        "listings": listings if isinstance(listings, list) else [],
        "reservations": reservations if isinstance(reservations, list) else [],
    }


def build_reservation_candidate(message: dict, parsed: dict, reservation: dict, listing: dict | None) -> dict[str, object]:
    score = 0.0
    reasons: list[str] = []
    if parsed.get("externalReservationId") and normalize_whitespace(reservation.get("external_reservation_id")) == normalize_whitespace(parsed.get("externalReservationId")):
        score += 0.75
        reasons.append("external_reservation_id")
    if parsed.get("guestName") and normalize_key(reservation.get("guest_name")) == normalize_key(parsed.get("guestName")):
        score += 0.10
        reasons.append("guest_name")
    if message.get("source_account_id") and reservation.get("source_account_id") == message.get("source_account_id"):
        score += 0.10
        reasons.append("source_account")
    if message.get("channel_guess") and reservation.get("channel") == message.get("channel_guess"):
        score += 0.05
        reasons.append("channel")
    if listing:
        listing_score, reason = listing_name_score(parsed.get("listingName") or parsed.get("listingIdHint"), listing)
        if listing_score:
            score += min(0.25, listing_score)
            if reason:
                reasons.append(reason)
    if is_date_window_match(message.get("received_at"), reservation):
        score += 0.10
        reasons.append("date_window")
    return {
        "type": "reservation",
        "score": min(1.0, round(score, 4)),
        "reasons": reasons,
        "reservation": reservation,
        "listing": listing,
        "propertyId": reservation.get("property_id"),
        "reservationId": reservation.get("id"),
        "listingId": reservation.get("listing_id") or (listing or {}).get("id"),
        "sourceAccountId": reservation.get("source_account_id") or message.get("source_account_id"),
    }


def build_listing_candidate(message: dict, parsed: dict, listing: dict) -> dict[str, object]:
    score = 0.0
    reasons: list[str] = []
    if parsed.get("listingIdHint") and normalize_whitespace(listing.get("external_listing_id")) == normalize_whitespace(parsed.get("listingIdHint")):
        score += 0.75
        reasons.append("listing_id_exact")
    else:
        listing_score, reason = listing_name_score(parsed.get("listingName"), listing)
        if listing_score:
            score += listing_score
            if reason:
                reasons.append(reason)
    if message.get("source_account_id") and listing.get("source_account_id") == message.get("source_account_id"):
        score += 0.15
        reasons.append("source_account")
    if message.get("channel_guess") and listing.get("channel") == message.get("channel_guess"):
        score += 0.05
        reasons.append("channel")
    return {
        "type": "listing",
        "score": min(1.0, round(score, 4)),
        "reasons": reasons,
        "reservation": None,
        "listing": listing,
        "propertyId": listing.get("property_id"),
        "reservationId": None,
        "listingId": listing.get("id"),
        "sourceAccountId": listing.get("source_account_id") or message.get("source_account_id"),
    }


def choose_best_inbound_candidate(message: dict, parsed: dict, context: dict[str, list[dict]]) -> tuple[dict | None, list[dict]]:
    listings_by_id = {listing.get("id"): listing for listing in context["listings"]}
    candidates: list[dict] = []
    for reservation in context["reservations"]:
        listing = listings_by_id.get(reservation.get("listing_id"))
        candidates.append(build_reservation_candidate(message, parsed, reservation, listing))
    for listing in context["listings"]:
        candidates.append(build_listing_candidate(message, parsed, listing))
    candidates.sort(key=lambda item: item.get("score", 0), reverse=True)
    return (candidates[0] if candidates else None, candidates[:5])


def find_existing_review(channel: str, external_review_id: str | None) -> dict | None:
    if not external_review_id:
        return None
    rows = supabase_request_json(
        f"reviews?select=id,external_review_id,channel&external_review_id=eq.{urlparse.quote(external_review_id, safe='')}&channel=eq.{urlparse.quote(channel, safe='')}&limit=1"
    )
    return rows[0] if isinstance(rows, list) and rows else None


def create_or_update_parsed_review(message: dict, parsed: dict, match: dict) -> dict:
    if not parsed.get("rating"):
        raise RuntimeError("No se puede crear review sin rating parseado")
    if not match.get("propertyId"):
        raise RuntimeError("No se puede crear review sin property_id resuelto")
    review_body = {
        "property_id": match.get("propertyId"),
        "source_account_id": match.get("sourceAccountId"),
        "listing_id": match.get("listingId"),
        "reservation_id": match.get("reservationId"),
        "connector": message.get("connector") or "email",
        "channel": message.get("channel_guess") or "unknown",
        "source_type": "email_parsed",
        "external_review_id": parsed.get("externalReviewId"),
        "guest_name": parsed.get("guestName"),
        "room_name": ((match.get("reservation") or {}).get("room_name")),
        "rating": parsed.get("rating"),
        "comment": parsed.get("reviewText"),
        "would_return": None,
        "source": f"{message.get('channel_guess') or message.get('connector') or 'email'}-email",
        "reviewed_at": message.get("received_at") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "is_public": True,
        "match_confidence": match.get("score"),
        "response_status": "pending",
        "raw_payload": {
            "inbound_message_id": message.get("id"),
            "parsed_fields": parsed,
        },
        "metadata": {
            "inbound_message_id": message.get("id"),
            "match_reasons": match.get("reasons"),
            "match_type": match.get("type"),
        },
    }
    existing = find_existing_review(str(review_body["channel"]), review_body.get("external_review_id"))
    if existing and existing.get("id"):
        updated = supabase_request_json(
            f"reviews?id=eq.{urlparse.quote(str(existing['id']), safe='')}",
            method="PATCH",
            payload=review_body,
            prefer="return=representation",
        )
        return updated[0] if isinstance(updated, list) and updated else {"id": existing["id"], **review_body}
    inserted = supabase_request_json(
        "reviews",
        method="POST",
        payload=review_body,
        prefer="return=representation",
    )
    return inserted[0] if isinstance(inserted, list) and inserted else review_body


def get_inbound_message(inbound_message_id: str | None, external_message_id: str | None, connector: str | None) -> dict | None:
    if inbound_message_id:
        rows = supabase_request_json(
            f"inbound_messages?select=*&id=eq.{urlparse.quote(inbound_message_id, safe='')}&limit=1"
        )
        return rows[0] if isinstance(rows, list) and rows else None
    if external_message_id and connector:
        rows = supabase_request_json(
            f"inbound_messages?select=*&connector=eq.{urlparse.quote(connector, safe='')}&external_message_id=eq.{urlparse.quote(external_message_id, safe='')}&limit=1"
        )
        return rows[0] if isinstance(rows, list) and rows else None
    return None


def process_inbound_message(payload: dict | None = None) -> dict[str, object]:
    body = payload or {}
    message = get_inbound_message(
        normalize_whitespace(body.get("inboundMessageId")) or None,
        normalize_whitespace(body.get("externalMessageId")) or None,
        normalize_whitespace(body.get("connector")) or None,
    )
    if not message or not message.get("id"):
        raise RuntimeError("Inbound message no encontrado")
    parsed = (message.get("metadata") or {}).get("parsed_fields") or {}
    message_type = (message.get("metadata") or {}).get("message_type") or "other"
    if not body.get("force") and message_type != "review_notification":
        updated = supabase_request_json(
            f"inbound_messages?id=eq.{urlparse.quote(str(message['id']), safe='')}",
            method="PATCH",
            payload={
                "parse_status": "ignored",
                "metadata": {
                    **(message.get("metadata") or {}),
                    "processing": {
                        "processed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "ignored_reason": "message_type_not_review",
                    },
                },
            },
            prefer="return=representation",
        )
        return {
            "status": "ignored",
            "message": updated[0] if isinstance(updated, list) and updated else message,
            "reason": "message_type_not_review",
        }
    context = load_inbound_processing_context(message)
    best, top_candidates = choose_best_inbound_candidate(message, parsed, context)
    threshold = float(inbound_config()["threshold"])
    should_create = bool(best) and best.get("score", 0) >= threshold and bool(parsed.get("rating")) and bool(best.get("propertyId") or best.get("reservationId"))
    review = create_or_update_parsed_review(message, parsed, best) if should_create else None
    status = "matched" if review else "needs_review"
    updated = supabase_request_json(
        f"inbound_messages?id=eq.{urlparse.quote(str(message['id']), safe='')}",
        method="PATCH",
        payload={
            "property_id": best.get("propertyId") if best else None,
            "reservation_id": best.get("reservationId") if best else None,
            "parse_status": status,
            "metadata": {
                **(message.get("metadata") or {}),
                "processing": {
                    "processed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "status": status,
                    "threshold": threshold,
                    "best_candidate": best,
                    "top_candidates": top_candidates,
                    "review_id": (review or {}).get("id") if isinstance(review, dict) else None,
                    "missing_rating": not bool(parsed.get("rating")),
                },
            },
        },
        prefer="return=representation",
    )
    return {
        "status": status,
        "threshold": threshold,
        "message": updated[0] if isinstance(updated, list) and updated else message,
        "bestCandidate": best,
        "topCandidates": top_candidates,
        "review": review,
    }


def reset_inbound_matched_messages() -> int:
    rows = supabase_request_json(
        "inbound_messages?select=id&parse_status=eq.matched&order=received_at.asc"
    )
    total = len(rows) if isinstance(rows, list) else 0
    if total:
        supabase_request_json(
            "inbound_messages?parse_status=eq.matched",
            method="PATCH",
            payload={"parse_status": "needs_review"},
            prefer="return=minimal",
        )
    return total


def list_pending_inbound_messages(status: str = "needs_review") -> list[dict]:
    rows = supabase_request_json(
        f"inbound_messages?select=id&parse_status=eq.{urlparse.quote(status, safe='')}&order=received_at.asc&limit=200"
    )
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def reprocess_inbound_batch(status: str = "needs_review", limit: int = 20) -> dict[str, int]:
    all_messages = list_pending_inbound_messages(status)
    batch = all_messages[:limit]
    matched = 0
    ignored = 0
    errors = 0

    for row in batch:
        message_id = normalize_whitespace(row.get("id"))
        if not message_id:
            errors += 1
            continue
        try:
            result = process_inbound_message({"inboundMessageId": message_id, "force": False})
            if result.get("status") == "matched":
                matched += 1
            else:
                ignored += 1
        except Exception as exc:
            print(f"[reprocess-batch] Error en {message_id}: {exc}")
            errors += 1

    return {
        "processed": len(batch),
        "remaining": max(0, len(all_messages) - len(batch)),
        "matched": matched,
        "ignored": ignored,
        "errors": errors,
    }


def run_booking_local_action(action: str, payload: dict | None = None) -> dict:
    script = """
const fs = require('fs');
const { buildPreview, importBookingCsv, loadBookingDashboard, translateExistingBookingReviews } = require('./netlify/functions/_booking_reviews');
const action = process.argv[1];
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');

(async () => {
  try {
    let result;
    if (action === 'preview') {
      result = await buildPreview(input);
    } else if (action === 'import') {
      result = await importBookingCsv(input);
    } else if (action === 'data') {
      result = await loadBookingDashboard(input);
    } else if (action === 'translate') {
      result = await translateExistingBookingReviews(input);
    } else {
      throw new Error(`Accion Booking no soportada: ${action}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error && error.message ? error.message : String(error),
    }));
    process.exitCode = 1;
  }
})();
"""
    try:
        completed = subprocess.run(
            ["node", "-e", script, action],
            input=json.dumps(payload or {}, ensure_ascii=False),
            text=True,
            capture_output=True,
            cwd=str(ROOT),
            timeout=180,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("Node.js no esta disponible para procesar Booking en local") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Booking tardo demasiado en responder en local") from exc

    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    if not stdout:
        raise RuntimeError(stderr or "Booking no devolvio respuesta")

    try:
        response = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(stderr or stdout or "Booking devolvio una respuesta invalida") from exc

    if not response.get("ok"):
        raise RuntimeError(str(response.get("error") or stderr or "Error al procesar Booking"))

    return response.get("result") if isinstance(response.get("result"), dict) else {}


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
    properties = supabase_request_json(
        "properties?select=id,city,name&active=eq.true&order=city,name"
    )
    property_map = {
        str(row.get("id")): row for row in properties if isinstance(row, dict) and row.get("id")
    }
    reviews = supabase_request_json(
        "reviews?select=id,guest_name,room_name,rating,comment,would_return,source,channel,created_at,reviewed_at,property_id,raw_payload&order=created_at.desc&limit=2000"
    )
    review_rows = []
    for row in reviews if isinstance(reviews, list) else []:
        if not isinstance(row, dict):
            continue
        enriched = dict(row)
        enriched["properties"] = property_map.get(str(row.get("property_id"))) or None
        review_rows.append(enriched)

    return {
        "properties": properties if isinstance(properties, list) else [],
        "reviews": review_rows,
    }


def list_active_properties() -> list[dict]:
    rows = supabase_request_json("properties?select=id,name,city&active=eq.true&order=city,name")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def attach_property_rows(rows: object, properties: list[dict]) -> list[dict]:
    property_map = {
        str(row.get("id")): row for row in properties if isinstance(row, dict) and row.get("id")
    }
    output: list[dict] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        enriched = dict(row)
        enriched["properties"] = property_map.get(str(row.get("property_id"))) or None
        output.append(enriched)
    return output


def fetch_dashboard_reservations() -> list[dict]:
    properties = list_active_properties()
    rows = supabase_request_json(
        "reservations?select=id,guest_name,room_name,status,channel,check_in,check_out,property_id&order=check_out.desc&limit=2000"
    )
    return attach_property_rows(rows, properties)


def fetch_dashboard_google_reviews() -> list[dict]:
    properties = list_active_properties()
    rows = supabase_request_json(
        "google_reviews?select=id,guest_name,rating,comment,review_url,place_id,published_at,responded,responded_at,property_id&order=published_at.desc"
    )
    return attach_property_rows(rows, properties)


def mark_google_review_responded(review_id: str, responded: bool) -> None:
    payload = {
        "responded": responded,
        "responded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if responded
        else None,
    }
    supabase_request_json(
        f"google_reviews?id=eq.{urlparse.quote(review_id, safe='')}",
        method="PATCH",
        payload=payload,
        prefer="return=minimal",
    )


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
            ("GET", "/api/dashboard-booking-data"): self.handle_dashboard_booking_data,
            ("GET", "/api/dashboard-reservations"): self.handle_dashboard_reservations,
            ("GET", "/api/dashboard-google-reviews"): self.handle_dashboard_google_reviews,
            ("POST", "/api/dashboard-google-reviews"): self.handle_dashboard_google_reviews_update,
            ("POST", "/api/dashboard-booking-preview"): self.handle_dashboard_booking_preview,
            ("POST", "/api/dashboard-booking-import"): self.handle_dashboard_booking_import,
            ("POST", "/api/dashboard-booking-translate"): self.handle_dashboard_booking_translate,
            ("POST", "/api/dashboard-create-property"): self.handle_dashboard_create_property,
            ("POST", "/api/dashboard-delete-review"): self.handle_dashboard_delete_review,
            ("POST", "/api/dashboard-logout"): self.handle_dashboard_logout,
            ("POST", "/api/internal/cloudbeds-sync"): self.handle_cloudbeds_sync,
            ("POST", "/api/inbound/email"): self.handle_inbound_email,
            ("POST", "/api/internal/process-inbound-message"): self.handle_process_inbound_message,
            ("POST", "/api/internal/reset-inbound-matched"): self.handle_reset_inbound_matched,
            ("POST", "/api/internal/reprocess-inbound-batch"): self.handle_reprocess_inbound_batch,
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

    def require_sync_access(self) -> str:
        sync_secret = normalize_whitespace(os.environ.get("CLOUDBEDS_SYNC_SECRET"))
        header_secret = normalize_whitespace(
            self.headers.get("X-Sync-Secret") or self.headers.get("X-Cloudbeds-Sync-Secret")
        )
        if sync_secret and header_secret == sync_secret:
            return "secret"
        self.require_session()
        return "session"

    def require_inbound_access(self) -> str:
        secret = normalize_whitespace(os.environ.get("INBOUND_EMAIL_SECRET"))
        header_secret = normalize_whitespace(
            self.headers.get("X-Inbound-Secret")
            or self.headers.get("X-Process-Secret")
            or self.headers.get("X-Sync-Secret")
        )
        if secret and header_secret == secret:
            return "secret"
        self.require_session()
        return "session"

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

    def handle_dashboard_booking_data(self) -> None:
        try:
            self.require_session()
            parsed = urlparse.urlparse(self.path)
            query = urlparse.parse_qs(parsed.query, keep_blank_values=True)
            payload = {
                "propertyId": normalize_whitespace((query.get("propertyId") or [""])[0]),
                "year": normalize_whitespace((query.get("year") or [""])[0]),
                "month": normalize_whitespace((query.get("month") or [""])[0]),
            }
            result = run_booking_local_action("data", payload)
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

        self.send_json(HTTPStatus.OK, {"ok": True, **result})

    def handle_dashboard_reservations(self) -> None:
        try:
            self.require_session()
            reservations = fetch_dashboard_reservations()
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

        self.send_json(HTTPStatus.OK, {"ok": True, "reservations": reservations})

    def handle_dashboard_google_reviews(self) -> None:
        try:
            self.require_session()
            reviews = fetch_dashboard_google_reviews()
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

        self.send_json(HTTPStatus.OK, {"ok": True, "reviews": reviews})

    def handle_dashboard_google_reviews_update(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        review_id = str(payload.get("id", "")).strip()
        responded = payload.get("responded")
        if not review_id:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "id es obligatorio"},
            )
            return
        if not isinstance(responded, bool):
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "responded debe ser boolean"},
            )
            return

        try:
            self.require_session()
            mark_google_review_responded(review_id, responded)
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

        self.send_json(HTTPStatus.OK, {"ok": True})

    def handle_dashboard_booking_preview(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        property_id = normalize_whitespace(payload.get("propertyId"))
        csv_base64 = normalize_whitespace(payload.get("csvBase64"))
        if not property_id:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "propertyId es obligatorio"},
            )
            return
        if not csv_base64:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "csvBase64 es obligatorio"},
            )
            return

        try:
            self.require_session()
            result = run_booking_local_action(
                "preview",
                {
                    "propertyId": property_id,
                    "filename": normalize_whitespace(payload.get("filename")) or "booking.csv",
                    "csvBase64": csv_base64,
                },
            )
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

        self.send_json(HTTPStatus.OK, {"ok": True, **result})

    def handle_dashboard_booking_import(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        property_id = normalize_whitespace(payload.get("propertyId"))
        csv_base64 = normalize_whitespace(payload.get("csvBase64"))
        if not property_id:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "propertyId es obligatorio"},
            )
            return
        if not csv_base64:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "csvBase64 es obligatorio"},
            )
            return

        try:
            session = self.require_session()
            result = run_booking_local_action(
                "import",
                {
                    "propertyId": property_id,
                    "filename": normalize_whitespace(payload.get("filename")) or "booking.csv",
                    "csvBase64": csv_base64,
                    "uploadedBy": session.get("username") or "dashboard",
                },
            )
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

        self.send_json(HTTPStatus.OK, {"ok": True, **result})

    def handle_dashboard_booking_translate(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        property_id = normalize_whitespace(payload.get("propertyId"))
        if not property_id:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "propertyId es obligatorio"},
            )
            return

        try:
            self.require_session()
            result = run_booking_local_action(
                "translate",
                {
                    "propertyId": property_id,
                    "year": normalize_whitespace(payload.get("year")),
                    "month": normalize_whitespace(payload.get("month")),
                    "force": bool(payload.get("force")),
                },
            )
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

        self.send_json(HTTPStatus.OK, {"ok": True, **result})

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

    def handle_cloudbeds_sync(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        try:
            auth_mode = self.require_sync_access()
            result = sync_cloudbeds_reservations(payload)
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
                {"ok": False, "error": details or f"Integracion devolvio {exc.code}"},
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo completar cloudbeds-sync: {exc.reason}"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "authMode": auth_mode, **result},
        )

    def handle_inbound_email(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        try:
            auth_mode = self.require_inbound_access()
            stored = store_inbound_message(payload)
            processing = None
            if payload.get("autoProcess") is True and stored.get("message", {}).get("id"):
                processing = process_inbound_message(
                    {
                        "inboundMessageId": stored["message"]["id"],
                        "force": bool(payload.get("force")),
                    }
                )
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
                {"ok": False, "error": details or f"Integracion devolvio {exc.code}"},
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo procesar inbound email: {exc.reason}"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "authMode": auth_mode, **stored, "processing": processing},
        )

    def handle_process_inbound_message(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Body JSON invalido"},
            )
            return

        try:
            auth_mode = self.require_inbound_access()
            result = process_inbound_message(payload)
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
                {"ok": False, "error": details or f"Integracion devolvio {exc.code}"},
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo procesar inbound message: {exc.reason}"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "authMode": auth_mode, **result},
        )

    def handle_reset_inbound_matched(self) -> None:
        try:
            self.require_session()
            total = reset_inbound_matched_messages()
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
                {"ok": False, "error": details or f"Supabase devolvio {exc.code}"},
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo resetear inbound messages: {exc.reason}"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "reset": total},
        )

    def handle_reprocess_inbound_batch(self) -> None:
        try:
            auth_mode = self.require_inbound_access()
            result = reprocess_inbound_batch("needs_review", 20)
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
                {"ok": False, "error": details or f"Supabase devolvio {exc.code}"},
            )
            return
        except urlerror.URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"No se pudo reprocesar inbound batch: {exc.reason}"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "authMode": auth_mode, **result},
        )


def print_environment_hints() -> None:
    if not (
        is_service_role_capable_key(os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        or is_service_role_capable_key(os.environ.get("SUPABASE_DASHBOARD_KEY"))
    ):
        print(
            "Aviso: falta una SUPABASE_SERVICE_ROLE_KEY real; la DASHBOARD key actual no alcanza para leer el dashboard interno."
        )
    if not os.environ.get("DASHBOARD_SESSION_SECRET"):
        print(
            "Aviso: DASHBOARD_SESSION_SECRET no esta definido; para produccion conviene configurarlo en el entorno."
        )
    if not os.environ.get("CLOUDBEDS_API_KEY"):
        print(
            "Aviso: falta CLOUDBEDS_API_KEY; cloudbeds-sync no podra consultar reservas."
        )
    if not os.environ.get("INBOUND_EMAIL_SECRET"):
        print(
            "Aviso: INBOUND_EMAIL_SECRET no esta definido; los endpoints de inbound email dependeran de sesion de dashboard."
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
        print(f"Cloudbeds Sync: {base_url}/api/internal/cloudbeds-sync")
        print(f"Inbound Email: {base_url}/api/inbound/email")
        print(f"Process Inbound: {base_url}/api/internal/process-inbound-message")
        print_environment_hints()
        print("Presiona Ctrl+C para detenerlo.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")


if __name__ == "__main__":
    main()
