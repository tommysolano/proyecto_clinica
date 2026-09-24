'use strict';

const crypto = require('crypto');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Tamanos de pagina de las pasadas de recuperacion: cambiarlo mueve los bordes
// de pagina, que es justo donde Contifico pierde filas.
const RETRY_PAGE_SIZES = [97, 89, 71, 53];

/** Identidad estable de una fila, para no emitirla dos veces entre pasadas. */
function rowKey(row) {
  const id = row?.id;
  if (id !== undefined && id !== null && String(id) !== '') return `id:${id}`;
  return `hash:${crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex')}`;
}

class ContificoApi {
  constructor({ apiKey, baseUrl = 'https://api.contifico.com/sistema', fetchImpl = global.fetch, retries = 4, timeoutMs = 60000 }) {
    if (!apiKey) throw new Error('Falta CONTIFICO_API_KEY');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.metrics = { requests: 0, retries: 0, rows: 0, repagedWindows: 0 };
  }

  url(pathOrUrl, params = {}) {
    const url = new URL(/^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url;
  }

  async get(pathOrUrl, params = {}) {
    const url = this.url(pathOrUrl, params);
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.metrics.requests += 1;
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: this.apiKey, Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) return response.json();
        const body = await response.text().catch(() => '');
        const error = new Error(`Contifico GET ${url.pathname}: HTTP ${response.status}${body ? ` - ${body.slice(0, 200)}` : ''}`);
        error.status = response.status;
        if ((response.status !== 429 && response.status < 500) || attempt === this.retries) throw error;
        lastError = error;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (attempt === this.retries || (error.status && error.status !== 429 && error.status < 500)) throw error;
      }
      this.metrics.retries += 1;
      await wait(Math.min(1000 * 2 ** attempt, 10000));
    }
    throw lastError;
  }

  /** Una sola pasada de paginacion, tal cual la entrega Contifico. */
  async *rawPages(path, params = {}, pageSize = 100) {
    let next = path;
    let query = { ...params, page_size: pageSize };
    const seen = new Set();
    while (next) {
      const key = String(this.url(next, query));
      if (seen.has(key)) throw new Error(`Paginacion ciclica: ${path}`);
      seen.add(key);
      const data = await this.get(next, query);
      const rows = Array.isArray(data) ? data : (data.results || []);
      this.metrics.rows += rows.length;
      yield { rows, count: Number(data.count ?? rows.length), next: data.next || null };
      next = Array.isArray(data) ? null : data.next;
      query = {};
    }
  }

  /**
   * Recorre un endpoint paginado SIN perder filas.
   *
   * Contifico no garantiza un orden estable entre paginas: mientras se recorre,
   * las filas se desplazan, asi que una pasada repite filas en los bordes de
   * pagina y, por cada repetida, se salta otra distinta. Como el endpoint
   * informa el total real en `count`, la perdida es detectable: si las filas
   * unicas no llegan a `count` se repite la pasada con otro tamano de pagina
   * -- lo que mueve esos bordes -- y se emiten solo las filas nuevas.
   *
   * Sin esto la extraccion perdia en silencio ~1 de cada 1000 registros; y como
   * la proyeccion retira lo que falta en la instantanea, esas filas acababan
   * borradas del sistema pese a seguir vivas en Contifico.
   *
   * `stats` se rellena con {expected, unique, attempts, recovered, complete}
   * para que el llamador registre si la ventana quedo incompleta.
   */
  async *pages(path, params = {}, pageSize = 100, stats = {}) {
    const sizes = [pageSize, ...RETRY_PAGE_SIZES.filter((size) => size !== pageSize)];
    const emitted = new Set();
    Object.assign(stats, { expected: null, unique: 0, attempts: 0, recovered: 0, complete: false });
    for (const size of sizes) {
      stats.attempts += 1;
      const before = emitted.size;
      for await (const page of this.rawPages(path, params, size)) {
        stats.expected = page.count;
        const rows = page.rows.filter((row) => {
          const key = rowKey(row);
          if (emitted.has(key)) return false;
          emitted.add(key);
          return true;
        });
        if (rows.length) yield { rows, count: page.count, next: page.next };
      }
      stats.unique = emitted.size;
      if (stats.attempts > 1) stats.recovered += emitted.size - before;
      if (stats.expected === null || emitted.size >= stats.expected) { stats.complete = true; break; }
      // Una pasada que no aporta ninguna fila nueva ya no va a converger.
      if (stats.attempts > 1 && emitted.size === before) break;
      this.metrics.repagedWindows += 1;
    }
  }

  async listV1(path, params = {}, { singleObject = false } = {}) {
    const data = await this.get(path, params);
    // La mayor parte de endpoints v1 responde un arreglo, pero rrhh/rol-pago
    // devuelve UN objeto cuando el empleado sí tiene rol. No convertir ese
    // objeto en una fila por defecto: otros endpoints pueden responder objetos
    // de error. El llamador del endpoint singular debe pedirlo explícitamente.
    const rows = Array.isArray(data)
      ? data
      : (Array.isArray(data?.results)
        ? data.results
        : (singleObject && data && typeof data === 'object' && !data.error && !data.detail ? [data] : []));
    this.metrics.rows += rows.length;
    return rows;
  }
}

module.exports = { ContificoApi, rowKey, RETRY_PAGE_SIZES };
