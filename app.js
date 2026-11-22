"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const STATUS = { unread: "Olvasatlan", reading: "Olvasom", completed: "Befejezve", paused: "Félbehagyva" };
  const BAD = "script,style,link,meta,iframe,object,embed,form,input,button,audio,video,svg,nav,base";
  const GENERIC = /^\d+\. rész$/;
  let books = [];
  let toastTimer = 0;
  let reader = { book: null, chapters: [], pos: 0 };

  /* ---------- segédek ---------- */
  const norm = s => String(s == null ? "" : s).trim().toLowerCase();
  const hasStatus = s => Object.prototype.hasOwnProperty.call(STATUS, s);

  function safeUrl(u) {
    try {
      const x = new URL(String(u || "").trim());
      return /^https?:$/.test(x.protocol) ? x.href : "";
    } catch (e) { return ""; }
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  function say(id, msg, type) {
    const e = $(id);
    e.textContent = msg;
    e.dataset.type = type || "info";
  }

  function sortBooks() {
    books.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  }

  /* Fejezet-HTML tisztítása megjelenítés előtt (a mentésből érkező adat sem megbízható). */
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
    doc.body.querySelectorAll(BAD).forEach(n => n.remove());
    doc.body.querySelectorAll("*").forEach(el => {
      Array.from(el.attributes).forEach(a => {
        const n = a.name.toLowerCase();
        if (n.startsWith("on") || n === "style" || n === "srcset") el.removeAttribute(a.name);
      });
      if (el.tagName === "A") {
        const h = el.getAttribute("href") || "";
        if (/^(https?:|mailto:)/i.test(h)) {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        } else {
          el.removeAttribute("href");
        }
      }
      if (el.tagName === "IMG") {
        const s = el.getAttribute("src") || "";
        if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(s)) el.remove();
      }
    });
    return doc.body.innerHTML;
  }

  /* Könyv adatainak tisztítása (adatbázisból vagy mentésfájlból). */
  function cleanBook(r) {
    if (!r || typeof r !== "object") return null;
    const title = String(r.title == null ? "" : r.title).trim();
    if (!title) return null;
    const author = String(r.author || "").trim() || "Ismeretlen szerző";
    const ao3Id = /^\d+$/.test(String(r.ao3Id || "")) ? String(r.ao3Id) : "";
    const book = {
      title, author, ao3Id,
      key: Epub.makeKey(title, author, ao3Id),
      url: safeUrl(r.url),
      favorite: !!r.favorite,
      followed: !!r.followed,
      status: hasStatus(r.status) ? r.status : "unread",
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      added: typeof r.added === "string" ? r.added : new Date().toISOString(),
      lastChapter: Number.isInteger(r.lastChapter) ? r.lastChapter : 0,
      lastRead: typeof r.lastRead === "string" ? r.lastRead : "",
      chapterCount: Number.isInteger(r.chapterCount) ? r.chapterCount : 0
    };
    if (r.id != null) book.id = r.id;
    return book;
  }

  /* ---------- fejezetek összefűzése ----------
     Ami már megvan, azt nem írja felül; csak az újakat adja hozzá. */
  async function mergeChapters(bookId, incoming) {
    const existing = await DB.getChapters(bookId);
    const titles = new Set(existing.map(c => norm(c.title)));
    let next = existing.reduce((m, c) => Math.max(m, c.index), 0);
    const fresh = [];
    for (const c of incoming) {
      const generic = GENERIC.test(c.title);
      const isNew = generic ? c.index > existing.length : !titles.has(norm(c.title));
      if (!isNew) continue;
      next++;
      titles.add(norm(c.title));
      fresh.push({ index: next, title: generic ? next + ". rész" : c.title, html: c.html });
    }
    if (fresh.length) await DB.addChapters(bookId, fresh);
    return { added: fresh.length, total: existing.length + fresh.length };
  }

  /* ---------- adatműveletek ---------- */
  async function updateBook(book, patch) {
    try {
      await DB.putBook(Object.assign({}, book, patch));
      Object.assign(book, patch);
    } catch (err) {
      console.error(err);
      toast("Nem sikerült menteni: " + err.message);
    }
    renderAll();
  }

  async function deleteBook(book) {
    if (!confirm("Törlöd ezt a történetet: „" + book.title + "”?")) return;
    try {
      await DB.deleteBook(book.id);
      books = books.filter(b => b.id !== book.id);
      renderAll();
    } catch (err) {
      console.error(err);
      toast("Nem sikerült törölni: " + err.message);
    }
  }

  /* ---------- megjelenítés ---------- */
  function button(text, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn " + cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function badge(text) {
    const s = document.createElement("span");
    s.className = "badge";
    s.textContent = text;
    return s;
  }

  function card(book) {
    const el = document.createElement("article");
    el.className = "card book";

    const h = document.createElement("h3");
    h.textContent = book.title;
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = book.author;
    el.append(h, p);

    const badges = document.createElement("div");
    badges.className = "badges";
    if (book.chapterCount) badges.append(badge(book.chapterCount + " fejezet"));
    if (book.ao3Id) badges.append(badge("AO3"));
    if (book.followed) badges.append(badge("Követett"));
    if (badges.childNodes.length) el.append(badges);

    const link = safeUrl(book.url);
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Eredeti oldal megnyitása";
      el.append(a);
    }

    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Olvasási állapot");
    Object.keys(STATUS).forEach(k => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = STATUS[k];
      sel.append(o);
    });
    sel.value = hasStatus(book.status) ? book.status : "unread";
    sel.addEventListener("change", () => updateBook(book, { status: sel.value }));
    el.append(sel);

    const row = document.createElement("div");
    row.className = "actions";
    if (book.chapterCount) row.append(button("Olvasás", "", () => openReader(book)));
    row.append(
      button(book.favorite ? "♥ Kedvenc" : "♡ Kedvenc", "ghost",
        () => updateBook(book, { favorite: !book.favorite })),
      button(book.followed ? "Követem" : "Követés", "ghost",
        () => updateBook(book, { followed: !book.followed })),
      button("Törlés", "ghost danger", () => deleteBook(book))
    );
    el.append(row);
    return el;
  }

  function renderLibrary() {
    const q = norm($("search").value);
    const f = $("filter").value;
    const list = books.filter(b => {
      if (f === "favorite" && !b.favorite) return false;
      if (f === "followed" && !b.followed) return false;
      if (hasStatus(f) && b.status !== f) return false;
      return !q || norm(b.title + " " + b.author + " " + b.tags.join(" ")).includes(q);
    });
    const box = $("book-list");
    box.replaceChildren(...list.map(card));
    const empty = $("empty");
    empty.style.display = list.length ? "none" : "";
    empty.textContent = books.length
      ? "Nincs találat a megadott szűrésre."
      : "Még nincs könyv. A Hozzáadás fülön tölthetsz be EPUB-ot.";
  }

  async function renderStats() {
    $("stat-books").textContent = books.length;
    $("stat-favorites").textContent = books.filter(b => b.favorite).length;
    $("stat-followed").textContent = books.filter(b => b.followed).length;
    try { $("stat-chapters").textContent = await DB.countChapters(); }
    catch (e) { $("stat-chapters").textContent = "?"; }
  }

  function renderContinue() {
    const box = $("continue-box");
    const last = books
      .filter(b => b.lastRead && b.chapterCount)
      .sort((a, b) => b.lastRead.localeCompare(a.lastRead))[0];
    if (!last) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Még nem olvastál semmit.";
      box.replaceChildren(p);
      return;
    }
    const t = document.createElement("p");
    t.className = "muted";
    t.textContent = last.title + " – " + (last.lastChapter || 1) + ". fejezet";
    box.replaceChildren(t, button("Folytatás", "", () => openReader(last, last.lastChapter)));
  }

  function renderAll() {
    renderStats();
    renderLibrary();
    renderContinue();
  }
    /* ---------- navigáció ---------- */
  function showPage(name) {
    document.querySelectorAll(".page").forEach(p =>
      p.classList.toggle("active", p.id === "page-" + name));
    document.querySelectorAll(".tabs button").forEach(b => {
      const on = b.dataset.page === name;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
  }

  /* ---------- olvasó ---------- */
  function saveProgress() {
    const b = reader.book;
    if (!b) return;
    const patch = { lastChapter: reader.pos + 1, lastRead: new Date().toISOString() };
    DB.putBook(Object.assign({}, b, patch))
      .then(() => Object.assign(b, patch))
      .catch(err => console.warn("Haladás mentése:", err));
  }

  function showChapter(i) {
    const c = reader.chapters[i];
    if (!c) return;
    reader.pos = i;
    $("chapter-content").innerHTML = sanitizeHtml(c.html);
    $("chapter-select").value = String(i);
    $("chapter-prev").disabled = i === 0;
    $("chapter-next").disabled = i === reader.chapters.length - 1;
    $("reader").scrollTop = 0;
    saveProgress();
  }

  async function openReader(book, pos) {
    try {
      const chapters = await DB.getChapters(book.id);
      if (!chapters.length) { toast("Ehhez a könyvhöz nincs mentett fejezet."); return; }
      const start = Math.min(Math.max((pos || book.lastChapter || 1) - 1, 0), chapters.length - 1);
      reader = { book, chapters, pos: start };
      $("reader-title").textContent = book.title;
      $("chapter-select").replaceChildren(...chapters.map((c, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = c.title;
        return o;
      }));
      $("reader").hidden = false;
      document.body.style.overflow = "hidden";
      showChapter(start);
      if (book.status === "unread") updateBook(book, { status: "reading" });
    } catch (err) {
      console.error(err);
      toast("Nem sikerült megnyitni: " + err.message);
    }
  }

  function closeReader() {
    $("reader").hidden = true;
    document.body.style.overflow = "";
    reader = { book: null, chapters: [], pos: 0 };
    renderAll();
  }

  /* ---------- EPUB-import ---------- */
  async function importOne(file) {
    const data = await Epub.parse(file);
    let book = books.find(b => b.key === data.key)
      || (data.ao3Id ? books.find(b => b.key === Epub.makeKey(data.title, data.author, "")) : null);
    let created = false;

    if (!book) {
      book = cleanBook({ title: data.title, author: data.author, ao3Id: data.ao3Id, url: data.url });
      book.id = await DB.putBook(book);
      books.unshift(book);
      created = true;
    } else if (data.ao3Id && !book.ao3Id) {
      book.ao3Id = data.ao3Id;
      book.key = data.key;
      if (!book.url) book.url = data.url;
    }

    const r = await mergeChapters(book.id, data.chapters);
    book.chapterCount = r.total;
    await DB.putBook(book);
    return { title: book.title, created, added: r.added, total: r.total };
  }

  async function importEpubs(files) {
    const lines = [];
    let failed = false;
    say("import-status", "Feldolgozás...", "info");
    for (const file of files) {
      try {
        const r = await importOne(file);
        lines.push(r.created
          ? "„" + r.title + "” hozzáadva (" + r.total + " fejezet)."
          : r.added
            ? "„" + r.title + "”: " + r.added + " új fejezet."
            : "„" + r.title + "”: nincs új fejezet.");
      } catch (err) {
        console.error(err);
        failed = true;
        lines.push(file.name + ": " + err.message);
      }
    }
    sortBooks();
    renderAll();
    say("import-status", lines.join("\n"), failed ? "error" : "success");
    $("import-status").style.whiteSpace = "pre-line";
    $("epub-input").value = "";
  }

  /* ---------- kézi hozzáadás ---------- */
  async function addManual(e) {
    e.preventDefault();
    const rawUrl = $("manual-url").value.trim();
    if (rawUrl && !safeUrl(rawUrl)) {
      say("manual-status", "A webcím http:// vagy https:// kezdetű legyen.", "error");
      return;
    }
    const book = cleanBook({
      title: $("manual-title").value,
      author: $("manual-author").value,
      url: rawUrl
    });
    if (!book) { say("manual-status", "Add meg a történet címét.", "error"); return; }
    if (books.some(b => b.key === book.key)) {
      say("manual-status", "Ez a történet már szerepel a könyvtárban.", "error");
      return;
    }
    try {
      book.id = await DB.putBook(book);
      books.unshift(book);
      e.target.reset();
      say("manual-status", "„" + book.title + "” hozzáadva.", "success");
      renderAll();
    } catch (err) {
      console.error(err);
      say("manual-status", "Nem sikerült menteni: " + err.message, "error");
    }
  }

  /* ---------- mentés / visszatöltés ---------- */
  async function exportBackup() {
    try {
      const chapters = [];
      for (const b of books) {
        (await DB.getChapters(b.id)).forEach(c =>
          chapters.push({ bookId: b.id, index: c.index, title: c.title, html: c.html }));
      }
      const data = { app: "FicLaboratory", version: 2, exported: new Date().toISOString(), books, chapters };
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ficlaboratory-mentes-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      say("backup-status", books.length + " könyv és " + chapters.length + " fejezet elmentve.", "success");
    } catch (err) {
      console.error(err);
      say("backup-status", "A mentés nem sikerült: " + err.message, "error");
    }
  }

  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data && data.books;
      if (!Array.isArray(list)) throw new Error("Ismeretlen fájlformátum.");
      const byBook = new Map();
      (Array.isArray(data.chapters) ? data.chapters : []).forEach(c => {
        if (!c || typeof c !== "object") return;
        if (!byBook.has(c.bookId)) byBook.set(c.bookId, []);
        byBook.get(c.bookId).push(c);
      });

      let added = 0, skipped = 0, chaptersAdded = 0;
      for (const raw of list) {
        const b = cleanBook(raw);
        if (!b) { skipped++; continue; }
        const oldId = b.id;
        delete b.id;
        let book = books.find(x => x.key === b.key);
        if (!book) {
          b.id = await DB.putBook(b);
          books.push(b);
          book = b;
          added++;
        } else {
          skipped++;
        }
        const incoming = (byBook.get(oldId) || [])
          .sort((x, y) => (x.index || 0) - (y.index || 0))
          .map(c => ({ index: Number(c.index) || 0, title: String(c.title || ""), html: String(c.html || "") }));
        if (incoming.length) {
          const r = await mergeChapters(book.id, incoming);
          chaptersAdded += r.added;
          book.chapterCount = r.total;
          await DB.putBook(book);
        }
      }
      sortBooks();
      renderAll();
      say("backup-status",
        added + " könyv és " + chaptersAdded + " fejezet visszatöltve, " + skipped + " könyv kimaradt (már megvolt vagy érvénytelen).",
        "success");
    } catch (err) {
      console.error(err);
      say("backup-status", "A visszatöltés nem sikerült: " + err.message, "error");
    }
    $("import-file").value = "";
  }

  /* ---------- beállítások ---------- */
  async function loadSettings() {
    const url = await DB.getSetting("workerUrl", "");
    $("worker-url").value = url;
    if (url) {
      $("ao3-note").textContent =
        "A Worker címe el van mentve. A letöltő rész a következő lépésben jön, addig EPUB-ot tölts be.";
    }
  }

  async function saveWorker() {
    const raw = $("worker-url").value.trim();
    if (raw && !safeUrl(raw)) {
      say("settings-status", "A cím https:// kezdetű legyen.", "error");
      return;
    }
    try {
      await DB.setSetting("workerUrl", raw ? safeUrl(raw).replace(/\/+$/, "") : "");
      say("settings-status", raw ? "Worker címe elmentve." : "Worker címe törölve.", "success");
      loadSettings();
    } catch (err) {
      console.error(err);
      say("settings-status", "Nem sikerült menteni: " + err.message, "error");
    }
  }

  async function wipeAll() {
    if (!confirm("Biztosan törölsz MINDEN könyvet és fejezetet erről az eszközről? Ez nem visszavonható.")) return;
    try {
      await DB.wipe();
      books = [];
      renderAll();
      loadSettings();
      toast("Minden adat törölve.");
    } catch (err) {
      console.error(err);
      toast("Nem sikerült törölni: " + err.message);
    }
  }

  async function renderStorage() {
    let t = "";
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        t = "Felhasznált hely: " + ((e.usage || 0) / 1048576).toFixed(1) + " MB";
      }
      if (navigator.storage && navigator.storage.persisted) {
        const p = await navigator.storage.persisted();
        t += (t ? ". " : "") + (p
          ? "Tartós tárhely engedélyezve."
          : "A böngésző törölheti az adatokat, ha kevés a hely.");
      }
    } catch (e) { /* nem kritikus */ }
    $("storage-info").textContent = t || "A tárhelyadat nem érhető el.";
  }

  /* ---------- események ---------- */
  function bindEvents() {
    document.querySelectorAll(".tabs button").forEach(b =>
      b.addEventListener("click", () => showPage(b.dataset.page)));

    $("search").addEventListener("input", renderLibrary);
    $("filter").addEventListener("change", renderLibrary);

    $("epub-input").addEventListener("change", e => {
      const files = Array.from(e.target.files || []);
      if (files.length) importEpubs(files);
    });
    $("manual-form").addEventListener("submit", addManual);

    $("worker-save").addEventListener("click", saveWorker);
    $("export-btn").addEventListener("click", exportBackup);
    $("import-file").addEventListener("change", e => {
      const f = e.target.files && e.target.files[0];
      if (f) importBackup(f);
    });
    $("wipe-all").addEventListener("click", wipeAll);

    $("reader-back").addEventListener("click", closeReader);
    $("chapter-prev").addEventListener("click", () => showChapter(reader.pos - 1));
    $("chapter-next").addEventListener("click", () => showChapter(reader.pos + 1));
    $("chapter-select").addEventListener("change", e => showChapter(Number(e.target.value)));
  }
    /* ---------- indítás ---------- */
  async function init() {
    bindEvents();
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      await DB.open();
      books = (await DB.getAllBooks()).map(cleanBook).filter(Boolean);
      sortBooks();
      await loadSettings();
    } catch (err) {
      console.error(err);
      toast("Az adatbázis nem érhető el, a változtatások nem maradnak meg.");
    }
    renderAll();
    renderStorage();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker:", err));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();