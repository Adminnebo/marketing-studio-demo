#!/usr/bin/env bash
# Cambia el enlace a Marketing en los otros 3 paneles. Correr DESPUÉS de cambiar-dominio.sh,
# cuando el dominio propio ya responda. Deja los cambios commiteados pero SIN subir:
# revisa cada repo y haz el push tú (cada push despliega ese panel).
set -euo pipefail
VIEJA="https://panel-production-f46d.up.railway.app"
NUEVA="${NUEVA:-https://panelmarketing.neboaiconsulting.com}"
BASE="$HOME/Documentos/Nebo Projects"
for repo in Cotizacionesdashboard cobranzasdashboard whatsapp-dashboard; do
  d="$BASE/$repo"
  [ -d "$d" ] || { echo "no está $repo, sáltalo"; continue; }
  archivos=$(grep -rl "$VIEJA" "$d" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git || true)
  [ -n "$archivos" ] || { echo "$repo: no hay nada que cambiar"; continue; }
  echo "$repo: $archivos"
  echo "$archivos" | xargs sed -i "s|$VIEJA|$NUEVA|g"
  git -C "$d" add -A && git -C "$d" commit -q -m "Marketing: enlace al dominio propio"
  echo "  commiteado (sin subir). Para desplegarlo: git -C \"$d\" push"
done
