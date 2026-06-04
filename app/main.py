import asyncio
import base64
import ipaddress
import json
import math
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import psycopg
from cryptography.hazmat.primitives import serialization
from psycopg_pool import AsyncConnectionPool
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded


ROOT = Path(__file__).resolve().parent.parent
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://mowetter:mowetter_dev_password@127.0.0.1:5432/mowetter",
)
CLIENT_ID_RE = re.compile(r"^mw_[a-f0-9]{16,40}$")
PUSH_ENDPOINT_RE = re.compile(r"^https://")
FORECAST_CACHE_TTL_SECONDS = int(os.getenv("FORECAST_CACHE_TTL_SECONDS", "900"))
FORECAST_REFRESH_SECONDS   = int(os.getenv("FORECAST_REFRESH_SECONDS", "900"))
ENABLE_API_DOCS = os.getenv("ENABLE_API_DOCS", "").lower() in {"1", "true", "yes"}
FORECAST_HOURLY = (
    "temperature_2m,apparent_temperature,precipitation,windspeed_10m,"
    "winddirection_10m,relativehumidity_2m,cloudcover,uv_index,"
    "soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_temperature_0cm"
)
FORECAST_DAILY = (
    "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,"
    "weathercode,et0_fao_evapotranspiration,sunrise,sunset"
)
DAILY_KEYS = [
    "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
    "windspeed_10m_max", "weathercode", "et0_fao_evapotranspiration",
    "soil_temperature_avg",
]
FROST_PUSH_COOLDOWN_H = 8
VAPID_CLAIMS = {"sub": "mailto:mowetter@localhost"}

pool: AsyncConnectionPool | None = None
vapid_private_pem: str = ""
vapid_public_b64:  str = ""


# ── IP helper for rate limiting ───────────────────────────────────────────────

def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    trusted_proxy = False
    try:
        peer_ip = ipaddress.ip_address(peer)
        trusted_proxy = peer_ip.is_loopback or peer_ip.is_private
    except ValueError:
        trusted_proxy = False
    if not trusted_proxy:
        return peer or "unknown"
    for header in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"):
        value = request.headers.get(header, "")
        if value:
            return value.split(",")[0].strip()
    return peer or "unknown"


limiter = Limiter(key_func=client_ip)


# ── Small helpers ─────────────────────────────────────────────────────────────

def no_cache_file(path: Path, media_type: str | None = None) -> FileResponse:
    return FileResponse(
        path, media_type=media_type,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                 "Pragma": "no-cache"},
    )


def normalize_client_id(client_id: str) -> str:
    client_id = client_id.strip()
    if not CLIENT_ID_RE.match(client_id):
        raise HTTPException(status_code=400, detail="ungueltige client_id")
    return client_id


def validate_lat_lon(lat: Any, lon: Any) -> tuple[float, float]:
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="lat/lon ungueltig") from exc
    if (
        not math.isfinite(lat_f)
        or not math.isfinite(lon_f)
        or not (-90 <= lat_f <= 90)
        or not (-180 <= lon_f <= 180)
    ):
        raise HTTPException(status_code=400, detail="lat/lon ungueltig")
    return lat_f, lon_f


def location_key(lat: float, lon: float) -> str:
    return f"{round(lat, 4):.4f}:{round(lon, 4):.4f}"


