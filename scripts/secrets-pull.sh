#!/usr/bin/env bash
# secrets-pull — .env'in SIR alanlarını lokal kasadan (secret CLI / macOS Keychain) günceller.
#
# Kasa (bkz. ~/.local/bin/secret) sırların TEK KAYNAĞI; .env türetilmiş bir artefakttır (gitignore'lu).
# Bu script yalnız aşağıdaki SIR anahtarlarını upsert eder — DATABASE_URL/LOG_LEVEL/SENDING_DOMAIN gibi
# sır-olmayan yerel config satırlarına DOKUNMAZ. Değerler ekrana/argv'ye basılmaz.
#
# Kullanım: pnpm secrets:pull   (ya da: bash scripts/secrets-pull.sh)
set -euo pipefail

# Kasada bu adlarla saklanan sırlar (= .env değişken adları). Yeni sır eklersen buraya da ekle.
SECRET_KEYS=(RESEND_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID ANTHROPIC_API_KEY)

cd "$(dirname "$0")/.."          # repo kökü
ENV_FILE=".env"
SECRET_BIN="${SECRET_BIN:-$HOME/.local/bin/secret}"   # login-shell dışı (launchd vb.) için tam yol
[ -x "$SECRET_BIN" ] || { command -v secret >/dev/null && SECRET_BIN=secret || { echo "secrets-pull: 'secret' aracı bulunamadı ($HOME/.local/bin/secret)" >&2; exit 1; }; }

umask 077                        # oluşan geçici dosyalar 0600
tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
tmp2="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$tmp" "$tmp2"' EXIT

[ -f "$ENV_FILE" ] && cat "$ENV_FILE" > "$tmp"   # mevcut .env'i temel al (yoksa boş)

missing=0
for k in "${SECRET_KEYS[@]}"; do
  if ! "$SECRET_BIN" has "$k"; then
    echo "secrets-pull: uyarı — $k kasada yok, atlandı ('secret set $k' ile ekle)" >&2
    missing=1
    continue
  fi
  v="$("$SECRET_BIN" get "$k")"
  # KEY= satırını değeriyle güncelle; yoksa sona ekle. Saf bash (awk/sed kaçış-riski yok); printf builtin → argv sızıntısı yok.
  found=0
  : > "$tmp2"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$k="*) printf '%s=%s\n' "$k" "$v" >> "$tmp2"; found=1 ;;
      *) printf '%s\n' "$line" >> "$tmp2" ;;
    esac
  done < "$tmp"
  [ "$found" = 1 ] || printf '%s=%s\n' "$k" "$v" >> "$tmp2"
  mv "$tmp2" "$tmp"
  v=""
done

mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
trap - EXIT
if [ "$missing" = 1 ]; then
  echo "secrets-pull: .env güncellendi (BAZI anahtarlar kasada yoktu — yukarı bak)" >&2
else
  echo "secrets-pull: .env kasadan güncellendi (${#SECRET_KEYS[@]} sır)" >&2
fi
