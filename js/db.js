// IndexedDB 離線佇列：斷網時盤點輸入先存這裡，恢復連線後自動補送。
// 每筆用手機端產生的 UUID 當主鍵，補送到 Supabase 時沿用同一個 id，天然防止重複計數。
const IDB_NAME = "stocktake-offline";
const IDB_VERSION = 1;
const STORE_ENTRIES = "pending_entries";
const STORE_ITEMS_CACHE = "items_cache";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        db.createObjectStore(STORE_ENTRIES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_ITEMS_CACHE)) {
        db.createObjectStore(STORE_ITEMS_CACHE, { keyPath: "sheetId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

const OfflineQueue = {
  async add(entry) {
    return withStore(STORE_ENTRIES, "readwrite", (store) => store.put(entry));
  },
  async remove(id) {
    return withStore(STORE_ENTRIES, "readwrite", (store) => store.delete(id));
  },
  async all() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ENTRIES, "readonly");
      const req = tx.objectStore(STORE_ENTRIES).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async countForItem(itemId) {
    const all = await this.all();
    return all.filter((e) => e.item_id === itemId).length;
  },
};
