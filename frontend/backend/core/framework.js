// ============================================================
// MedVault Mini Framework
// Built purely on Node.js built-ins — no npm needed
// Handles: routing, JSON parsing, CORS, middleware
// ============================================================

const http = require('http');
const { URL } = require('url');

class App {
  constructor() {
    this.routes = [];       // { method, pattern, handlers[] }
    this.middlewares = [];  // global middleware
  }

  // Register global middleware
  use(fn) { this.middlewares.push(fn); }

  // Register routes
  get(path, ...handlers)    { this._add('GET',    path, handlers); }
  post(path, ...handlers)   { this._add('POST',   path, handlers); }
  put(path, ...handlers)    { this._add('PUT',    path, handlers); }
  patch(path, ...handlers)  { this._add('PATCH',  path, handlers); }
  delete(path, ...handlers) { this._add('DELETE', path, handlers); }

  _add(method, path, handlers) {
    // Convert /api/drugs/:id → regex that captures params
    const keys = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '(?:\\?.*)?$'
    );
    this.routes.push({ method, pattern, keys, handlers });
  }

  // Mount a sub-router at a prefix
  mount(prefix, router) {
    router.routes.forEach(r => {
      const keys = [];
      const fullPath = prefix + r.rawPath;
      const pattern = new RegExp(
        '^' + fullPath.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '(?:\\?.*)?$'
      );
      this.routes.push({ method: r.method, pattern, keys, handlers: r.handlers });
    });
  }

  // Parse request body as JSON
  _parseBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch { resolve({}); }
      });
    });
  }

  // Build the HTTP server
  server() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost`);
      const pathname = url.pathname;

      // ── Enrich res object ──
      res.json = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      res.status = (code) => { res._statusCode = code; return res; };

      // ── CORS headers ──
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── Parse body ──
      req.body = await this._parseBody(req);

      // ── Parse query params ──
      req.query = Object.fromEntries(url.searchParams.entries());

      // ── Run global middleware ──
      for (const mw of this.middlewares) {
        let next = false;
        await mw(req, res, () => { next = true; });
        if (!next) return;
      }

      // ── Match route ──
      const route = this.routes.find(r =>
        r.method === req.method && r.pattern.test(pathname)
      );

      if (!route) {
        res.json({ error: 'Route not found: ' + pathname }, 404);
        return;
      }

      // Extract URL params like :id
      const match = pathname.match(route.pattern);
      req.params = {};
      route.keys.forEach((k, i) => { req.params[k] = match[i + 1]; });

      // ── Run route handlers in sequence ──
      let i = 0;
      const next = async () => {
        if (i < route.handlers.length) {
          await route.handlers[i++](req, res, next);
        }
      };
      await next();
    });
  }
}

// Mini Router (same API as App but collects routes for mounting)
class Router {
  constructor() { this.routes = []; }
  use() {}  // noop for sub-routers
  get(path, ...h)    { this._add('GET',    path, h); }
  post(path, ...h)   { this._add('POST',   path, h); }
  put(path, ...h)    { this._add('PUT',    path, h); }
  patch(path, ...h)  { this._add('PATCH',  path, h); }
  delete(path, ...h) { this._add('DELETE', path, h); }
  _add(method, path, handlers) {
    this.rawPath = path; // needed for mount prefix
    this.routes.push({ method, rawPath: path, handlers });
  }
}

module.exports = { App, Router };
