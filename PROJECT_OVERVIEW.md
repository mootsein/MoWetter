# MoWetter - Projektübersicht

## Zweck
MoWetter ist eine statische Progressive-Web-App (PWA) für Agrarmeteorologie, konzipiert für das Landgut Wiesenburg. Die App zeigt aktuelle Wetterdaten, Prognosen, historische Analyse und einen Soll/Ist-Vergleich für ausgewählte Zeiträume.

## Projektstruktur
- `index.html` - Hauptseite der App. Beinhaltet UI, Styling, Logik, Datenabruf und Chart-Rendering.
- `wetterboard.html` - zweite Variante derselben App. Sieht ähnlich aus wie `index.html` und verwendet dieselben externen Bibliotheken.
- `manifest.json` - Web App Manifest für PWA-Funktionen.
- `sw.js` - Service Worker für Caching und Offline-Support.
- `icon.svg` - App-Symbol.
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

## Caching-Strategie in `sw.js`
- `index.html` wird Network-first geladen, um immer aktuelle App-Version zu zeigen.
- Statische Assets (`manifest.json`, `icon.svg`, Chart.js) werden cache-first geladen.
- Open-Meteo API-Aufrufe werden nicht gecached; sie bleiben live.

## Arbeitsablauf
1. Die App wird als statische Seite bereitgestellt.
2. `index.html` enthält die gesamte UI und JavaScript-Logik.
3. `sw.js` registriert den Service Worker und verwaltet den Cache.
4. Daten werden live von Open-Meteo geholt.

## Hinweis zur Bereinigung
- Das Repo wurde bereinigt von macOS AppleDouble-Dateien (`._*`) und dafür `._*` zur `.gitignore` hinzugefügt.
- Bei zukünftiger Arbeit sparst du Zeit, weil die statische Struktur und der PWA-Aufbau jetzt dokumentiert sind.

## Empfehlung für später
- Verwende `projects/MoWetter/index.html` als Referenzstartpunkt.
- Prüfe bei Änderungen zunächst, ob die App weiterhin mit dem Service Worker korrekt lädt.
- Bei Deployment bietet sich GitHub Pages oder ein einfacher statischer Webserver an.
