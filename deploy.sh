#!/usr/bin/env bash
#
# Despliegue de la app clinica / Shiluv en el VPS.
# Lo ejecuta GitHub Actions en cada push a main, y tambien sirve para correr a mano:
#     sudo -iu clinica bash /var/www/clinica/deploy.sh
#
set -euo pipefail

# Asegura que git / node / npm / pm2 esten en el PATH incluso en sesiones SSH
# no interactivas (como las de GitHub Actions).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
# Si instalaste Node con nvm en lugar de apt, descomenta estas dos lineas:
# export NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

APP_DIR="/var/www/clinica"
BRANCH="main"

cd "$APP_DIR"

echo "==> 1/4 Trayendo el ultimo codigo de origin/$BRANCH"
git fetch --all --prune
git reset --hard "origin/$BRANCH"

echo "==> 2/4 Instalando dependencias (server + client)"
npm run install-all

echo "==> 3/4 Compilando el frontend (regenera client/dist)"
npm --prefix client run build

echo "==> 4/4 Reiniciando el backend con PM2"
pm2 restart clinica-api --update-env
pm2 save

echo "==> Despliegue completado: $(date)"
