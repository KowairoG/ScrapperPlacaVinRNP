#!/usr/bin/env node
/**
 * CLI: node index.js GCH183 [otraPlaca ...] [--json] [--csv salida.csv] [--debug]
 */
const fs = require('fs');
const { RnpScraper } = require('./scraper');

(async () => {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const csvIdx = args.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null;
  const placas = args.filter((a, i) => !a.startsWith('--') && !(csvIdx >= 0 && i === csvIdx + 1));

  if (!placas.length) {
    console.error('uso: node index.js PLACA [PLACA...] [--json] [--csv out.csv] [--debug]');
    process.exit(1);
  }

  const scraper = new RnpScraper({ debugDir: flags.has('--debug') ? 'debug/consultas' : null });
  const resultados = [];

  try {
    await scraper.start();
    for (const placa of placas) {
      const r = await scraper.consultarPlaca(placa);
      resultados.push(r);
      if (!flags.has('--json')) {
        if (r.ok) {
          console.log(`${r.placa}  VIN/Chasis: ${r.vin}  (${r.fuente})  ${[r.marca, r.estilo, r.anio, r.color].filter(Boolean).join(' ')}`);
        } else {
          console.log(`${r.placa}  ERROR: ${r.error}`);
        }
      }
    }
  } catch (err) {
    console.error('FALLO:', err.message);
    process.exitCode = 1;
  } finally {
    await scraper.close();
  }

  if (flags.has('--json')) console.log(JSON.stringify(resultados, null, 2));

  if (csvPath) {
    const cols = ['placa', 'ok', 'vin', 'fuente', 'marca', 'estilo', 'anio', 'color', 'motor', 'estado', 'error'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...resultados.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    fs.writeFileSync(csvPath, '﻿' + csv, 'utf8');
    console.log(`CSV -> ${csvPath}`);
  }
})();
