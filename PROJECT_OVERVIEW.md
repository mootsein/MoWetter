# MoWetter - Projektübersicht

## Zweck
MoWetter ist eine statische Progressive-Web-App (PWA) für Agrarmeteorologie, konzipiert für das Landgut Wiesenburg. Die App zeigt aktuelle Wetterdaten, Prognosen, historische Analyse und einen Soll/Ist-Vergleich für ausgewählte Zeiträume.

## Projektstruktur
- `index.html` - Hauptseite der App. Beinhaltet UI, Styling, Logik, Datenabruf und Chart-Rendering.
- `wetterboard.html` - zweite Variante derselben App. Sieht ähnlich aus wie `index.html` und verwendet dieselben externen Bibliotheken.
- `manifest.json` - Web App Manifest für PWA-Funktionen.
- `sw.js` - Service Worker für Caching und Offline-Support.
- `icon.svg` - App-Symbol.
- `help.html` - kurze Bedienungsanleitung für Website, Desktop-App und mobile PWA.
- `app/main.py` - FastAPI-Backend für Geräte-ID, Standortlisten und historischen Tagesdaten-Cache.
- `docker-compose.yml` - Stack mit `mowetter-web`, PostgreSQL `mowetter-db` und `mowetter-cloudflared`.
- `.gitignore` - Ignoriert lokale Artefakte wie `.DS_Store` und macOS AppleDouble-Dateien (`._*`).

## Wichtige Merkmale
- Statische HTML-basiertes Frontend: kein Build-Schritt, keine zusätzlichen JS/CSS-Dateien.
- Externe Bibliotheken über CDN:
  - Chart.js 4.4.1
  - xlsx 0.18.5
- Datenquelle: Open-Meteo APIs.
- Geocoding zur Ortssuche: `https://geocoding-api.open-meteo.com/v1/search`
- Wetterdatenabfrage: `https://api.open-meteo.com/v1/forecast`
- PWA-Funktionen:
  - App-Manifest
  - Service Worker für Caching
  - Standalone-Display auf Mobilgeräten

## Kernfunktionen
- Ortssuche mit Autocomplete
- Dashboard mit Wetter-Kacheln
- Chart-Popups für Detailansichten
- Historische Analyse und Export (CSV/Excel)
- Soll/Ist-Vergleich zwischen historischen Werten und Modellvorhersagen
- Mobile Interaktionen: Touch-Swipe-Handling, Popup-Schließen, Theme Switching

## Backend und Datenhaltung
- Beim ersten App-Start erzeugt der Browser eine lokale Geräte-ID (`mw_...`) und registriert sie über `/api/clients/{client_id}`.
- Favoriten und Schläge bleiben sofort lokal nutzbar, werden aber zusätzlich über die Geräte-ID in Postgres synchronisiert.
- Aktuelle Wetter- und Prognosedaten laufen über `/api/forecast`; das Backend cached Forecasts pro Standort in Postgres und aktualisiert sie erst nach Ablauf des TTL.
- Historische Analyse-Daten laufen über `/api/history`; das Backend fragt Open-Meteo Archive nur bei fehlenden oder tagesalten Cache-Zeilen ab und speichert Tageswerte lokal in Postgres.
- Gespeicherte Favoriten/Schläge werden im Hintergrund regelmäßig vorgewärmt, damit häufig genutzte Standorte schnell aus der DB kommen.
- Der lokale Dienst ist an `127.0.0.1:8020` gebunden und zusätzlich per Cloudflare Tunnel unter `https://mowetter.mownet.de` erreichbar.

## Caching-Strategie in `sw.js`
- `index.html` wird Network-first geladen, um immer aktuelle App-Version zu zeigen.
- Statische Assets (`manifest.json`, `icon.svg`, Chart.js) werden cache-first geladen.
- Open-Meteo API-Aufrufe werden nicht gecached; sie bleiben live.
- Lokale `/api/`-Aufrufe werden nie durch den Service Worker gecached.

## Arbeitsablauf
1. Die App wird als statische Seite bereitgestellt.
2. `index.html` enthält die gesamte UI und JavaScript-Logik.
3. `sw.js` registriert den Service Worker und verwaltet den Cache.
4. Prognosedaten werden live von Open-Meteo geholt.
5. Historische Tagesdaten werden serverseitig in Postgres gecached.

## Lokaler Start auf mintpro
```bash
cd /home/moot/projects/MoWetter
docker compose up -d --build
```

Danach:
```text
http://127.0.0.1:8020/
https://mowetter.mownet.de/
```

## Hinweis zur Bereinigung
- Das Repo wurde bereinigt von macOS AppleDouble-Dateien (`._*`) und dafür `._*` zur `.gitignore` hinzugefügt.
- Bei zukünftiger Arbeit sparst du Zeit, weil die statische Struktur und der PWA-Aufbau jetzt dokumentiert sind.

## Empfehlung für später
- Verwende `projects/MoWetter/index.html` als Referenzstartpunkt.
- Prüfe bei Änderungen zunächst, ob die App weiterhin mit dem Service Worker korrekt lädt.
- Bei Deployment bietet sich GitHub Pages oder ein einfacher statischer Webserver an.
