// ============================================================
// MedVault Service Worker
// Caches the app so it loads even with NO internet
// Save this as: service-worker.js (in the same folder as your HTML)
// ============================================================

const CACHE_NAME = 'medvault-v1';
const CACHE_URLS = [
  '/medvault-connected.html',
  '/medvault-order.html',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap',
];

// ── INSTALL: cache all app files ─────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching app files');
      return cache.addAll(CACHE_URLS).catch(err => {
        console.log('[SW] Cache failed (some files may not exist yet):', err.message);
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean up old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => {
          console.log('[SW] Deleting old cache:', n);
          return caches.delete(n);
        })
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: serve from cache when offline ─────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: try network first, fall back to error response
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', offline: true }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // App files: try cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Return cached version immediately
        // Also fetch fresh version in background for next time
        fetch(event.request).then(fresh => {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, fresh));
        }).catch(() => {});
        return cached;
      }
      // Not in cache, try network
      return fetch(event.request).catch(() =>
        new Response('<h1>MedVault is offline</h1><p>Please reconnect to the internet.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      );
    })
  );
});

// ── BACKGROUND SYNC: sync queued data when back online ──────
self.addEventListener('sync', event => {
  if (event.tag === 'medvault-sync') {
    event.waitUntil(syncQueuedData());
  }
});

async function syncQueuedData() {
  console.log('[SW] Background sync triggered');
  // Notify all open windows to sync
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_NOW' }));
}

// ── PUSH NOTIFICATIONS (for WhatsApp-style alerts) ──────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'MedVault Alert', {
      body:  data.body  || '',
      icon:  '/icon-192.png',
      badge: '/icon-72.png',
      data:  { url: data.url || '/' },
      actions: [
        { action: 'view', title: 'View Dashboard' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'view') {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});

console.log('[SW] MedVault Service Worker loaded ✅');
