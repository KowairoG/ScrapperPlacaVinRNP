/**
 * API HTTP del scraper RNP — para consumo desde otros sistemas (tailnet/LAN).
 *
 *   GET  /health                       estado (sin api key)
 *   GET  /api/vin/:placa               consulta una placa (cache primero)
 *   GET  /api/vin/:placa?refresh=1     fuerza consulta nueva
 *   GET  /api/vin/:placa?clase=TAX     clases no-particulares (código del select del RNP)
 *   POST /api/vin  {"placas":[...]}    lote, máx 10 por request
 *   POST /admin/shutdown               cierra navegador y termina el proceso
 *
 * Si API_KEY está definida, todo (menos /health) exige header  x-api-key.
 *
 * Una sola instancia de Chrome, una sola sesión RNP: las consultas se
 * serializan en cola y el throttle de scraper.js respeta el límite del portal
 * (10 consultas / 2 min). El cache evita repetir consultas: placa->VIN no
 * cambia, así que un hit de cache no gasta cupo.
 */
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { RnpScraper } = require('./scraper');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const IDLE_CLOSE_MIN = Number(process.env.IDLE_CLOSE_MIN || 15);
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache', 'vin-cache.json');
const MAX_LOTE = 10;

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* cache nuevo */ }
const saveCache = () => {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
};

let scraper = null;
let arrancando = null;
let cola = Promise.resolve();
let pendientes = 0;
let consultasOk = 0;
let errores = 0;
let idleTimer = null;

async function getScraper() {
  if (scraper) return scraper;
  if (!arrancando) {
    arrancando = new RnpScraper()
      .start()
      .then((s) => { scraper = s; arrancando = null; return s; })
      .catch((e) => { arrancando = null; throw e; });
  }
  return arrancando;
}

// Chrome pesa ~300 MB: se cierra tras IDLE_CLOSE_MIN sin consultas.
// La siguiente consulta re-loguea sola (~15 s extra).
function programarCierre() {
  if (idleTimer) clearTimeout(idleTimer);
  if (IDLE_CLOSE_MIN <= 0) return;
  idleTimer = setTimeout(async () => {
    const s = scraper;
    scraper = null;
    await s?.close().catch(() => {});
  }, IDLE_CLOSE_MIN * 60000);
}

function enColar(job) {
  pendientes++;
  const p = cola.then(job, job).finally(() => pendientes--);
  cola = p.then(() => {}, () => {});
  return p;
}

// Errores de negocio: reintentar no ayuda. Lo demás (timeout, sesión caída,
// WAF) se reintenta una vez con navegador nuevo.
const NO_REINTENTAR = /Sin datos|no se encontr|no existe|sin chasis\/VIN/i;

async function consultar(placaRaw, { refresh = false, clase } = {}) {
  const placa = String(placaRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!placa || placa.length > 8) return { placa: placaRaw, ok: false, error: 'Placa inválida' };
  const key = clase && clase.trim() ? `${clase.trim().toUpperCase()}:${placa}` : placa;

  if (!refresh && cache[key]?.ok) return { ...cache[key], cache: true };

  return enColar(async () => {
    if (!refresh && cache[key]?.ok) return { ...cache[key], cache: true };

    let s = await getScraper();
    let r = await s.consultarPlaca(placa, { clase: clase ?? ' ' });
    if (!r.ok && !NO_REINTENTAR.test(r.error || '')) {
      await s.close().catch(() => {});
      scraper = null;
      s = await getScraper();
      r = await s.consultarPlaca(placa, { clase: clase ?? ' ' });
    }
    programarCierre();

    if (r.ok) {
      consultasOk++;
      cache[key] = { ...r, fecha: new Date().toISOString() };
      saveCache();
    } else {
      errores++;
    }
    return { ...r, cache: false };
  });
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!API_KEY || req.path === '/health') return next();
  if (req.get('x-api-key') === API_KEY) return next();
  res.status(401).json({ ok: false, error: 'x-api-key inválida o ausente' });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    navegadorAbierto: !!scraper,
    pendientes,
    consultasOk,
    errores,
    cache: Object.keys(cache).length,
    uptimeSeg: Math.round(process.uptime()),
  });
});

app.get('/api/vin/:placa', async (req, res) => {
  try {
    const r = await consultar(req.params.placa, {
      refresh: req.query.refresh === '1',
      clase: typeof req.query.clase === 'string' ? req.query.clase : undefined,
    });
    res.status(r.ok ? 200 : /inválida/i.test(r.error || '') ? 400 : 404).json(r);
  } catch (e) {
    errores++;
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/vin', async (req, res) => {
  const placas = req.body?.placas;
  if (!Array.isArray(placas) || !placas.length) {
    return res.status(400).json({ ok: false, error: 'Body esperado: {"placas": ["GCH183", ...]}' });
  }
  if (placas.length > MAX_LOTE) {
    return res.status(400).json({ ok: false, error: `Máximo ${MAX_LOTE} placas por lote (límite del portal RNP)` });
  }
  const resultados = [];
  for (const p of placas) {
    try {
      resultados.push(await consultar(p, { refresh: req.query.refresh === '1' }));
    } catch (e) {
      errores++;
      resultados.push({ placa: p, ok: false, error: e.message });
    }
  }
  res.json(resultados);
});

app.post('/admin/shutdown', async (_req, res) => {
  res.json({ ok: true, msg: 'cerrando' });
  await scraper?.close().catch(() => {});
  process.exit(0);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScrapperPlaca API escuchando en 0.0.0.0:${PORT}  (api key: ${API_KEY ? 'sí' : 'NO'})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await scraper?.close().catch(() => {});
    process.exit(0);
  });
}
