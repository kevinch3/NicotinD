/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const DB_NAME = 'nicotind-preserve';
const DB_VERSION = 1;
const BLOBS_STORE = 'blobs';
const TRACKS_STORE = 'tracks';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getFromStore<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function updateLastAccessed(db: IDBDatabase, id: string): void {
  const tx = db.transaction(TRACKS_STORE, 'readwrite');
  const store = tx.objectStore(TRACKS_STORE);
  const req = store.get(id);
  req.onsuccess = () => {
    const meta = req.result;
    if (meta) {
      meta.lastAccessedAt = Date.now();
      store.put(meta);
    }
  };
}

// Extract track ID from /api/stream/{id}?token=...
function extractTrackId(url: string): string | null {
  const match = new URL(url).pathname.match(/^\/api\/stream\/(.+)$/);
  return match ? match[1] : null;
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const trackId = extractTrackId(event.request.url);
  if (!trackId) return; // Not a stream request — passthrough

  event.respondWith(
    (async () => {
      try {
        const db = await openDB();
        const blob = await getFromStore<{ id: string; audio: Blob }>(db, BLOBS_STORE, trackId);

        if (blob?.audio) {
          // Serve from cache — update last accessed timestamp
          updateLastAccessed(db, trackId);
          db.close();

          const meta = await getFromStore<{ format?: string }>(
            await openDB(),
            TRACKS_STORE,
            trackId,
          );
          const contentType = meta?.format ?? 'audio/mpeg';

          return new Response(blob.audio, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(blob.audio.size),
            },
          });
        }

        db.close();
      } catch {
        // IndexedDB error — fall through to network
      }

      return fetch(event.request);
    })(),
  );
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
