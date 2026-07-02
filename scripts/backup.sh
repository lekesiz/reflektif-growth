#!/usr/bin/env bash
#
# backup.sh — lokal reflektif_growth DB'nin DR yedeği (pg_dump → gzip → ~/reflektif-growth-backups/).
# Free Supabase kullanılmıyor (yedeksiz); lokal PG'nin yedeği BİZİM sorumluluğumuz.
# launchd/cron ile günlük çalıştır. GFS için eski dosyaları ayrıca temizleyebilirsin.
#
# Kullanım: scripts/backup.sh   (env: DATABASE_URL veya varsayılan lokal)

set -euo pipefail

PG_BIN="/opt/homebrew/opt/postgresql@15/bin"
DB_URL="${DATABASE_URL:-postgres://$(whoami)@localhost:5432/reflektif_growth}"
OUT_DIR="${BACKUP_DIR:-$HOME/reflektif-growth-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/reflektif_growth-$STAMP.sql.gz"

echo "yedekleniyor → $FILE"
"$PG_BIN/pg_dump" "$DB_URL" | gzip > "$FILE"
echo "tamam: $(du -h "$FILE" | cut -f1)"

# Basit retention: 30 günden eski yedekleri sil.
find "$OUT_DIR" -name 'reflektif_growth-*.sql.gz' -mtime +30 -delete 2>/dev/null || true

# TODO (Faz 2+): sağlayıcı-dışı kopya (R2/B2) + haftalık restore tatbikatı.
