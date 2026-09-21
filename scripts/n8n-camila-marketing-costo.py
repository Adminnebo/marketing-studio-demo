"""Flujo de n8n aparte que registra en Sword cada solicitud de Camila Marketing con su costo REAL por tokens.

Igual que "Log Outbound with cost WhatsApp" de la Camila de produccion: el flujo principal le pasa el
execution_id al terminar; aqui se espera a que esa ejecucion quede guardada, se leen los tokens de cada
modelo desde la API de n8n, se toman los precios y porcentajes del panel de Cotizaciones (/api/porcentaje,
agente 'camila', con sus franjas horarias) y se manda a Sword el costo cobrado.

Uso: python3 scripts/n8n-camila-marketing-costo.py > docs/n8n-camila-marketing-costo.json
"""
import json

N8N = "https://n8n.lmconsultingai.com"

CODIGO_COSTO = r"""// Costo real de la solicitud de Camila Marketing: tokens de cada modelo x precio vigente del panel.
// Misma logica que "Log Outbound with cost WhatsApp" (Camila de produccion).
const AGENT_SLUG = 'camila';
const MODEL_NODES = { 'DeepSeek V4 Chat Model': 'deepseek', 'Anthropic Chat Model': 'haiku' };
// Por si el panel no responde o no tiene el modelo cargado.
const FALLBACK = { deepseek: { in: 0.14, out: 0.28 }, haiku: { in: 1.00, out: 5.00 } };

const pedido = $('Webhook').first().json.body;
const ref = new Date(pedido.enviado || Date.now());
const mins = ref.getUTCHours() * 60 + ref.getUTCMinutes();
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const inWin = (w) => { const s = toMin(w.start), e = toMin(w.end); if (s === e) return false; return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e); };
const effPrice = (m) => {
  for (const w of (m.priceWindows || [])) if (inWin(w)) return { in: Number(w.priceIn) || 0, out: Number(w.priceOut) || 0 };
  return { in: Number(m.priceIn) || 0, out: Number(m.priceOut) || 0 };
};

const agents = $('Porcentajes').first().json.agents || [];
const agent = agents.find((a) => a.slug === AGENT_SLUG) || { models: [] };
const priceBySlug = {};
const percentBySlug = {};
for (const m of agent.models) { priceBySlug[m.slug] = effPrice(m); percentBySlug[m.slug] = Number(m.percent); }

function firstUsage(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.tokenUsageEstimate) return o.tokenUsageEstimate;
  if (o.tokenUsage) return o.tokenUsage;
  for (const k of Object.keys(o)) { const u = firstUsage(o[k]); if (u) return u; }
  return null;
}

const exec = $('Leer Ejecucion').first().json;
const runData = exec?.data?.resultData?.runData || {};
const perModel = {};
let lastModel = null, lastTime = -1, costUsd = 0, anyUsage = false;

for (const [nodeName, key] of Object.entries(MODEL_NODES)) {
  const runs = runData[nodeName];
  if (!Array.isArray(runs)) continue;
  let p = 0, c = 0, n = 0;
  for (const run of runs) {
    const u = firstUsage(run);
    if (!u) continue;
    p += Number(u.promptTokens ?? u.prompt_tokens ?? 0);
    c += Number(u.completionTokens ?? u.completion_tokens ?? 0);
    n++; anyUsage = true;
    const t = run.startTime || 0;
    if (t >= lastTime) { lastTime = t; lastModel = key; } // el que respondio al final
  }
  if (n > 0) {
    const pr = priceBySlug[key] || FALLBACK[key] || { in: 0, out: 0 };
    const cost = (p / 1e6) * pr.in + (c / 1e6) * pr.out;
    perModel[key] = { promptTokens: p, completionTokens: c, calls: n, priceIn: pr.in, priceOut: pr.out, costUsd: Math.round(cost * 1e6) / 1e6 };
    costUsd += cost;
  }
}

// Lo cobrado, con la misma regla que la Camila de produccion (Edit Fields1):
// deepseek -> costo x porcentaje/100 ; haiku -> costo x (1 + porcentaje/100).
let cobrado = 0;
if (anyUsage && lastModel) {
  const pct = percentBySlug[lastModel];
  const mult = Number.isFinite(pct) ? (lastModel === 'deepseek' ? pct / 100 : 1 + pct / 100) : 1;
  cobrado = +(costUsd * mult).toFixed(2);
}

return [{ json: {
  model: lastModel,
  costUsd: anyUsage ? Math.round(costUsd * 1e6) / 1e6 : null,
  cobrado,
  estado: exec?.status || null,
  priceRefUtc: ref.toISOString(),
  perModel,
} }];"""

