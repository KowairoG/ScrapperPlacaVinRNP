/**
 * Scraper RNP Digital — placa -> VIN / # de Chasis
 *
 * El sitio corre sobre F5 ASM: Chrome real (channel: 'chrome') es obligatorio,
 * el chromium headless-shell de Playwright recibe "Request Rejected".
 *
 * Límite del portal: 10 consultas gratuitas cada 2 minutos. Excederlo bloquea
 * la cuenta, por eso RnpScraper serializa y espera MIN_MS entre consultas.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL_LOGIN = 'https://www.rnpdigital.com/shopping/login.jspx';
const URL_FORM = 'https://www.rnpdigital.com/shopping/consultaDocumentos/paramConsultaVehiculo.jspx';

const MIN_MS = 13000; // 10 consultas / 2 min => 12s; margen de seguridad
const NO_DATA = /^(NO INDICADO|NO APLICA|DESCONOCIDO)?$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RnpScraper {
  constructor(opts = {}) {
    this.email = opts.email || process.env.RNP_EMAIL;
    this.password = opts.password || process.env.RNP_PASSWORD;
    this.headless = opts.headless ?? process.env.HEADLESS !== 'false';
    this.debugDir = opts.debugDir || null;
    this.lastQuery = 0;
  }

  async start() {
    if (!this.email || !this.password) throw new Error('Faltan RNP_EMAIL / RNP_PASSWORD');
    const args = ['--disable-blink-features=AutomationControlled'];
    // Dentro de Docker: Chrome corre sin sandbox y sin /dev/shm grande
    if (process.env.NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-dev-shm-usage');
    this.browser = await chromium.launch({
      channel: 'chrome',
      headless: this.headless,
      args,
    });
    this.ctx = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 900 },
      locale: 'es-CR',
      timezoneId: 'America/Costa_Rica',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'es-CR,es;q=0.9,en;q=0.8' },
    });
    await this.ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    this.page = await this.ctx.newPage();
    await this.login();
    return this;
  }

  async login() {
    const page = this.page;
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.fill('input[id$=":correo"]', this.email);
    await page.fill('input[id$=":pass"]', this.password);
    await page.click('input[value="Ingresar"]');
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    // Otra sesión abierta con las mismas credenciales
    const seguir = page.locator('input[value="Sí, continuar"]:visible');
    if (await seguir.count()) {
      await seguir.first().click();
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    }
    // Modal de selección de modo
    const aceptar = page.locator('input[value="Aceptar"]:visible');
    if (await aceptar.count()) {
      await aceptar.first().click();
      await page.waitForTimeout(2000);
    }

    const html = await page.content();
    if (/Request Rejected/i.test(html)) throw new Error('WAF rechazó la petición (F5 ASM)');
    if (await page.locator('input[id$=":pass"]:visible').count()) {
      throw new Error('Login falló: la página sigue pidiendo credenciales');
    }
    this.loggedIn = true;
  }

  /** Espera lo necesario para no pasar el límite de 10 consultas / 2 min. */
  async throttle() {
    const wait = MIN_MS - (Date.now() - this.lastQuery);
    if (this.lastQuery && wait > 0) await sleep(wait);
    this.lastQuery = Date.now();
  }

  /**
   * @param {string} placa  ej. "GCH183" o "123456"
   * @param {object} opts   { clase: código de select#class, ' ' = PARTICULAR }
   * @returns {Promise<{placa,ok,vin,chasis,fuente,marca,estilo,anio,color,motor,estado,error}>}
   */
  async consultarPlaca(placa, opts = {}) {
    if (!this.loggedIn) throw new Error('Llamá a start() primero');
    const num = String(placa).trim().toUpperCase();
    const clase = opts.clase ?? ' ';
    const page = this.page;

    await this.throttle();
    try {
      await page.goto(URL_FORM, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForSelector('#carNumber', { timeout: 30000 });

      await page.selectOption('select[name$=":j_id268"]', 'PLA').catch(() => {});
      await page.selectOption('#class', clase).catch(() => {});
      await page.waitForTimeout(1200); // el select dispara un postback A4J
      await page.fill('#carNumber', num);
      await page.click('a:has(img[alt="Consultar"])');
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1500);

      if (this.debugDir) {
        fs.mkdirSync(this.debugDir, { recursive: true });
        fs.writeFileSync(path.join(this.debugDir, `${num}.html`), await page.content());
      }

      return await this.parseResultado(num);
    } catch (err) {
      return { placa: num, ok: false, error: err.message };
    }
  }

  async parseResultado(placa) {
    const page = this.page;

    // Pares label -> valor. La tabla del vehículo marca las etiquetas con
    // span.label; la del motor usa td planos terminados en ':'. Se recorren
    // todas las celdas en orden de documento y gana la primera aparición.
    const campos = await page.$$eval('td', (celdas) => {
      const out = {};
      for (const td of celdas) {
        const txt = (td.innerText || '').replace(/\s+/g, ' ').trim();
        if (!txt.endsWith(':') || txt.length > 90) continue;
        const key = txt.replace(/:$/, '').trim();
        const val = (td.nextElementSibling?.innerText || '').replace(/\s+/g, ' ').trim();
        if (key && !(key in out)) out[key] = val;
      }
      return out;
    });

    const texto = await page.innerText('body');

    if (!Object.keys(campos).length) {
      const msg = (texto.match(/no (se encontr|existe)[^\n.]{0,120}/i) || [])[0];
      return { placa, ok: false, error: msg || 'Sin datos: el vehículo no aparece o cambió el formulario' };
    }

    const pick = (...keys) => {
      for (const k of keys) {
        const hit = Object.keys(campos).find((c) => c.toLowerCase() === k.toLowerCase());
        if (hit && campos[hit] && !NO_DATA.test(campos[hit])) return campos[hit];
      }
      return null;
    };

    const chasis = pick('# de Chasis');
    const vinCampo = pick('# de VIN');
    const serie = pick('# de Serie');
    const vin = vinCampo || chasis || serie;

    return {
      placa,
      ok: !!vin,
      vin,
      chasis,
      vinCampo,
      serie,
      fuente: vinCampo ? '# de VIN' : chasis ? '# de Chasis' : serie ? '# de Serie' : null,
      marca: pick('Marca'),
      estilo: pick('Estilo'),
      anio: pick('Año Fabricación'),
      color: pick('Color'),
      motor: pick('N.Motor'),
      categoria: pick('Categoría'),
      estado: pick('Estado Actual'),
      error: vin ? null : 'Vehículo encontrado pero sin chasis/VIN registrado',
    };
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }
}

module.exports = { RnpScraper };