def parse_day(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{name} muss YYYY-MM-DD sein") from exc


def date_range(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def decimal_to_float(value: Any) -> Any:
    return float(value) if isinstance(value, Decimal) else value


# ── Schema bootstrap ──────────────────────────────────────────────────────────

def create_schema() -> None:
    last_error = None
    for _ in range(30):
        try:
            with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS clients (
                      client_id    TEXT PRIMARY KEY,
                      display_name TEXT,
                      settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
                      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )""")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS client_locations (
                      id         BIGSERIAL PRIMARY KEY,
                      client_id  TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
                      kind       TEXT NOT NULL CHECK (kind IN ('favorite','field')),
                      name       TEXT NOT NULL,
                      latitude   DOUBLE PRECISION NOT NULL,
                      longitude  DOUBLE PRECISION NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      UNIQUE (client_id, kind, latitude, longitude)
                    )""")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS historical_daily (
                      location_key TEXT NOT NULL,
                      latitude     DOUBLE PRECISION NOT NULL,
                      longitude    DOUBLE PRECISION NOT NULL,
                      day          DATE NOT NULL,
                      payload      JSONB NOT NULL,
                      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                      PRIMARY KEY (location_key, day)
                    )""")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS forecast_cache (
                      location_key   TEXT NOT NULL,
                      latitude       DOUBLE PRECISION NOT NULL,
                      longitude      DOUBLE PRECISION NOT NULL,
                      past_days      INTEGER NOT NULL,
                      forecast_days  INTEGER NOT NULL,
                      payload        JSONB NOT NULL,
                      fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
                      PRIMARY KEY (location_key, past_days, forecast_days)
                    )""")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS app_settings (
                      key        TEXT PRIMARY KEY,
                      value      TEXT NOT NULL,
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )""")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS push_subscriptions (
                      id               BIGSERIAL PRIMARY KEY,
                      client_id        TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
                      endpoint         TEXT NOT NULL UNIQUE,
                      p256dh           TEXT NOT NULL,
                      auth             TEXT NOT NULL,
                      lat              DOUBLE PRECISION NOT NULL,
                      lon              DOUBLE PRECISION NOT NULL,
                      last_notified_at TIMESTAMPTZ,
                      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
                    )""")
                conn.execute("CREATE INDEX IF NOT EXISTS historical_daily_day_idx  ON historical_daily(day)")
                conn.execute("CREATE INDEX IF NOT EXISTS forecast_cache_fetched_idx ON forecast_cache(fetched_at)")
                conn.commit()
                return
        except psycopg.OperationalError as exc:
            last_error = exc
            time.sleep(1)
    raise RuntimeError("Datenbank ist nicht erreichbar") from last_error


# ── VAPID key management ──────────────────────────────────────────────────────

async def init_vapid() -> None:
    global vapid_private_pem, vapid_public_b64
    async with pool.connection() as conn:
        cur  = await conn.execute(
            "SELECT key, value FROM app_settings WHERE key IN ('vapid_private','vapid_public')"
        )
        rows = {r["key"]: r["value"] for r in await cur.fetchall()}
    if "vapid_private" in rows and "vapid_public" in rows:
        vapid_private_pem = rows["vapid_private"]
        vapid_public_b64  = rows["vapid_public"]
        return
    # Generate once
    from py_vapid import Vapid
    v = Vapid()
    v.generate_keys()
    vapid_private_pem = v.private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    vapid_public_b64 = base64.urlsafe_b64encode(
        v.public_key.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
    ).rstrip(b"=").decode("ascii")
    async with pool.connection() as conn:
        for k, val in [("vapid_private", vapid_private_pem), ("vapid_public", vapid_public_b64)]:
            await conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
                (k, val),
            )
        await conn.commit()
    print(f"VAPID public key: {vapid_public_b64}", flush=True)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    global pool
    create_schema()
    pool = AsyncConnectionPool(
        conninfo=DATABASE_URL, min_size=2, max_size=10,
        kwargs={"row_factory": dict_row}, open=False,
    )
    await pool.open()
    await init_vapid()
    asyncio.create_task(forecast_refresh_loop())
    asyncio.create_task(frost_push_loop())
    yield
    await pool.close()


app = FastAPI(
    title="MoWetter",
    lifespan=lifespan,
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url="/redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), payment=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data:; "
        "connect-src 'self' https://api.open-meteo.com https://archive-api.open-meteo.com "
        "https://geocoding-api.open-meteo.com; "
        "manifest-src 'self'; "
        "worker-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'",
    )
    if request.headers.get("X-Forwarded-Proto", request.url.scheme) == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


# ── Client API ────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/ready")
async def ready() -> dict[str, str]:
    if pool is None:
        raise HTTPException(status_code=503, detail="Datenbank nicht bereit")
    try:
        async with pool.connection() as conn:
            await conn.execute("SELECT 1")
    except psycopg.Error as exc:
        print(f"Readiness check failed: {exc}", flush=True)
        raise HTTPException(status_code=503, detail="Datenbank nicht bereit") from exc
    return {"status": "ready"}


@app.post("/api/clients/{client_id}")
@limiter.limit("30/minute")
async def touch_client(request: Request, client_id: str) -> dict[str, Any]:
    client_id = normalize_client_id(client_id)
    async with pool.connection() as conn:
        cur = await conn.execute(
            """INSERT INTO clients (client_id) VALUES (%s)
               ON CONFLICT (client_id) DO UPDATE SET last_seen_at = now()
               RETURNING client_id, display_name, settings, created_at, last_seen_at""",
            (client_id,),
        )
        row = await cur.fetchone()
        await conn.commit()
    return dict(row)


