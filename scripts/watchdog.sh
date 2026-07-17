#!/usr/bin/env bash
# Prüft alle mowetter-Container. Bewusst ohne 'set -e': ein fehlgeschlagener
# Recovery-Schritt darf das Skript nicht stumm abbrechen, bevor
# Logging/Telegram-Alarm laufen konnten. Analog zu tippapp/scripts/watchdog.sh.
set -uo pipefail

PROJECT_DIR="/home/moot/projects/MoWetter"
LOG_FILE="${PROJECT_DIR}/logs/watchdog.log"
ENV_FILE="/home/moot/scripts/.env"

mkdir -p "${PROJECT_DIR}/logs"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG_FILE"; }

if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

notify_telegram() {
    local msg="$1"
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
        log "Telegram nicht konfiguriert, überspringe Benachrichtigung: ${msg}"
        return 0
    fi
    curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHAT_ID}" \
        --data-urlencode text="${msg}" \
        >> "$LOG_FILE" 2>&1 \
        || log "WARNUNG: Telegram-Benachrichtigung konnte nicht gesendet werden"
}

cd "$PROJECT_DIR"

# Ein JSON-Objekt pro Container (kein jq installiert, daher grep -oP je Feld).
PS_JSON="$(docker compose ps -a --format json)"

BROKEN=()
while IFS= read -r line; do
    [ -z "$line" ] && continue
    name="$(grep -oP '"Name":"\K[^"]*' <<<"$line")"
    state="$(grep -oP '"State":"\K[^"]*' <<<"$line")"
    health="$(grep -oP '"Health":"\K[^"]*' <<<"$line")"

    if [ "$state" != "running" ]; then
        BROKEN+=("${name} (state=${state})")
    elif [ -n "$health" ] && [ "$health" != "healthy" ]; then
        BROKEN+=("${name} (health=${health})")
    fi
done <<< "$PS_JSON"

if [ "${#BROKEN[@]}" -eq 0 ]; then
    exit 0
fi

log "Problem erkannt bei: ${BROKEN[*]} — starte docker compose up -d"
if docker compose up -d >> "$LOG_FILE" 2>&1; then
    log "docker compose up -d abgeschlossen"
    notify_telegram "ℹ️ mowetter: ${BROKEN[*]} waren down, watchdog hat automatisch neu gestartet — wieder ok."
    exit 0
fi

# Nach einem harten Kill (z.B. SIGKILL) bleibt manchmal ein containerd-Task
# hängen ("failed to create task ... AlreadyExists") und blockiert den
# Neustart per 'up -d' dauerhaft. Betroffene Container per rm -f loswerden
# und erneut versuchen.
log "docker compose up -d fehlgeschlagen, versuche 'docker rm -f' für betroffene Container (Stale-Task-Workaround)"
for entry in "${BROKEN[@]}"; do
    container="${entry%% *}"
    docker rm -f "$container" >> "$LOG_FILE" 2>&1 || true
done

if docker compose up -d >> "$LOG_FILE" 2>&1; then
    log "docker compose up -d nach rm -f erfolgreich"
    notify_telegram "⚠️ mowetter: ${BROKEN[*]} waren down, nach 'docker rm -f' + Neustart wieder ok."
    exit 0
fi

log "KRITISCH: docker compose up -d auch nach rm -f fehlgeschlagen"
notify_telegram "🚨 KRITISCH: mowetter watchdog konnte nicht wiederhergestellt werden (betroffen: ${BROKEN[*]}). Bitte manuell prüfen."
exit 1
