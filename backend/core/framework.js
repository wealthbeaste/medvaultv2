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

  // Find and call the registered error-handler middleware (4-arg signature)
  _handleError(err, req, res) {
    const errMw = this.middlewares.find(mw => mw.length === 4);
    if (errMw) {
      try {
        errMw(err, req, res, () => {});
      } catch (e) {
        // Last-resort fallback if the error handler itself throws
        if (!res.writableEnded) {
          res.json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }, 500);
        }
      }
    } else {
      // No error handler registered — send a plain 500
      if (!res.writableEnded) {
        res.json({
          error: err.message || 'Internal Server Error',
          code: err.code  || 'INTERNAL_ERROR',
        }, err.status || 500);
      }
    }
  }

  // Build the HTTP server
  server() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost`);
      const pathname = url.pathname;

      // ── Enrich res object ──
      res._statusCode = 200;
      res.status = (code) => { res._statusCode = code; return res; };
      res.json = (data, status) => {
        // Use explicitly passed status, or the one set via res.status(), or 200
        const code = (typeof status === 'number') ? status : res._statusCode;
        res.writeHead(code, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        });
        res.end(JSON.stringify(data));
      };

      // ── CORS headers (always set for all responses) ──
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── Parse body ──
      req.body = await this._parseBody(req);

      // ── Parse query params ──
      req.query = Object.fromEntries(url.searchParams.entries());

      // ── Run global middleware (skip 4-arg error handlers here) ──
      for (const mw of this.middlewares) {
        if (mw.length === 4) continue; // error handlers are called only on error

        let nextCalled = false;
        let nextErr = null;

        try {
          await mw(req, res, (err) => {
            nextCalled = true;
            nextErr = err || null;
          });
        } catch (e) {
          this._handleError(e, req, res);
          return;
        }

        if (nextErr) {
          this._handleError(nextErr, req, res);
          return;
        }

        if (!nextCalled) return; // middleware ended the response
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
      const self = this;

      const next = async (err) => {
        // If an error was passed to next(), or a handler threw, route to error handler
        if (err) {
          self._handleError(err, req, res);
          return;
        }
        if (i < route.handlers.length) {
          const handler = route.handlers[i++];
          try {
            await handler(req, res, next);
          } catch (e) {
            self._handleError(e, req, res);
          }
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
