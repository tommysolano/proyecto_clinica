#!/usr/bin/env bash
#
# Aplica los ajustes de rendimiento de nginx (gzip + caché de estáticos + HTTP/2).
#
#   Ejecutar EN EL VPS como root (Web Console de DigitalOcean → panel del droplet
#   → Access → Launch Droplet Console):
#
#       cd /var/www/clinica && sudo bash deploy/nginx/aplicar-perf-nginx.sh
#
#   Opcionalmente se le puede pasar a mano el fichero del sitio:
#       sudo bash deploy/nginx/aplicar-perf-nginx.sh /etc/nginx/conf.d/mi-sitio.conf
#
# Es IDEMPOTENTE: se puede correr las veces que haga falta.
# Ante cualquier fallo de `nginx -t` deshace TODO y deja nginx como estaba: en el
# peor caso no mejora nada, pero nunca tumba el sitio.
#
set -euo pipefail

CONF_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/clinica-perf.conf"
CONF_DST="/etc/nginx/conf.d/clinica-perf.conf"
NGINX_CONF="/etc/nginx/nginx.conf"
SITIO="${1:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/nginx-backup-$STAMP"

if [ "$(id -u)" != "0" ]; then
  echo "ERROR: hay que ejecutarlo como root (usa sudo)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
echo "==> Copias de seguridad en $BACKUP_DIR"
[ -f "$CONF_DST" ] && cp -a "$CONF_DST" "$BACKUP_DIR/"

# ---------------------------------------------------------------------------
# Localizar el bloque `server` (el que gestiona certbot).
#
# NO se busca solo en sites-enabled: según cómo se instalara, el sitio puede
# estar en /etc/nginx/conf.d/, en sites-enabled sin extensión, o con otro nombre.
# Se busca por lo que de verdad lo identifica: una línea `listen ... ssl`.
# ---------------------------------------------------------------------------
if [ -z "$SITIO" ]; then
  SITIO="$(grep -rlE '^[[:space:]]*listen[[:space:]]+[^;]*\bssl\b' /etc/nginx 2>/dev/null \
            | grep -v 'clinica-perf' | head -1 || true)"
fi
# Sin TLS todavía: al menos buscar un server_name del dominio.
if [ -z "$SITIO" ]; then
  SITIO="$(grep -rlE '^[[:space:]]*server_name[[:space:]]+.*shiluv' /etc/nginx 2>/dev/null \
            | grep -v 'clinica-perf' | head -1 || true)"
fi

if [ -n "$SITIO" ] && [ -f "$SITIO" ]; then
  echo "==> Sitio detectado: $SITIO"
  cp -a "$SITIO" "$BACKUP_DIR/sitio-$(basename "$SITIO")"
else
  echo "AVISO: no encuentro el fichero del sitio. Se instalará gzip + caché"
  echo "       igualmente; HTTP/2 habrá que activarlo a mano."
  echo "       Ficheros de nginx con un bloque server, por si ayuda:"
  grep -rlE '^[[:space:]]*server[[:space:]]*\{' /etc/nginx 2>/dev/null | sed 's/^/         /' || true
  SITIO=""
fi

# --- 1. Instalar el drop-in, sin duplicar directivas -------------------------
echo "==> 1/3 Instalando $CONF_DST"
install -m 0644 "$CONF_SRC" "$CONF_DST"

# nginx ABORTA si una directiva ya está declarada en el mismo contexto (`http`),
# no se queda con la más interna. El nginx.conf de Ubuntu trae `gzip on;`, que fue
# justo lo que hizo fallar el primer intento. Así que comentamos en NUESTRA copia
# lo que ya esté activo arriba.
NEUTRALIZADAS=""
for d in gzip gzip_vary gzip_proxied gzip_comp_level gzip_min_length gzip_types client_max_body_size; do
  # `[[:space:]]` tras el nombre evita que `gzip` case con `gzip_vary`.
  if grep -qE "^[[:space:]]*${d}[[:space:]]" "$NGINX_CONF" 2>/dev/null; then
    sed -i -E "s|^([[:space:]]*)(${d}[[:space:]][^;]*;)|\1# [ya activo en nginx.conf] \2|" "$CONF_DST"
    NEUTRALIZADAS="$NEUTRALIZADAS $d"
  fi
done
if [ -n "$NEUTRALIZADAS" ]; then
  echo "    Ya estaban en nginx.conf (se dejan las de allí):$NEUTRALIZADAS"
fi

# `gzip_types` es LA directiva que arregla el problema. Si estuviera declarada
# arriba, la nuestra no se aplica y todo esto no serviría de nada: hay que avisar.
if grep -qE "^[[:space:]]*gzip_types[[:space:]]" "$NGINX_CONF" 2>/dev/null; then
  echo
  echo "    ⚠️  ATENCIÓN: nginx.conf ya define gzip_types y manda la suya."
  echo "        Comprueba que incluya 'application/javascript' y 'text/css'."
  echo "        Si no, coméntala en $NGINX_CONF y vuelve a correr este script."
  echo
fi

# --- 2. HTTP/2 ---------------------------------------------------------------
# nginx 1.24 NO tiene la directiva `http2 on;` (llegó en 1.25.1): en 1.24 hay que
# añadir `http2` como parámetro del `listen`. Sin HTTP/2 el navegador se limita a
# 6 conexiones por dominio, y la página de Marketing lanza 10 peticiones a la vez.
if [ -n "$SITIO" ]; then
  VER="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 0.0.0)"
  echo "==> 2/3 Activando HTTP/2 (nginx $VER)"
  if grep -qE '^[[:space:]]*listen[[:space:]]+[^;]*ssl[^;]*http2' "$SITIO" \
     || grep -qE '^[[:space:]]*http2[[:space:]]+on[[:space:]]*;' "$SITIO"; then
    echo "    Ya estaba activado."
  else
    sed -i -E 's/^([[:space:]]*listen[[:space:]]+[^;]*\bssl\b)([^;]*);/\1\2 http2;/' "$SITIO"
    if grep -qE '^[[:space:]]*listen[[:space:]]+[^;]*ssl[^;]*http2' "$SITIO"; then
      echo "    Añadido 'http2' a la(s) línea(s) listen ... ssl."
    else
      echo "    AVISO: no encontré ninguna 'listen ... ssl;' que modificar."
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
  if [ -n "$SITIO" ] && [ -f "$BACKUP_DIR/sitio-$(basename "$SITIO")" ]; then
    cp -a "$BACKUP_DIR/sitio-$(basename "$SITIO")" "$SITIO"
  fi
  nginx -t && echo "Restaurado el estado anterior. nginx sigue como estaba." >&2
  exit 1
fi

systemctl reload nginx
echo
echo "==> Listo. Comprobación real (debe salir Content-Encoding: gzip y Cache-Control):"
echo
ASSET="$(ls -1 /var/www/clinica/client/dist/assets/*.js 2>/dev/null | head -1 | xargs -r basename || true)"
if [ -n "$ASSET" ]; then
  URL="https://app.shiluvecuador.com/assets/$ASSET"
  curl -sS -o /dev/null -D - --compressed "$URL" \
    | grep -iE 'HTTP/|content-encoding|content-length|cache-control' || true
  echo
  echo "    Tamaño en disco : $(stat -c%s "/var/www/clinica/client/dist/assets/$ASSET") bytes"
  echo "    Transferido     : $(curl -sS -o /dev/null -w '%{size_download}' --compressed "$URL") bytes"
else
  echo "    (no encuentro client/dist/assets: ¿falta compilar el frontend?)"
fi
echo
echo "Copias de seguridad en $BACKUP_DIR"