nodes = [
    {
        # Responde al toque: el flujo principal no espera nada de este.
        "parameters": {"httpMethod": "POST", "path": "camila-marketing-costo", "responseMode": "onReceived", "options": {}},
        "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [0, 0],
        "id": "a1c7e3f0-5b2d-4e8a-9f16-3d0b7c4e2a91", "name": "Webhook", "webhookId": "a1c7e3f0-5b2d-4e8a-9f16-3d0b7c4e2a91",
    },
    {
        # La ejecucion principal termina justo despues de pedir esto: se espera a que quede guardada.
        "parameters": {"amount": 8},
        "type": "n8n-nodes-base.wait", "typeVersion": 1.1, "position": [220, 0],
        "id": "b2d8f4a1-6c3e-4f9b-8a27-4e1c8d5f3b02", "name": "Esperar", "webhookId": "b2d8f4a1-6c3e-4f9b-8a27-4e1c8d5f3b02",
    },
    {
        "parameters": {
            "url": "=" + N8N + "/api/v1/executions/{{ $('Webhook').first().json.body.execution_id }}",
            "sendQuery": True, "queryParameters": {"parameters": [{"name": "includeData", "value": "true"}]},
            "sendHeaders": True, "headerParameters": {"parameters": [{"name": "X-N8N-API-KEY", "value": "<PONER-API-KEY-DE-ESTE-N8N>"}]},
            "options": {},
        },
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [440, 0],
        "id": "c3e9a5b2-7d4f-4a0c-9b38-5f2d9e6a4c13", "name": "Leer Ejecucion",
        "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 5000,
    },
    {
        "parameters": {"url": "https://panelcotizaciones.neboaiconsulting.com/api/porcentaje", "options": {}},
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [660, 0],
        "id": "d4f0b6c3-8e5a-4b1d-8c49-6a3e0f7b5d24", "name": "Porcentajes",
        "alwaysOutputData": True, "onError": "continueRegularOutput",
    },
    {
        "parameters": {"jsCode": CODIGO_COSTO},
        "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [880, 0],
        "id": "e5a1c7d4-9f6b-4c2e-9d5a-7b4f1a8c6e35", "name": "Calcular Costo",
    },
    {
        "parameters": {
            "method": "POST", "url": "https://app.swordaisolutions.com/api/messages/log",
            "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Content-Type", "value": "application/json"}]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({\n  clientId: 16,\n  apiKey: \"d1c383c4-60b3-4250-abc3-c5a04043b7cd\",\n  input: $('Webhook').first().json.body.mensaje || '[mensaje sin texto]',\n  output: $('Webhook').first().json.body.output,\n  agentName: \"Camila Marketing\",\n  agentId: \"marketing-camila-request\",\n  sessionId: $('Webhook').first().json.body.contact_id,\n  contactId: $('Webhook').first().json.body.contact_id,\n  contactName: $('Webhook').first().json.body.usuario_panel,\n  cost: $json.cobrado\n}) }}",
            "options": {"response": {"response": {"neverError": True}}},
        },
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.4, "position": [1100, 0],
        "id": "f6b2d8e5-0a7c-4d3f-8e6b-8c5a2b9d7f46", "name": "LOG Sword",
    },
]

a = lambda n: {"node": n, "type": "main", "index": 0}
connections = {
    "Webhook": {"main": [[a("Esperar")]]},
    "Esperar": {"main": [[a("Leer Ejecucion")]]},
    "Leer Ejecucion": {"main": [[a("Porcentajes")]]},
    "Porcentajes": {"main": [[a("Calcular Costo")]]},
    "Calcular Costo": {"main": [[a("LOG Sword")]]},
}
print(json.dumps({"nodes": nodes, "connections": connections, "pinData": {}, "meta": {"templateCredsSetupCompleted": True}}, ensure_ascii=False, indent=2))
