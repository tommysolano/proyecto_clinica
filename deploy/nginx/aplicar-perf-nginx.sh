#!/usr/bin/env bash
#
# Aplica los ajustes de rendimiento de nginx (gzip + caché de estáticos + HTTP/2).
#
#   Ejecutar EN EL VPS como root (Web Console de DigitalOcean → panel del droplet
#   → Access → Launch Droplet Console):
#
#       cd /var/www/clinica && sudo bash deploy/nginx/aplicar-perf-nginx.sh
#
# Es IDEMPOTENTE: se puede correr las veces que haga falta.
# Ante cualquier fallo de `nginx -t` deshace TODO y deja nginx como estaba: en el
# peor caso no mejora nada, pero nunca tumba el sitio.
#
set -euo pipefail

CONF_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/clinica-perf.conf"
CONF_DST="/etc/nginx/conf.d/clinica-perf.conf"
SITIO="${1:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/nginx-backup-$STAMP"

if [ "$(id -u)" != "0" ]; then
  echo "ERROR: hay que ejecutarlo como root (usa sudo)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
echo "==> Copias de seguridad en $BACKUP_DIR"

# --- Localizar el fichero del sitio (el que gestiona certbot) ----------------
if [ -z "$SITIO" ]; then
  SITIO="$(grep -rl "app.shiluvecuador.com" /etc/nginx/sites-enabled/ 2>/dev/null | head -1 || true)"
fi
if [ -z "$SITIO" ] || [ ! -f "$SITIO" ]; then
  echo "AVISO: no encuentro el fichero del sitio en /etc/nginx/sites-enabled/."
  echo "       Se instalará gzip + caché igualmente; HTTP/2 habrá que activarlo a mano."
  echo "       (puedes pasarlo como argumento: $0 /etc/nginx/sites-enabled/mi-sitio)"
  SITIO=""
else
  echo "==> Sitio detectado: $SITIO"
  cp -a "$SITIO" "$BACKUP_DIR/"
fi

[ -f "$CONF_DST" ] && cp -a "$CONF_DST" "$BACKUP_DIR/"

# --- 1. gzip + Cache-Control + client_max_body_size --------------------------
echo "==> 1/3 Instalando $CONF_DST"
install -m 0644 "$CONF_SRC" "$CONF_DST"

# El nginx.conf de Ubuntu ya trae `gzip on;` y a veces algún `gzip_*` suelto.
# Duplicar `gzip on` no es un error para nginx (gana el más interno), pero si el
# nginx.conf define `gzip_types` se quedaría el suyo. Lo avisamos para revisarlo.
if grep -qE '^\s*gzip_types' /etc/nginx/nginx.conf 2>/dev/null; then
  echo "    AVISO: /etc/nginx/nginx.conf ya define gzip_types (no está comentado)."
  echo "           Revisa que incluya application/javascript, o coméntalo."
fi

# --- 2. HTTP/2 ---------------------------------------------------------------
# nginx 1.24 NO tiene la directiva `http2 on;` (llegó en 1.25.1): en 1.24 hay que
# añadir `http2` como parámetro del `listen`. Sin HTTP/2 el navegador se limita a
# 6 conexiones por dominio, y la página de Marketing lanza 10 peticiones a la vez.
if [ -n "$SITIO" ]; then
  VER="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 0.0.0)"
  echo "==> 2/3 Activando HTTP/2 (nginx $VER)"
  if grep -qE '^\s*listen\s+[^;]*ssl[^;]*http2' "$SITIO"; then
    echo "    Ya estaba activado."
  elif grep -qE '^\s*http2\s+on\s*;' "$SITIO"; then
    echo "    Ya estaba activado (directiva http2 on)."
  else
    # Añade el parámetro http2 SOLO a las líneas listen que ya tengan ssl.
    sed -i -E 's/^(\s*listen\s+[^;]*\bssl\b)([^;]*);/\1\2 http2;/' "$SITIO"
    if grep -qE '^\s*listen\s+[^;]*ssl[^;]*http2' "$SITIO"; then
      echo "    Añadido 'http2' a la(s) línea(s) listen ... ssl."
    else
      echo "    AVISO: no encontré ninguna 'listen ... ssl;' que modificar."
      echo "           ¿Está el certificado puesto? (certbot --nginx)"
    fi
  fi
else
  echo "==> 2/3 HTTP/2 omitido (sin fichero de sitio)."
fi

# --- 3. Verificar y recargar -------------------------------------------------
echo "==> 3/3 Verificando la configuración"
if ! nginx -t; then
  echo
  echo "ERROR: la configuración NO es válida. DESHACIENDO todo…" >&2
  rm -f "$CONF_DST"
  [ -f "$BACKUP_DIR/$(basename "$CONF_DST")" ] && cp -a "$BACKUP_DIR/$(basename "$CONF_DST")" "$CONF_DST"
  if [ -n "$SITIO" ] && [ -f "$BACKUP_DIR/$(basename "$SITIO")" ]; then
    cp -a "$BACKUP_DIR/$(basename "$SITIO")" "$SITIO"
  fi
  nginx -t && echo "Restaurado el estado anterior. nginx sigue como estaba." >&2
  exit 1
fi

systemctl reload nginx
echo
echo "==> Listo. Comprobación (debe salir Content-Encoding: gzip y Cache-Control):"
echo
ASSET="$(ls -1 /var/www/clinica/client/dist/assets/*.js 2>/dev/null | head -1 | xargs -r basename || true)"
if [ -n "$ASSET" ]; then
  curl -sS -o /dev/null -D - --compressed "https://app.shiluvecuador.com/assets/$ASSET" \
    | grep -iE 'HTTP/|content-encoding|content-length|cache-control' || true
  echo
  echo "    Tamaño en disco : $(stat -c%s "/var/www/clinica/client/dist/assets/$ASSET") bytes"
  echo "    Transferido     : $(curl -sS -o /dev/null -w '%{size_download}' --compressed "https://app.shiluvecuador.com/assets/$ASSET") bytes"
else
  echo "    (no encuentro client/dist/assets: ¿falta compilar el frontend?)"
fi
echo
echo "Copias de seguridad en $BACKUP_DIR"