@app.get("/api/clients/{client_id}/locations")
@limiter.limit("60/minute")
async def get_locations(
    request: Request, client_id: str, kind: str = Query(pattern="^(favorite|field)$")
) -> dict[str, Any]:
    client_id = normalize_client_id(client_id)
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO clients (client_id) VALUES (%s) "
            "ON CONFLICT (client_id) DO UPDATE SET last_seen_at = now()",
            (client_id,),
        )
        cur = await conn.execute(
            "SELECT name, latitude AS lat, longitude AS lon FROM client_locations "
            "WHERE client_id = %s AND kind = %s ORDER BY created_at, id",
            (client_id, kind),
        )
        rows = await cur.fetchall()
        await conn.commit()
    return {"items": [dict(r) for r in rows]}


@app.put("/api/clients/{client_id}/locations")
@limiter.limit("30/minute")
async def put_locations(request: Request, client_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    client_id = normalize_client_id(client_id)
    kind  = payload.get("kind")
    items = payload.get("items")
    if kind not in {"favorite", "field"} or not isinstance(items, list):
        raise HTTPException(status_code=400, detail="kind/items ungueltig")
    clean: list[dict[str, Any]] = []
    for item in items[:100]:
        name = str(item.get("name", "")).strip()[:120]
        try:
            lat = float(item.get("lat"))
            lon = float(item.get("lon"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="lat/lon ungueltig") from exc
        if not name or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            raise HTTPException(status_code=400, detail="standort ungueltig")
        clean.append({"name": name, "lat": lat, "lon": lon})
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO clients (client_id) VALUES (%s) "
            "ON CONFLICT (client_id) DO UPDATE SET last_seen_at = now()",
            (client_id,),
        )
        await conn.execute(
            "DELETE FROM client_locations WHERE client_id = %s AND kind = %s",
            (client_id, kind),
        )
        for item in clean:
            await conn.execute(
                "INSERT INTO client_locations (client_id, kind, name, latitude, longitude) "
                "VALUES (%s, %s, %s, %s, %s)",
                (client_id, kind, item["name"], item["lat"], item["lon"]),
            )
        await conn.commit()
    return {"items": clean}


# ── Push API ──────────────────────────────────────────────────────────────────

@app.get("/api/push/vapid-public-key")
def get_vapid_public_key() -> dict[str, str]:
    return {"publicKey": vapid_public_b64}


@app.post("/api/push/subscribe")
@limiter.limit("10/minute")
async def push_subscribe(request: Request, payload: dict[str, Any]) -> dict[str, str]:
    client_id = normalize_client_id(str(payload.get("client_id", "")))
    sub       = payload.get("subscription") or {}
    endpoint  = str(sub.get("endpoint", "")).strip()
    p256dh    = str((sub.get("keys") or {}).get("p256dh", "")).strip()
    auth      = str((sub.get("keys") or {}).get("auth",   "")).strip()
    lat, lon = validate_lat_lon(payload.get("lat", 0), payload.get("lon", 0))
    if not endpoint or not PUSH_ENDPOINT_RE.match(endpoint) or not p256dh or not auth:
        raise HTTPException(status_code=400, detail="Ungültige Subscription")
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO clients (client_id) VALUES (%s) "
            "ON CONFLICT (client_id) DO UPDATE SET last_seen_at = now()",
            (client_id,),
        )
        await conn.execute(
            """INSERT INTO push_subscriptions (client_id, endpoint, p256dh, auth, lat, lon)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (endpoint) DO UPDATE SET
                 client_id = EXCLUDED.client_id, p256dh = EXCLUDED.p256dh,
                 auth = EXCLUDED.auth, lat = EXCLUDED.lat, lon = EXCLUDED.lon""",
            (client_id, endpoint, p256dh, auth, lat, lon),
        )
        await conn.commit()
    return {"status": "ok"}


@app.delete("/api/push/unsubscribe")
@limiter.limit("10/minute")
async def push_unsubscribe(request: Request, payload: dict[str, Any]) -> dict[str, str]:
    endpoint = str(payload.get("endpoint", "")).strip()
    if not endpoint:
        raise HTTPException(status_code=400, detail="Kein endpoint")
    async with pool.connection() as conn:
        await conn.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,))
        await conn.commit()
    return {"status": "ok"}


# ── Archive / History ─────────────────────────────────────────────────────────

