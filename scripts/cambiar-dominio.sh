#!/usr/bin/env bash
# Cambia el panel de Marketing al dominio propio (panelmarketing.neboaiconsulting.com).
#
# Antes de correrlo, en Squarespace (DNS de neboaiconsulting.com):
#   Tipo CNAME · Host: panelmarketing · Apunta a: b4i15vma.up.railway.app
#
# Qué hace: comprueba el DNS y el certificado en Railway, y recién entonces cambia PANEL_URL
# en los servicios panel y worker (eso los vuelve a desplegar, ~2 min). Al arrancar, el panel
# reapunta solo el webhook de Zernio al dominio nuevo.
#
# Lo que NO hace (queda a mano, ver README):
#   - la URL de Marketing en los otros 3 paneles (cotizaciones, cobranzas, whatsapp);
#   - el nodo "Cobrar en Panel Marketing" del flujo de n8n "Camila Paralela - Costos".
set -euo pipefail

DOMINIO="${DOMINIO:-panelmarketing.neboaiconsulting.com}"
ESPERADO="${ESPERADO:-b4i15vma.up.railway.app}"
PROYECTO=a544fcc1-69a6-4b84-a58a-af3a30742eff
ENTORNO=6ca38ad7-ae82-432b-a5d9-f4316bc7a52c
PANEL=e1624b6a-ae17-4efe-9b7a-ef974b20c092
WORKER=ca09bd55-c0d2-4e24-89a5-c88a78aeb3b7
rw() { pnpm dlx @railway/cli "$@"; }

echo "1) DNS de $DOMINIO"
CNAME=$(dig +short "$DOMINIO" CNAME | sed 's/\.$//')
if [ "$CNAME" != "$ESPERADO" ]; then
  echo "   ✗ El CNAME todavía no apunta a $ESPERADO (ahora: '${CNAME:-vacío}')."
  echo "     Agrégalo en Squarespace y espera unos minutos. Los DNS pueden tardar hasta 24 h."
  exit 1
fi
echo "   ✓ CNAME correcto"

echo "2) Certificado en Railway"
ESTADO=$(rw ssl --json 2>/dev/null | grep -o 'CERTIFICATE_STATUS_TYPE_[A-Z_]*' | head -1 || true)
echo "   estado: ${ESTADO:-desconocido} (tiene que ser ISSUED; si dice VALIDATING, espera y vuelve a correr)"

echo "3) El dominio responde"
CODIGO=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMINIO/" || true)
[ "$CODIGO" = "200" ] || { echo "   ✗ https://$DOMINIO devolvió $CODIGO. Espera al certificado y reintenta."; exit 1; }
echo "   ✓ responde 200"

echo "4) PANEL_URL en panel y worker (esto los vuelve a desplegar)"
read -r -p "   ¿Seguimos? (s/n) " ok
[ "$ok" = "s" ] || { echo "   Cancelado."; exit 1; }
rw variables -p $PROYECTO -e $ENTORNO -s $PANEL --set "PANEL_URL=https://$DOMINIO"
rw variables -p $PROYECTO -e $ENTORNO -s $WORKER --set "PANEL_URL=https://$DOMINIO"

echo
echo "Listo. Falta a mano:"
echo " - n8n, flujo 'Camila Paralela - Costos', nodo 'Cobrar en Panel Marketing':"
echo "   URL -> https://$DOMINIO/api/n8n/costo-camila"
echo " - Los otros 3 paneles (enlace a Marketing): scripts/cambiar-dominio-paneles.sh"
echo " - Revisar en los logs del panel: '[zernio] webhook actualizado: https://$DOMINIO/api/zernio/webhook'"
