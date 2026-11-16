#!/usr/bin/env bash
# Щоденний pg_dump (custom-формат) у ~/backups/alerts, зберігається KEEP_DAYS днів (.env, за замовчуванням 14).
# Пароль — лише через PGPASSWORD (env), не аргументом команди.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${BACKUP_DIR:-$HOME/backups/alerts}"

# KEEP_DAYS: з env, інакше з .env (читається лише цей рядок, секрети не підвантажуються), інакше 14
if [ -z "${KEEP_DAYS:-}" ] && [ -f "$DIR/.env" ]; then
  KEEP_DAYS="$(sed -n 's/^KEEP_DAYS=//p' "$DIR/.env" | tail -n 1 | tr -d '[:space:]')"
fi
KEEP_DAYS="${KEEP_DAYS:-14}"
case "$KEEP_DAYS" in
  ''|*[!0-9]*) echo "$(date -Is) backup error: KEEP_DAYS must be a number: $KEEP_DAYS"; exit 1 ;;
esac

set -a; . "$DIR/.env.db"; set +a
eval "$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\x27\x27") + "\x27";
  console.log(`export PGHOST=${q(u.hostname)} PGPORT=${q(u.port || "5432")} PGUSER=${q(decodeURIComponent(u.username))} PGDATABASE=${q(u.pathname.slice(1))} PGPASSWORD=${q(decodeURIComponent(u.password))}`);
')"

mkdir -p "$OUT"
FILE="$OUT/alerts-$(date +%F_%H%M).dump"
pg_dump -Fc -f "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
find "$OUT" -name 'alerts-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1)), keep ${KEEP_DAYS}d"
