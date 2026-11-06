/** One keyed IndexedDB object store per cache database (warmupCache.ts,
 * buildCache.ts). Storage is optional: privacy settings, quotas and damaged
 * entries must never prevent a normal start, so failures read as a miss and
 * writes fail silently. Each store keeps at most two entries. */

function open(db: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(db, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`${db} blocked`));
  });
}

export async function readKeyed<T>(dbName: string, store: string, key: string): Promise<T | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await open(dbName, store);
    return await new Promise((resolve, reject) => {
      const tx = db!.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(key);
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch { return null; }
  finally { db?.close(); }
}

export async function writeKeyed(dbName: string, store: string, key: string, value: unknown): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await open(dbName, store);
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(store, 'readwrite');
      const objects = tx.objectStore(store);
      const keys = objects.getAllKeys();
      keys.onsuccess = () => {
        const old = keys.result.filter(k => k !== key);
        for (const k of old.slice(0, Math.max(0, old.length - 1))) objects.delete(k);
        objects.put(value, key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch { /* Continue without persistent storage. */ }
  finally { db?.close(); }
}

/** SHA-256 of a JSON value with object keys sorted, as hex. */
export async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