async def fetch_archive(lat: float, lon: float, start: date, end: date) -> dict[str, Any]:
    params = {
        "latitude": lat, "longitude": lon,
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": ("temperature_2m_max,temperature_2m_min,precipitation_sum,"
                  "windspeed_10m_max,weathercode,et0_fao_evapotranspiration"),
        "hourly": "soil_temperature_0_to_7cm",
        "timezone": "auto",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get("https://archive-api.open-meteo.com/v1/archive", params=params)
        r.raise_for_status()
        return r.json()


def daily_soil_average(archive: dict[str, Any], day: str) -> float | None:
    hourly = archive.get("hourly") or {}
    times  = hourly.get("time") or []
    values = hourly.get("soil_temperature_0_to_7cm") or []
    vs = [v for t, v in zip(times, values) if t.startswith(day) and v is not None]
    return round(sum(vs) / len(vs), 1) if vs else None


def payloads_from_archive(archive: dict[str, Any]) -> dict[str, dict[str, Any]]:
    daily  = archive.get("daily") or {}
    days   = daily.get("time") or []
    result: dict[str, dict[str, Any]] = {}
    for i, day in enumerate(days):
        payload: dict[str, Any] = {}
        for key in DAILY_KEYS:
            payload[key] = (daily_soil_average(archive, day)
                            if key == "soil_temperature_avg"
                            else (daily.get(key) or [None] * len(days))[i])
        result[day] = payload
    return result


async def load_history_rows(lat: float, lon: float, start: date, end: date) -> list[dict[str, Any]]:
    key = location_key(lat, lon)
    async with pool.connection() as conn:
        cur  = await conn.execute(
            "SELECT day, payload, fetched_at FROM historical_daily "
            "WHERE location_key = %s AND day BETWEEN %s AND %s ORDER BY day",
            (key, start, end),
        )
        return await cur.fetchall()


def stale_or_missing_days(rows: list[dict[str, Any]], start: date, end: date) -> list[date]:
    by_day       = {row["day"]: row for row in rows}
    today_utc    = datetime.now(timezone.utc).date()
    stale_cutoff = today_utc - timedelta(days=7)
    missing = []
    for day in date_range(start, end):
        row = by_day.get(day)
        if not row:
            missing.append(day)
        elif day >= stale_cutoff and row["fetched_at"].date() < today_utc:
            missing.append(day)
    return missing


async def upsert_history(lat: float, lon: float, payloads: dict[str, dict[str, Any]]) -> None:
    key = location_key(lat, lon)
    async with pool.connection() as conn:
        for day, payload in payloads.items():
            await conn.execute(
                """INSERT INTO historical_daily
                     (location_key, latitude, longitude, day, payload, fetched_at)
                   VALUES (%s, %s, %s, %s, %s, now())
                   ON CONFLICT (location_key, day)
                   DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()""",
                (key, lat, lon, day, Jsonb(payload)),
            )
        await conn.commit()


def open_meteo_shape(rows: list[dict[str, Any]]) -> dict[str, Any]:
    days:  list[str]       = []
    daily: dict[str, list] = {key: [] for key in DAILY_KEYS}
    for row in rows:
        days.append(row["day"].isoformat())
        for key in DAILY_KEYS:
            daily[key].append(decimal_to_float(row["payload"].get(key)))
    daily["time"] = days
    return {"daily": daily, "hourly": {"time": []}, "source": "mowetter-db"}


# ── Forecast cache ────────────────────────────────────────────────────────────

async def fetch_forecast(lat: float, lon: float, past_days: int, forecast_days: int) -> dict[str, Any]:
    params = {
        "latitude": lat, "longitude": lon,
        "hourly": FORECAST_HOURLY, "daily": FORECAST_DAILY,
        "current_weather": "true",
        "past_days": past_days, "forecast_days": forecast_days,
        "timezone": "auto",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
        r.raise_for_status()
        return r.json()


async def load_forecast_cache(lat: float, lon: float, past_days: int, forecast_days: int) -> dict[str, Any] | None:
    key = location_key(lat, lon)
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT payload, fetched_at FROM forecast_cache "
            "WHERE location_key = %s AND past_days = %s AND forecast_days = %s",
            (key, past_days, forecast_days),
        )
        return await cur.fetchone()


