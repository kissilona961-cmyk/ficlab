// db.js – IndexedDB réteg a FicLaboratory-hoz
const DB = (() => {
  const NAME = "ficlaboratory-v2";
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) {
          const b = db.createObjectStore("books", { keyPath: "id", autoIncrement: true });
          b.createIndex("key", "key", { unique: true });
        }
        if (!db.objectStoreNames.contains("chapters")) {
          const c = db.createObjectStore("chapters", { keyPath: "id", autoIncrement: true });
          c.createIndex("bookId", "bookId", { unique: false });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  const wrap = (r) =>
    new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });

  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("A művelet megszakadt"));
      fn(t)
        .then((r) => { result = r; })
        .catch((e) => {
          try { t.abort(); } catch (_) {}
          reject(e);
        });
    });
  }

  // ---- Könyvek ----
  const getAllBooks = () =>
    run("books", "readonly", (t) => wrap(t.objectStore("books").getAll()));

  const getBook = (id) =>
    run("books", "readonly", (t) => wrap(t.objectStore("books").get(id)));

  const findBookByKey = (key) =>
    run("books", "readonly", (t) => wrap(t.objectStore("books").index("key").get(key)));

  const putBook = (book) =>
    run("books", "readwrite", (t) => wrap(t.objectStore("books").put(book)));

  // ---- Fejezetek ----
  async function getChapters(bookId) {
    const list = await run("chapters", "readonly", (t) =>
      wrap(t.objectStore("chapters").index("bookId").getAll(bookId))
    );
    return list.sort((a, b) => a.index - b.index);
  }

  const addChapters = (bookId, chapters) =>
    run("chapters", "readwrite", async (t) => {
      const store = t.objectStore("chapters");
      for (const c of chapters) {
        await wrap(store.put({ ...c, bookId }));
      }
      return chapters.length;
    });

  const countChapters = () =>
    run("chapters", "readonly", (t) => wrap(t.objectStore("chapters").count()));

  // ---- Törlés ----
  const deleteBook = (id) =>
    run(["books", "chapters"], "readwrite", async (t) => {
      const chapters = t.objectStore("chapters");
      const keys = await wrap(chapters.index("bookId").getAllKeys(id));
      for (const k of keys) await wrap(chapters.delete(k));
      await wrap(t.objectStore("books").delete(id));
    });

  const wipe = () =>
    run(["books", "chapters", "settings"], "readwrite", async (t) => {
      await wrap(t.objectStore("books").clear());
      await wrap(t.objectStore("chapters").clear());
      await wrap(t.objectStore("settings").clear());
    });

  // ---- Beállítások ----
  async function getSetting(key, fallback = "") {
    const row = await run("settings", "readonly", (t) =>
      wrap(t.objectStore("settings").get(key))
    );
    return row ? row.value : fallback;
  }

  const setSetting = (key, value) =>
    run("settings", "readwrite", (t) =>
      wrap(t.objectStore("settings").put({ key, value }))
    );

  return {
    open, getAllBooks, getBook, findBookByKey, putBook,
    getChapters, addChapters, countChapters,
    deleteBook, wipe, getSetting, setSetting,
  };
})();