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

# EL DESPLIEGUE NO PUEDE SER QUIEN MATE WHATSAPP.
#
# El backend mantiene un Chromium headless por cada numero de WhatsApp conectado
# por QR (300-500 MB cada uno). El despliegue, mientras tanto, es lo mas pesado
# que corre en esta maquina: el `npm install` de server+client y sobre todo el
# `vite build`. Cuando los dos coinciden y la RAM se acaba, el kernel elige a quien
# matar por consumo, y el mas gordo es SIEMPRE un Chromium de WhatsApp: la sesion
# se cae sola en mitad del dia (queda escrito como "el navegador de la sesion se
# cerro solo") y, peor, el perfil de Chrome se queda a medio escribir, que es como
# se acaba teniendo que escanear el QR otra vez.
# Paso el 28-ago-2026: push a las 13:30, navegador muerto a las 13:31:29.
#
# `oom_score_adj` es la preferencia del kernel al elegir victima. Un proceso sin
# privilegios solo puede SUBIRSE la suya (bajarla exige CAP_SYS_RESOURCE), y los
# hijos la heredan, asi que basta con marcar el propio despliegue con el maximo
# (1000) para ponerse el primero de la cola: si falta memoria, el kernel mata la
# compilacion —que se reintenta, y ademas se ve en el log— en vez del WhatsApp de
# la clinica. `nice` completa la idea con la CPU.
sin_matar_whatsapp() {
  nice -n 10 bash -c 'echo 1000 2>/dev/null > /proc/self/oom_score_adj; exec "$@"' _ "$@"
}

# Sin swap, un pico de memoria no tiene amortiguador: el kernel mata en el acto.
if [ "$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}')" = "0" ]; then
  echo "ADVERTENCIA: este VPS no tiene SWAP. Un pico de memoria mata procesos al instante."
  echo "   Para darle 2 GB de colchon (una sola vez, como root):"
  echo "     fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
  echo "     echo '/swapfile none swap sw 0 0' >> /etc/fstab"
fi

echo "==> 1/6 Trayendo el ultimo codigo de origin/$BRANCH"
git fetch --all --prune
git reset --hard "origin/$BRANCH"

