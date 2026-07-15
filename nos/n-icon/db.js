const DB_NAME = "n-icons";
const STORE_NAME = "icons";
const VERSION = 1;

let openPromise;

function openDB() {
  if (openPromise) {
    return openPromise;
  }

  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
  });

  return openPromise;
}

export async function get(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(name);

    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.svg : undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function set(name, svg) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put({ name, svg });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
