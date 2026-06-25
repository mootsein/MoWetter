# MoWetter / WetterBoard Wiesenburg — Stack

Agrarmeteorologisches Dashboard für Landgut Wiesenburg. PWA mit Offline-Support, Frost-Push-Alarmen und historischen Wetterdaten. Keine externen Wetterdienst-Kosten — alles über Open-Meteo.

Live: https://mowetter.mownet.de

## Runtime

| Layer | Detail |
|---|---|
| Language | Python 3.13 |
| Framework | FastAPI 0.115.6 |
| ASGI server | Uvicorn 0.34.0 |
| DB | PostgreSQL 16-alpine |
| Container | Docker Compose, 3 Services |
| Tunnel | Cloudflare Tunnel → mowetter.mownet.de |
| Port | 127.0.0.1:8020 → 8000 |

## Key dependencies

- **psycopg3** (`psycopg[binary]`) + **psycopg-pool** — async PostgreSQL
- **httpx** — async HTTP client für Open-Meteo API-Calls
- **slowapi** — Rate Limiting (IP-aware, CF-Header-kompatibel)
- **pywebpush** + **cryptography** — VAPID Web Push Notifications

## Datenquellen (alle kostenlos, kein API-Key)

- `api.open-meteo.com/v1/forecast` — Stundenprognose, 14 Tage voraus
- `archive-api.open-meteo.com/v1/archive` — Historische Tagesdaten
- `geocoding-api.open-meteo.com/v1/search` — Ortssuche

## Caching-Strategie

Forecast-Daten werden in PostgreSQL gecacht (TTL 900s). Background-Loop refresht alle aktiven Favoriten-Standorte alle 15 min. History-Cache: re-fetch wenn letzter Eintrag älter als 7 Tage.

## Background Tasks (asyncio)

- `forecast_refresh_loop()` — alle 15 min Warmup-Cache für alle Favoriten
- `frost_push_loop()` — alle 30 min Frost-Check → Web Push (8h Cooldown pro Location)

## Frontend

Vanilla HTML5 + JS, PWA. Service Worker v15: `index.html` network-first, Assets cache-first, API-Calls ungecacht.  
Chart.js 4.4.1 + xlsx 0.18.5 via CDN. Kein Build-Step.

## DB-Schema

`clients` → `client_locations` (Favoriten/Felder) → `forecast_cache` / `historical_daily` / `push_subscriptions` / `app_settings` (VAPID Keys)

## Security

Strict CSP, HSTS, X-Frame-Options DENY, Permissions-Policy. Rate Limits: 60/min Forecast, 30/min Client-API, 10/min Push, 20/min History.

## Rebuild

```bash
cd ~/projects/MoWetter
docker compose up -d --build
```