echo "==> 2/6 Instalando dependencias (server + client)"
# AMPLIAR UN PARCHE YA EXISTENTE ROMPE EL DESPLIEGUE SI NO SE HACE NADA MAS.
#
# server/package.json tiene `postinstall: patch-package --error-on-fail`, y
# patch-package aplica los parches SOBRE LO QUE HAYA en node_modules. npm no
# vuelve a extraer un paquete cuya version no cambio, asi que cuando un despliegue
# trae un parche AMPLIADO (mismo paquete, misma version, un hunk mas), patch-package
# se encuentra el archivo a medio parchear: no puede aplicarlo hacia delante (el
# hunk viejo ya esta) ni reconocerlo como "ya aplicado" (el hunk nuevo falta).
# Falla, y `set -e` aborta el despliegue en unos 14 segundos, en este paso 2/6, sin
# llegar a reiniciar nada. Paso el 28-ago-2026 al ampliar el parche de
# whatsapp-web.js con la guardia contra mensajes duplicados.
#
# La cura es dejar el paquete como recien bajado de npm y reinstalar. Se hace SOLO
# si el fallo fue del parche: si npm murio por otra cosa (red, disco), se aborta
# como siempre en vez de borrar dependencias a ciegas. Durante el borrado el backend
# viejo sigue vivo con el modulo ya cargado en memoria, asi que solo corre riesgo un
# `require` perezoso en esos segundos; pasa unicamente cuando cambia un parche y el
# reinicio de PM2 llega acto seguido.
LOG_INSTALL="$(mktemp)"
if ! sin_matar_whatsapp npm run install-all 2>&1 | tee "$LOG_INSTALL"; then
  if grep -q 'Failed to apply patch' "$LOG_INSTALL"; then
    echo "--> El parche no aplica sobre el node_modules actual: reinstalo los paquetes parcheados"
    # El nombre del archivo ES el del paquete: `paquete+version.patch`, y en los
    # paquetes con ambito `@ambito+paquete+version.patch`.
    for parche in "$APP_DIR"/server/patches/*.patch; do
      [ -e "$parche" ] || continue
      nombre="$(basename "$parche" .patch)"
      paquete="${nombre%+*}"       # quita la version
      paquete="${paquete//+//}"    # @ambito+paquete -> @ambito/paquete
      echo "    borrando server/node_modules/$paquete"
      rm -rf "${APP_DIR:?}/server/node_modules/$paquete"
    done
    sin_matar_whatsapp npm run install-all
  else
    rm -f "$LOG_INSTALL"
    echo "ERROR: la instalacion de dependencias fallo por un motivo ajeno a los parches."
    exit 1
  fi
fi
rm -f "$LOG_INSTALL"

echo "==> 3/6 Compilando el frontend (regenera client/dist)"
# Compilar es el pico de memoria del despliegue, y la mayoria de los push no tocan
# una sola linea de client/. Se guarda dentro del propio dist el commit con el que
# se genero: si desde entonces no ha cambiado nada bajo client/, el dist que ya
# esta en disco es EXACTAMENTE el que saldria de volver a compilar, asi que no se
# compila. Menos memoria en juego = menos posibilidades de que el kernel se lleve
# por delante una sesion de WhatsApp.
#
# Es seguro por construccion: si falta la marca, si falta el dist, o si git no
# puede comparar contra ese commit (historia reescrita), se compila igual. Y como
# la marca se escribe DESPUES de compilar, una compilacion a medias nunca se da
# por buena: el despliegue aborta antes por `set -e`.
MARCA_DIST="$APP_DIR/client/dist/.commit-compilado"
HEAD_NUEVO="$(git rev-parse HEAD)"
COMPILAR=1
if [ -f "$MARCA_DIST" ] && [ -f "$APP_DIR/client/dist/index.html" ]; then
  COMMIT_DIST="$(cat "$MARCA_DIST")"
  if git diff --quiet "$COMMIT_DIST" "$HEAD_NUEVO" -- client/ 2>/dev/null; then
    COMPILAR=0
  fi
fi
if [ "$COMPILAR" = "1" ]; then
  sin_matar_whatsapp npm --prefix client run build
  echo "$HEAD_NUEVO" > "$MARCA_DIST"
else
  echo "--> client/ no ha cambiado desde ${COMMIT_DIST:0:7}: se conserva el dist ya compilado"
fi

echo "==> 4/6 Tareas de UNA SOLA VEZ"
# Cada tarea lleva su marca en la base (coleccion `onetimetasks`), asi que se ejecuta
# solo en el PRIMER despliegue que la trae: los siguientes push la encuentran DONE y no
# hacen nada. Si falla, queda FAILED y el proximo despliegue la reintenta; el fallo NO
# aborta el despliegue (el codigo nuevo tiene que subir igual), pero sale en el log.
#
# Vigente: borrar todas las ventas para empezar las pruebas desde cero (jul-2026).
# Cuando ya este DONE se puede quitar esta linea sin riesgo (la marca la protege igual).
if ! ( cd "$APP_DIR/server" && node scripts/wipeSalesOnce.js --commit ); then
  echo "ADVERTENCIA: la tarea de una sola vez fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/wipeSalesOnce.js --commit'"
fi

# Vigente: borrar las OPORTUNIDADES FANTASMA (ago-2026).
#
# Hasta ago-2026, un mensaje que llegaba desde un anuncio creaba solo una oportunidad EN
# BLANCO. Eran el 54% del embudo (9.464 de 17.485) y falseaban todas las analiticas. El
# codigo que las creaba se quito, y el 24-ago-2026 se limpio la base a mano con
# --sin-marca; esta linea barre las que se colaron entre esa limpieza y este despliegue,
# que es el que por fin corta la fuente en el VPS.
#
# Antes de quitar nada guarda una copia en la coleccion `oportunidades_fantasma_backup`
# (el M0 no tiene backups). Para deshacerlo:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/wipePhantomOpportunitiesOnce.js --restaurar --commit'
# Para ver que borraria sin borrar nada: el mismo comando sin --commit ni --restaurar.
# Cuando ya este DONE se puede quitar esta linea sin riesgo (la marca la protege igual).
if ! ( cd "$APP_DIR/server" && node scripts/wipePhantomOpportunitiesOnce.js --commit ); then
  echo "ADVERTENCIA: la limpieza de oportunidades fantasma fallo. Reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/wipePhantomOpportunitiesOnce.js --commit'"
fi

# Vigente: UNA historia clinica por paciente (sep-2026).
#
# `clinicalrecords` tenia indice unico (clinic, patient): UNA FICHA POR SUCURSAL. El
# mismo paciente atendido en dos sedes tenia dos historias, cada una invisible desde la
# otra, y al abrirlo desde la sede sin ficha el sistema le creaba una NUEVA EN BLANCO:
# el medico lo veia sin alergias, sin antecedentes y sin ninguna consulta previa.
#
# Esta tarea funde las fichas duplicadas (ordenando los seguimientos por fecha) y deja
# el indice unico correcto: fuera clinic_1_patient_1, dentro patient_1 unico. TIENE QUE
# CORRER ANTES DE QUE ARRANQUE EL CODIGO NUEVO: mongoose no puede construir el indice
# unico mientras queden duplicados, y sin el candado dos peticiones simultaneas desde
# sedes distintas vuelven a crear dos historias.
#
# Guarda copia entera de cada ficha absorbida en `clinicalrecords_merge_backup` (el M0
# no tiene backups y esto es historia clinica). Para ver que haria sin tocar nada:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/mergeClinicalRecordsOnce.js'
# Cuando ya este DONE se puede quitar esta linea sin riesgo (la marca la protege igual).
if ! ( cd "$APP_DIR/server" && node scripts/mergeClinicalRecordsOnce.js --commit ); then
  echo "ADVERTENCIA: la fusion de historias clinicas fallo. Reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/mergeClinicalRecordsOnce.js --commit'"
fi

# ─────────────────────────────────────────────────────────────────────────────────────
# DESACTIVADA A PROPOSITO — dejar la CONTABILIDAD EN CERO para rehacer las pruebas.
#
# El script existe y esta probado, pero NO debe correr todavia. Mientras estas dos
# lineas sigan comentadas, ningun despliegue lo ejecuta.
#
# PARA ACTIVARLO (cuando el usuario lo pida): quitar el '# ' del if / echo / fi de abajo
# y hacer push. Se ejecutara UNA sola vez (marca `borrar-contabilidad-2026-08-10` en la
# coleccion `onetimetasks`); los push siguientes ya no haran nada aunque quede activo.
#
# Borra ventas, compras, cobros/pagos, caja, bancos, inventario, activos, comisiones,
# nomina, asientos, declaraciones SRI y presupuestos. NO toca el CRM/marketing, ni
# pacientes/citas/fichas, ni los catalogos, ni el certificado digital, ni los
# secuenciales del SRI. Ver la cabecera de server/scripts/wipeAccountingOnce.js.
#
# Para ver que borraria sin borrar nada:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/wipeAccountingOnce.js'
#
# if ! ( cd "$APP_DIR/server" && node scripts/wipeAccountingOnce.js --commit ); then
#   echo "ADVERTENCIA: el borrado contable fallo. Revisa el log y reintenta a mano:"
#   echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/wipeAccountingOnce.js --commit'"
# fi
# ─────────────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────────────
# ⚠️  ACTIVA — ARRANQUE DESDE CERO: pacientes + terceros + contabilidad.
#
# ESTE DESPLIEGUE BORRA DATOS DE PRODUCCION. Activada a peticion expresa del usuario
# (15-ago-2026) tras confirmar el alcance. Corre UNA sola vez: la marca
# `borrar-pacientes-terceros-contabilidad-2026-08-15` queda en la coleccion
# `onetimetasks` y los push siguientes ya no hacen nada aunque esta linea siga viva.
#
# BORRA: pacientes con su historia clinica, citas, tratamientos y derivaciones; el
# padron de terceros completo (clientes de mostrador, proveedores, empleados y
# vendedores de /accounting/suppliers); todo el movimiento contable; los catalogos
# contables (plan de cuentas, categorias, productos, bodegas, bancos, tarjetas,
# retenciones, nomina); y reinicia los secuenciales del SRI a 1.
#
# NO TOCA: el escaner (/scanner) ni sus PDF en server/storage/scans — el script no
# escribe en disco en absoluto —, ni Marketing/CRM (solo les quita el enlace al
# paciente borrado), ni usuarios, sucursales, empleados o el certificado digital.
#
# OJO, DOS CONSECUENCIAS: (1) sin plan de cuentas ni categorias no se puede facturar
# hasta reconfigurarlo; (2) reiniciar los secuenciales del SRI solo es seguro en
# ambiente de PRUEBAS: en produccion el SRI rechazara las facturas por numero repetido.
# Ver la cabecera de server/scripts/wipePatientsSuppliersOnce.js.
#
# PARA DESACTIVARLA ANTES DE QUE CORRA: volver a comentar el if / echo / fi de abajo.
# Para ver que borraria sin borrar nada:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/wipePatientsSuppliersOnce.js'
#
if ! ( cd "$APP_DIR/server" && node scripts/wipePatientsSuppliersOnce.js --commit ); then
  echo "ADVERTENCIA: el arranque desde cero fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/wipePatientsSuppliersOnce.js --commit'"
fi
# ─────────────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────────────
# Vigente: dar de alta a los 113 pacientes de las FICHAS FÍSICAS escaneadas (ago-2026).
#
# Los PDF de /scanner se transcribieron a data/fichas-escaneadas.json (114 fichas; una
# es un escaneo repetido y se omite sola por cédula duplicada). Este paso crea el
# paciente, su ficha clínica con la fecha ESCRITA en el papel, y un seguimiento con el
# PDF adjunto para que el doctor vea el original.
#
# NO TOCA el escáner: el PDF se COPIA a storage/followups y el original sigue en
# storage/scans. NO dispara automatizaciones (crea con el modelo, no por el controlador),
# así que nadie recibe un mensaje de bienvenida por esto.
#
# `--once` pone la marca `importar-fichas-escaneadas-2026-08-16` en `onetimetasks`: entra
# UNA sola vez. Sin ella, borrar a mano un paciente importado haría que el siguiente
# despliegue lo resucitara.
#
# Los 65 con algún dato dudoso salen en Pacientes → "Fichas por revisar" (/patients/scan-review),
# con el PDF al lado para corregirlos. Ver docs/IMPORTAR_FICHAS_ESCANEADAS.md.
#
# Para ver qué haría sin crear nada:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json'
#
# La clave va EXPLICITA. El script trae por defecto la de la tanda EN CURSO (la de
# 6.000 fichas de agosto-31) y, sin fijarla aqui, este bloque —que ya esta hecho—
# marcaria esa clave como DONE y la tanda nueva no llegaria a entrar nunca.
CLAVE_FICHAS_AGO16='importar-fichas-escaneadas-2026-08-16'
if ! ( cd "$APP_DIR/server" && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json --key="$CLAVE_FICHAS_AGO16" --once --commit ); then
  echo "ADVERTENCIA: la importacion de fichas escaneadas fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json --key=$CLAVE_FICHAS_AGO16 --once --commit'"
fi
# ─────────────────────────────────────────────────────────────────────────────────────


# Vigente: reencolar las inscripciones que quedaron programadas para dispararse en pleno
# horario de silencio (ago-2026, al invertir el significado de las ventanas horarias).
if ! ( cd "$APP_DIR/server" && node scripts/rescheduleQuietWindowsOnce.js --commit ); then
  echo "ADVERTENCIA: el reencolado de ventanas fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/rescheduleQuietWindowsOnce.js --commit'"
fi

# VA ANTES DEL REINICIO a proposito: el codigo VIEJO entiende 'doctor' perfectamente,
# asi que adelantarla no tiene inconveniente. Al reves si lo tiene: entre el reinicio y
# la migracion habria una ventana con el backend NUEVO vivo y el rol viejo todavia en la
# base, y en esa ventana esas personas reciben 403 en todo.
# El rol 'ecografista' se retiro (sep-2026): quien lo tenga guardado queda con el
# documento INVALIDO por el enum de User y con 403 en toda ruta de doctor, o sea
# logueado y sin poder hacer nada. Esta migracion lo pasa a 'doctor' y arrastra las
# reglas de comision, que si no dejan de pagar en silencio. Es OBLIGATORIA en este push.
if ! ( cd "$APP_DIR/server" && node scripts/migrateEcografistaToDoctorOnce.js --commit ); then
  echo "ADVERTENCIA: la migracion de ecografista a doctor fallo. Esos usuarios NO PUEDEN TRABAJAR hasta reintentarla:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/migrateEcografistaToDoctorOnce.js --commit'"
fi

# VA ANTES DEL REINICIO a proposito. Desde sep-2026 un numero que no puede enviar
# (WhatsApp bloqueo "Recepcion 2") DESVIA la respuesta al numero principal, y la
# ventana de 24h se mide contra el numero al que el contacto escribio. Los chats
# antiguos no tienen ese dato anotado (`lastInboundAccount` nacio despues): con el
# backend nuevo vivo y el campo aun vacio, esos chats prometerian "ventana abierta"
# mientras Meta rechaza el texto con 131047. Rellenarlo antes cierra esa ventana.
if ! ( cd "$APP_DIR/server" && node scripts/backfillLastInboundAccountOnce.js --commit ); then
  echo "ADVERTENCIA: el relleno del numero de entrada de los chats fallo. Reintentalo a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/backfillLastInboundAccountOnce.js --commit'"
fi

echo "==> 5/6 Reiniciando el backend con PM2 (bajo el usuario 'clinica')"
# IMPORTANTE: el backend corre bajo el pm2 del usuario `clinica` (God Daemon en
# /home/clinica/.pm2), NO bajo el de root. GitHub Actions ejecuta este deploy
# como root, así que un `pm2 restart` a secas apuntaba al pm2 de ROOT (vacío) →
# fallaba con "clinica-api doesn't exist" y el backend NUNCA se reiniciaba (seguía
# corriendo código viejo hasta un reboot). Por eso apuntamos SIEMPRE al pm2 de
# clinica; si el deploy ya se corre como clinica (manual), se usa pm2 directo.
#
# `unset SECRETS_KEY`: con --update-env, pm2 reinyecta el entorno de esta shell al
# proceso. Vaciamos SECRETS_KEY para que NADIE la pise y sea SIEMPRE dotenv
# (server/.env) la única fuente de la clave. Sin esto, un entorno sin la clave
# (el de GitHub Actions) la borraba del proceso y los tokens de WhatsApp quedaban
# ILEGIBLES ("no se pudo descifrar el token") hasta el siguiente reinicio manual.
#
# --kill-timeout 15000: da 15 s para cerrar los Chromium de WhatsApp QR (destroy);
# sin la gracia, la sesión moría a mitad de escritura y quedaba corrupta.
PM2_CMD='unset SECRETS_KEY; pm2 restart clinica-api --update-env --kill-timeout 15000 && pm2 save'
if [ "$(id -un)" = "clinica" ]; then
  bash -lc "$PM2_CMD"
else
  sudo -iu clinica bash -lc "$PM2_CMD"
fi

echo "==> 6/6 Tareas de UNA SOLA VEZ que exigen el codigo NUEVO ya corriendo"
# Va DESPUES del reinicio a proposito: esta tarea borra un estado que el codigo VIEJO
# fabricaba solo. Si corriera antes (en el paso 4), el backend viejo, todavia vivo,
# podria volver a crear una ventana fantasma entre la limpieza y el reinicio, y la
# marca de "una sola vez" ya no la volveria a barrer.
#
# Vigente: borrar las ventanas de 24h FANTASMA de los chats nacidos de un envio nuestro
# (ago-2026). Sin esto, esos chats siguen diciendo "ventana abierta" y el texto libre que
# escriba el agente lo rechaza Meta con el error 131047: el paciente nunca lo recibe.
if ! ( cd "$APP_DIR/server" && node scripts/clearPhantomWhatsappWindowOnce.js --commit ); then
  echo "ADVERTENCIA: la limpieza de ventanas fantasma fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/clearPhantomWhatsappWindowOnce.js --commit'"
fi

# Catalogo de SERVICIOS DE AGENDA. Es idempotente (busca por slug antes de crear),
# asi que puede correr en cada despliegue sin duplicar nada: solo rellena los que
# falten. Sin esto, la primera vez el selector de servicio saldria vacio.
if ! ( cd "$APP_DIR/server" && node scripts/seedAppointmentServiceItems.js ); then
  echo "ADVERTENCIA: no se pudo sembrar el catalogo de servicios de agenda. Reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/seedAppointmentServiceItems.js'"
fi

# Turno vigente de las citas ya asignadas. La agenda del doctor y la bandeja de
# enfermeria pasaron a filtrar por currentTurnUser/currentTurnKind; las citas
# asignadas antes de ese cambio no los tienen y desaparecerian de ambas listas.
# Es idempotente (recalcula desde turns[]), asi que puede correr siempre.
if ! ( cd "$APP_DIR/server" && node scripts/backfillCurrentTurn.js --commit ); then
  echo "ADVERTENCIA: no se pudo rellenar el turno vigente de las citas. Reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/backfillCurrentTurn.js --commit'"
fi

# ─────────────────────────────────────────────────────────────────────────────────────
# Vigente: las FICHAS FISICAS escaneadas (sep-2026). DOS tandas, las dos EN SEGUNDO
# PLANO — juntas son ~6.100 PDF que hay que despiezar y reescalar con Chromium, o sea
# HORAS. Dejarlas en el camino del despliegue lo colgaria media tarde.
#
# Van al final y desatendidas a proposito: el backend YA se reinicio con el codigo
# nuevo (paso 5/6), asi que la clinica trabaja normal mientras esto avanza por detras.
# El `--once` guarda la marca en `onetimetasks`, asi que un segundo push no arranca una
# importacion en paralelo ni repite lo hecho.
#
# Corren como el usuario `clinica`: los adjuntos que crean (storage/followups y
# storage/observations) los tiene que poder leer y borrar el backend, que es suyo.
#
# QUE HACE con cada ficha (ver server/scripts/importPatientsFromScans.js):
#   · reconoce al paciente que YA existe (vino de Contifico): cedula -> nombre+celular
#     -> nombre+correo -> nombre;
#   · le COMPLETA lo que tiene vacio (la edad sobre todo) y, lo que difiere, lo guarda
#     como "el otro valor" SIN pisar el dato bueno;
#   · le cuelga la ficha de registro en su primer seguimiento y las hojas de
#     seguimiento en Observaciones;
#   · le vincula su chat del CRM, para que el call center agende sin registrar a nadie.
#
# Para mirar como va:   tail -f /home/clinica/import-fichas.log
# Para ver que haria sin escribir nada:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas-2026-08-31.json'
LOG_FICHAS=/home/clinica/import-fichas.log
# Antes de nada, el VIGILANTE: si la tanda anterior se quedo atascada —viva, latiendo
# y sin avanzar una ficha porque el kernel le mato el Chromium— la mata y deja la
# marca en FAILED. Sin esto la marca se queda RUNNING y FRESCA para siempre y ningun
# despliegue se atreve a relanzar encima: hacia falta entrar al servidor a mano.
# Mira 90 s antes de dictaminar; una tanda sana hace ~30 fichas/min.
if ! ( cd "$APP_DIR/server" && node scripts/desatascarImportacionFichas.js --commit ); then
  echo "ADVERTENCIA: el vigilante de la importacion fallo (se sigue igual)."
fi
# Primero las 113 de agosto, que quedaron con el PDF ENTERO en el seguimiento: se les
# cambia el adjunto por la primera pagina y se les crea la observacion que faltaba.
# Despues la tanda grande. En serie y en el mismo proceso de fondo: las dos abren un
# Chromium y compiten por la memoria del droplet si van a la vez.
CMD_FICHAS="cd $APP_DIR/server \
  && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json --key=convertir-fichas-escaneadas-2026-08-16-v2 --once --commit \
  ; node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas-2026-08-31.json --key=importar-fichas-escaneadas-2026-09-03 --once --commit"
if [ "$(id -un)" = "clinica" ]; then
  nohup bash -lc "$CMD_FICHAS" >> "$LOG_FICHAS" 2>&1 &
else
  sudo -iu clinica bash -lc "nohup bash -lc '$CMD_FICHAS' >> $LOG_FICHAS 2>&1 &"
fi
echo "==> Fichas escaneadas: importando en segundo plano. Sigue el avance con:"
echo "    tail -f $LOG_FICHAS"
# ─────────────────────────────────────────────────────────────────────────────────────

echo "==> Despliegue completado: $(date)"
