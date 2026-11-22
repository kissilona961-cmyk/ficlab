"use strict";
/* EPUB beolvasása: cím, szerző, fejezetek, AO3-azonosító. */
const Epub = (() => {
  const BAD = "script,style,link,meta,iframe,object,embed,form,input,button,audio,video,svg,nav";
  const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

  const norm = s => String(s == null ? "" : s).trim().toLowerCase();
  const decodeSafe = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const dirname = p => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

  function resolve(base, href) {
    const clean = decodeSafe(String(href).split("#")[0].split("?")[0]);
    const out = [];
    for (const part of (base + clean).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Hibás XML az EPUB-ban.");
    return doc;
  }

  const tagText = (doc, name) => {
    const n = doc.getElementsByTagNameNS("*", name)[0];
    return n ? n.textContent.trim() : "";
  };

  async function readText(zip, path) {
    const f = zip.file(path) || zip.file(decodeSafe(path));
    return f ? f.async("string") : null;
  }

  /* Az oldal tartalmát egy HTML-dokumentumba tesszük át, onnan már biztonságos a használata. */
  function bodyToHolder(raw) {
    let doc = new DOMParser().parseFromString(raw, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length) {
      doc = new DOMParser().parseFromString(raw, "text/html");
    }
    const body = doc.getElementsByTagNameNS("*", "body")[0];
    const tmp = document.implementation.createHTMLDocument("");
    const holder = tmp.createElement("div");
    if (body) {
      Array.from(body.childNodes).forEach(n => holder.appendChild(tmp.importNode(n, true)));
    }
    return holder;
  }

  function sanitize(holder) {
    holder.querySelectorAll(BAD).forEach(n => n.remove());
    holder.querySelectorAll("*").forEach(el => {
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
    });
  }

  async function inlineImages(holder, zip, docPath) {
    const base = dirname(docPath);
    for (const img of Array.from(holder.querySelectorAll("img"))) {
      const src = img.getAttribute("src") || "";
      if (/^data:image\//i.test(src)) continue;
      const path = src && !/^[a-z][a-z0-9+.-]*:/i.test(src) ? resolve(base, src) : "";
      const file = path && (zip.file(path) || zip.file(decodeSafe(path)));
      const mime = MIME[path.split(".").pop().toLowerCase()];
      if (!file || !mime) { img.remove(); continue; }
      img.setAttribute("src", "data:" + mime + ";base64," + (await file.async("base64")));
      img.removeAttribute("width");
      img.removeAttribute("height");
    }
  }

  function makeKey(title, author, ao3Id) {
    return ao3Id ? "ao3:" + ao3Id : "t:" + norm(title) + "|" + norm(author);
  }
    async function parse(file) {
    if (typeof JSZip === "undefined") {
      throw new Error("A JSZip nem töltődött be. Az első indításhoz kell az internet.");
    }
    const zip = await JSZip.loadAsync(file);

    const containerXml = await readText(zip, "META-INF/container.xml");
    if (!containerXml) throw new Error("Ez nem tűnik érvényes EPUB-nak.");
    const rootEl = parseXml(containerXml).getElementsByTagNameNS("*", "rootfile")[0];
    const opfPath = rootEl && rootEl.getAttribute("full-path");
    if (!opfPath) throw new Error("Az EPUB tartalomjegyzéke hiányzik.");

    const opfText = await readText(zip, opfPath);
    if (!opfText) throw new Error("Az EPUB tartalomjegyzéke nem olvasható.");
    const opf = parseXml(opfText);
    const base = dirname(opfPath);

    const title = tagText(opf, "title") || "Cím nélkül";
    const authors = Array.from(opf.getElementsByTagNameNS("*", "creator"))
      .map(n => n.textContent.trim()).filter(Boolean);
    const author = authors.join(", ") || "Ismeretlen szerző";
    const language = tagText(opf, "language");

    const manifest = {};
    Array.from(opf.getElementsByTagNameNS("*", "item")).forEach(it => {
      manifest[it.getAttribute("id")] = {
        href: it.getAttribute("href") || "",
        type: it.getAttribute("media-type") || "",
        props: it.getAttribute("properties") || ""
      };
    });

    const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"))
      .map(r => manifest[r.getAttribute("idref")])
      .filter(m => m && /(xhtml|html)/i.test(m.type) && !/\bnav\b/.test(m.props));

    if (!spine.length) throw new Error("Az EPUB-ban nem találtam olvasnivalót.");

    let ao3Id = (opfText.match(/archiveofourown\.org\/works\/(\d+)/i) || [])[1] || "";
    const chapters = [];

    for (const item of spine) {
      const path = resolve(base, item.href);
      const raw = await readText(zip, path);
      if (!raw) continue;

      if (!ao3Id && chapters.length < 3) {
        ao3Id = (raw.match(/archiveofourown\.org\/works\/(\d+)/i) || [])[1] || "";
      }

      const holder = bodyToHolder(raw);
      sanitize(holder);
      await inlineImages(holder, zip, path);

      const text = holder.textContent.trim();
      if (!text && !holder.querySelector("img")) continue;

      const heading = holder.querySelector("h1,h2,h3");
      const n = chapters.length + 1;
      chapters.push({
        index: n,
        title: (heading ? heading.textContent.trim().replace(/\s+/g, " ").slice(0, 120) : "") || n + ". rész",
        html: holder.innerHTML
      });
    }

    if (!chapters.length) throw new Error("Az EPUB üres, nem találtam benne szöveget.");

    return {
      title, author, language, ao3Id,
      url: ao3Id ? "https://archiveofourown.org/works/" + ao3Id : "",
      key: makeKey(title, author, ao3Id),
      chapters
    };
  }

  return { parse, makeKey };
})();
/* HTML-import (AO3 "HTML" letöltés): az Epub.parse kiegészítése */
(function () {
  const baseParse = Epub.parse;
  const BAD = "script,style,link,meta,iframe,object,embed,form,input,button,audio,video,svg,nav,base";
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();

  function toBody(markup) {
    const doc = new DOMParser().parseFromString("<body>" + markup + "</body>", "text/html");
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
      if (el.tagName === "IMG") el.remove();
    });
    return doc.body;
  }

  async function parseHtml(file) {
    const raw = await file.text();
    const doc = new DOMParser().parseFromString(raw, "text/html");

    const h1 = doc.querySelector("#preface h1, .meta h1, h1");
    const title = clean(h1 ? h1.textContent : "")
      || clean((doc.title || "").split(" - ")[0])
      || clean(file.name.replace(/\.html?$/i, ""))
      || "Cím nélkül";

    let author = Array.from(doc.querySelectorAll(".byline a"))
      .map(a => clean(a.textContent)).filter(Boolean).join(", ");
    if (!author) {
      const by = doc.querySelector(".byline");
      if (by) author = clean(by.textContent.replace(/^\s*by\s+/i, ""));
    }
    author = author || "Ismeretlen szerző";

    const ao3Id = (raw.match(/archiveofourown\.org\/works\/(\d+)/i) || [])[1] || "";
    const chapters = [];

    const push = (t, markup) => {
      const body = toBody(markup);
      if (!body.textContent.trim()) return;
      const n = chapters.length + 1;
      chapters.push({ index: n, title: clean(t).slice(0, 120) || n + ". rész", html: body.innerHTML });
    };

    const pre = doc.getElementById("preface");
    if (pre) push("Leírás", pre.innerHTML);

    const root = doc.getElementById("chapters");
    const src = root ? root.innerHTML : doc.body.innerHTML;
    const re = /<h2\b[^>]*class="[^"]*\b(?:heading|toc-heading)\b[^"]*"[^>]*>/gi;
    const marks = [];
    let m;
    while ((m = re.exec(src))) marks.push(m.index);

    if (!marks.length) {
      push("1. rész", src);
    } else {
      marks.forEach((start, i) => {
        const piece = src.slice(start, i + 1 < marks.length ? marks[i + 1] : src.length);
        const h2 = toBody(piece).querySelector("h2");
        push(h2 ? h2.textContent : "", piece);
      });
    }

    if (!chapters.length) throw new Error("A fájlban nem találtam szöveget.");

    return {
      title, author, language: "", ao3Id,
      url: ao3Id ? "https://archiveofourown.org/works/" + ao3Id : "",
      key: Epub.makeKey(title, author, ao3Id),
      chapters
    };
  }

  Epub.parse = async function (file) {
    if (/\.html?$/i.test(file.name || "") || /html/i.test(file.type || "")) return parseHtml(file);
    return baseParse(file);
  };
})();