'use strict';

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class ContificoApi {
  constructor({ apiKey, baseUrl = 'https://api.contifico.com/sistema', fetchImpl = global.fetch, retries = 4, timeoutMs = 60000 }) {
    if (!apiKey) throw new Error('Falta CONTIFICO_API_KEY');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.metrics = { requests: 0, retries: 0, rows: 0 };
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

  async *pages(path, params = {}, pageSize = 100) {
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

  async listV1(path, params = {}) {
    const data = await this.get(path, params);
    const rows = Array.isArray(data) ? data : (data.results || []);
    this.metrics.rows += rows.length;
    return rows;
  }
}

module.exports = { ContificoApi };