def forecast_is_fresh(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    return (datetime.now(timezone.utc) - row["fetched_at"]).total_seconds() < FORECAST_CACHE_TTL_SECONDS


async def upsert_forecast_cache(lat: float, lon: float, past_days: int, forecast_days: int, payload: dict[str, Any]) -> None:
    key = location_key(lat, lon)
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO forecast_cache
                 (location_key, latitude, longitude, past_days, forecast_days, payload, fetched_at)
               VALUES (%s, %s, %s, %s, %s, %s, now())
               ON CONFLICT (location_key, past_days, forecast_days)
               DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()""",
            (key, lat, lon, past_days, forecast_days, Jsonb(payload)),
        )
        await conn.commit()


async def cached_forecast(lat: float, lon: float, past_days: int, forecast_days: int, force: bool = False) -> dict[str, Any]:
    row = await load_forecast_cache(lat, lon, past_days, forecast_days)
    if not force and forecast_is_fresh(row):
        payload = dict(row["payload"])
        payload["_mowetter_cache"] = {
            "status": "hit",
            "fetched_at": row["fetched_at"].isoformat(),
            "ttl_seconds": FORECAST_CACHE_TTL_SECONDS,
        }
        return payload
    try:
        payload = await fetch_forecast(lat, lon, past_days, forecast_days)
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        print(f"Open-Meteo forecast fetch failed: {exc}", flush=True)
        if row:
            payload = dict(row["payload"])
            payload["_mowetter_cache"] = {
                "status": "stale",
                "fetched_at": row["fetched_at"].isoformat(),
                "ttl_seconds": FORECAST_CACHE_TTL_SECONDS,
                "warning": "Live-Wetterdaten aktuell nicht verfuegbar, zwischengespeicherte Daten werden angezeigt",
            }
            return payload
        raise HTTPException(status_code=503, detail="Wetterdaten aktuell nicht verfuegbar") from exc
    await upsert_forecast_cache(lat, lon, past_days, forecast_days, payload)
    payload["_mowetter_cache"] = {
        "status": "refresh" if row else "miss",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "ttl_seconds": FORECAST_CACHE_TTL_SECONDS,
    }
    return payload


# ── Background tasks ──────────────────────────────────────────────────────────

async def saved_locations() -> list[dict[str, float]]:
    async with pool.connection() as conn:
        cur  = await conn.execute(
            "SELECT DISTINCT latitude AS lat, longitude AS lon "
            "FROM client_locations ORDER BY latitude, longitude LIMIT 200"
        )
        return [dict(r) for r in await cur.fetchall()]


async def forecast_refresh_loop() -> None:
    await asyncio.sleep(20)
    while True:
        try:
            locs = await saved_locations()
        except Exception as exc:
            print(f"Forecast-Warmup: Standorte nicht ladbar: {exc}", flush=True)
            await asyncio.sleep(FORECAST_REFRESH_SECONDS)
            continue
        for loc in locs:
            try:
                await cached_forecast(loc["lat"], loc["lon"], 7, 14, force=False)
            except Exception as exc:
                print(f"Forecast-Warmup fehlgeschlagen ({loc}): {exc}", flush=True)
            await asyncio.sleep(1)
        await asyncio.sleep(FORECAST_REFRESH_SECONDS)


async def send_web_push(sub: dict[str, Any], title: str, body: str) -> None:
    from pywebpush import webpush, WebPushException
    data = json.dumps({"title": title, "body": body, "tag": "frost-alarm", "requireInteraction": True})
    def _push():
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=data,
            vapid_private_key=vapid_private_pem,
            vapid_claims=VAPID_CLAIMS,
        )
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _push)


async def frost_push_loop() -> None:
    await asyncio.sleep(60)
    while True:
        if vapid_private_pem:
            try:
                await send_frost_push_notifications()
            except Exception as exc:
                print(f"Frost-Push-Loop Fehler: {exc}", flush=True)
        await asyncio.sleep(1800)


async def send_frost_push_notifications() -> None:
    async with pool.connection() as conn:
        cur  = await conn.execute(
            "SELECT id, endpoint, p256dh, auth, lat, lon, last_notified_at FROM push_subscriptions"
        )
        subs = await cur.fetchall()
    if not subs:
        return
    cutoff = datetime.now(timezone.utc) - timedelta(hours=FROST_PUSH_COOLDOWN_H)
    for sub in subs:
        if sub["last_notified_at"] and sub["last_notified_at"] > cutoff:
            continue
        try:
            forecast = await cached_forecast(sub["lat"], sub["lon"], 0, 2)
            times    = forecast.get("hourly", {}).get("time", [])
            temps    = forecast.get("hourly", {}).get("temperature_2m", [])
            today_s  = date.today().isoformat()
            next_24  = [v for t, v in zip(times, temps) if t >= today_s and v is not None][:24]
            if not next_24 or min(next_24) >= 0:
                continue
            min_t = min(next_24)
            await send_web_push(sub, "❄️ Frostwarnung – WetterBoard",
                                f"Temperatur fällt auf {min_t:.1f}°C in den nächsten 24h.")
            async with pool.connection() as conn:
                await conn.execute(
                    "UPDATE push_subscriptions SET last_notified_at = now() WHERE id = %s",
                    (sub["id"],),
                )
                await conn.commit()
        except Exception as exc:
            short = sub["endpoint"][:40]
            if "410" in str(exc) or "404" in str(exc):
                async with pool.connection() as conn:
                    await conn.execute("DELETE FROM push_subscriptions WHERE id = %s", (sub["id"],))
                    await conn.commit()
                print(f"Push-Subscription abgelaufen, gelöscht: {short}…", flush=True)
            else:
                print(f"Frost-Push fehlgeschlagen ({short}…): {exc}", flush=True)


# ── Forecast + History endpoints ──────────────────────────────────────────────

@app.get("/api/forecast")
@limiter.limit("60/minute")
async def get_forecast(
    request: Request, lat: float, lon: float,
    past_days: int = 2, forecast_days: int = 14, force: bool = False,
) -> dict[str, Any]:
    lat, lon = validate_lat_lon(lat, lon)
    past_days     = max(0, min(past_days, 92))
    forecast_days = max(1, min(forecast_days, 16))
    return await cached_forecast(lat, lon, past_days, forecast_days, force=force)


@app.get("/api/history")
@limiter.limit("20/minute")
async def get_history(
    request: Request, lat: float, lon: float, start_date: str, end_date: str,
) -> dict[str, Any]:
    lat, lon = validate_lat_lon(lat, lon)
    start = parse_day(start_date, "start_date")
    end   = parse_day(end_date,   "end_date")
    if end < start:
        raise HTTPException(status_code=400, detail="end_date liegt vor start_date")
    if (end - start).days > 366:
        raise HTTPException(status_code=400, detail="maximal 366 Tage pro Anfrage")
    archive_end = date.today() - timedelta(days=2)
    if end > archive_end:
        end = archive_end
    if end < start:
        raise HTTPException(status_code=404, detail="Archivdaten noch nicht verfuegbar")
    rows    = await load_history_rows(lat, lon, start, end)
    missing = stale_or_missing_days(rows, start, end)
    if missing:
        try:
            archive = await fetch_archive(lat, lon, min(missing), max(missing))
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            print(f"Open-Meteo archive fetch failed: {exc}", flush=True)
            raise HTTPException(status_code=503, detail="Archivdaten aktuell nicht verfuegbar") from exc
        await upsert_history(lat, lon, payloads_from_archive(archive))
        rows = await load_history_rows(lat, lon, start, end)
    return open_meteo_shape(rows)


# ── Static file serving ───────────────────────────────────────────────────────

_STATIC_EXTENSIONS = {".html", ".js", ".json", ".css", ".svg", ".png", ".ico", ".webp", ".jpg", ".jpeg", ".txt"}

app.mount("/static", StaticFiles(directory=ROOT), name="static")


@app.api_route("/", methods=["GET", "HEAD"])
def index() -> FileResponse:
    return no_cache_file(ROOT / "index.html")


@app.api_route("/manifest.json", methods=["GET", "HEAD"])
def manifest() -> FileResponse:
    return no_cache_file(ROOT / "manifest.json", media_type="application/manifest+json")


@app.api_route("/sw.js", methods=["GET", "HEAD"])
def service_worker() -> FileResponse:
    return no_cache_file(ROOT / "sw.js", media_type="text/javascript")


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def static_file(path: str) -> FileResponse:
    if not ENABLE_API_DOCS and path in {"docs", "redoc", "openapi.json"}:
        raise HTTPException(status_code=404, detail="Nicht gefunden")
    file_path = ROOT / path
    safe = (
        file_path.is_file()
        and file_path.resolve().is_relative_to(ROOT)
        and file_path.suffix in _STATIC_EXTENSIONS
        and not any(part.startswith(".") for part in Path(path).parts)
    )
    return FileResponse(file_path if safe else ROOT / "index.html")
