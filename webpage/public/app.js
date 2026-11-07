/* Brain — SPA (vanilla JS, hash router) */
"use strict";

// ---------- data ----------
let MANIFEST = [];
let GRAPH = { nodes: [], edges: [], maxDeg: 1 };
const bySlug = new Map();
const nodeBySlug = new Map();

// Categories map to the wiki/ subfolders. Unknown folders fall back to a generated
// label + neutral colour at render time, so adding a folder to your vault needs no
// change here — it appears automatically with the folder name as its label.
const CATS = {
  "concepts":         { label: "Concepts", ico: "🧩", color: "#89b4fa" },
  "coding-interview": { label: "Coding Interview", ico: "💻", color: "#fab387" },
  "articles":         { label: "Articles", ico: "📄", color: "#94e2d5" },
  "people":           { label: "People", ico: "👤", color: "#a6e3a1" },
  "projects":         { label: "Projects", ico: "📁", color: "#f38ba8" },
  "questions":        { label: "Questions", ico: "❓", color: "#cba6f7" },
  "syntheses":        { label: "Syntheses", ico: "🧭", color: "#f9e2af" },
};
// Display order; any extra folders are appended after these, alphabetically.
const CAT_ORDER = ["concepts", "coding-interview", "articles", "syntheses", "people", "projects", "questions"];

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

// ---------- state ----------
const state = {
  query: "",
  tagFilter: null,
  catFilter: null,
  collapsed: JSON.parse(localStorage.getItem("brain-collapsed") || "{}"),
  recent: JSON.parse(localStorage.getItem("brain-recent") || "[]"),
  graph: { isolates: true, cat: null, highlight: null },
};

// ---------- theme ----------
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("brain-theme", t);
  const dark = $("#hljs-dark"), light = $("#hljs-light");
  if (dark && light) {
    dark.disabled = t === "light";
    light.disabled = t !== "light";
  }
}

// ---------- boot ----------
async function boot() {
  setTheme(localStorage.getItem("brain-theme") || "dark");
  const [m, g, d] = await Promise.all([
    fetch("manifest.json").then((r) => r.json()),
    fetch("graph.json").then((r) => r.json()),
    fetch("cards.json?v=" + Date.now()).then((r) => (r.ok ? r.json() : { cards: [] })).catch(() => ({ cards: [] })),
  ]);
  MANIFEST = m;
  GRAPH = g;
  DECK = d || { cards: [] };
  NOTE_KEYS = new Set();
  for (const n of MANIFEST) { if (n.slug) NOTE_KEYS.add(n.slug); if (n.title) NOTE_KEYS.add(n.title); }
  revLoad();
  revBuildQueue();
  for (const n of MANIFEST) bySlug.set(n.slug, n);
  for (const nd of GRAPH.nodes) nodeBySlug.set(nd.id, nd);
  const edges = GRAPH.edges.length;
  const lastSync = new Date().toISOString().slice(0, 10);
  $("#status").textContent = `${MANIFEST.length} notes · ${edges} links · ${Object.keys(CATS).filter((c) => MANIFEST.some((m) => m.category === c)).length} categories`;
  window.addEventListener("hashchange", route);
  bindGlobal();
  route();
}

// ---------- router ----------
let fg3d = null; // active 3d-force-graph instance (galaxy)
function route() {
  closeOverlays();
  if (fg3d) { try { fg3d.pauseAnimation(true); } catch (e) {} fg3d = null; }
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/note\/(.+)$/);
  if (m) renderNote(decodeURIComponent(m[1]));
  else if (hash.startsWith("#/galaxy")) renderGalaxy();
  else if (hash.startsWith("#/review")) renderReview();
  else if (hash.startsWith("#/graph")) renderGraph();
  else renderHome();
  window.scrollTo(0, 0);
}

function tabActive(name) {
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
}

// ---------- HOME ----------
function matchesSearch(n, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  const t = n.title.toLowerCase();
  if (t.startsWith(s)) return 3;
  if (t.includes(s)) return 2;
  if ((n.tags || []).some((x) => x.toLowerCase().includes(s))) return 1;
  if ((n.description || "").toLowerCase().includes(s)) return 1;
  return 0;
}

function visibleNotes() {
  return MANIFEST.filter((n) => {
    if (state.catFilter && n.category !== state.catFilter) return false;
    if (state.tagFilter && !(n.tags || []).includes(state.tagFilter)) return false;
    return matchesSearch(n, state.query) > 0;
  });
}

function renderHome() {
  tabActive("home");
  document.title = "Brain";
  const view = $("#view");
  view.innerHTML = "";
  const wrap = el("div", "view");

  const visible = visibleNotes();
  const hubs = [...GRAPH.nodes].sort((a, b) => b.deg - a.deg).slice(0, 3);
  const totalWords = MANIFEST.reduce((a, b) => a + (b.words || 0), 0);

  const head = el("div", "home-head");
  head.innerHTML = `<div><h1>Your second brain</h1><div class="sub">${MANIFEST.length} notes, ${totalWords.toLocaleString()} words, all linked</div></div>`;
  wrap.appendChild(head);

  const stats = el("div", "stats-strip");
  stats.innerHTML = `
    <div class="stat"><span class="num">${MANIFEST.length}</span><span class="lbl">notes</span></div>
    <div class="stat"><span class="num">${GRAPH.edges.length}</span><span class="lbl">links</span></div>
    <div class="stat"><span class="num">${hubs[0] ? hubs[0].deg : 0}</span><span class="hub">hub: ${hubs[0] ? esc(hubs[0].title) : "—"}</span></div>
    <div class="stat"><span class="num">${new Date().toLocaleDateString("en-SG", { day: "numeric", month: "short" })}</span><span class="lbl">today</span></div>`;
  wrap.appendChild(stats);

  // filter chips
  const row = el("div", "filter-row");
  const allChip = el("button", "chip" + (state.catFilter ? "" : " active"), `All notes<span class="count">${MANIFEST.length}</span>`);
  allChip.onclick = () => { state.catFilter = null; state.tagFilter = null; renderHome(); };
  row.appendChild(allChip);
  for (const c of CAT_ORDER) {
    const count = MANIFEST.filter((n) => n.category === c).length;
    if (!count) continue;
    const chip = el("button", "chip" + (state.catFilter === c ? " active" : ""), `${CATS[c].ico} ${CATS[c].label}<span class="count">${count}</span>`);
    chip.onclick = () => {
      state.catFilter = state.catFilter === c ? null : c;
      state.tagFilter = null;
      renderHome();
    };
    row.appendChild(chip);
  }
  if (state.tagFilter) {
    const t = el("button", "chip active", `🏷 ${esc(state.tagFilter)} ×`);
    t.onclick = () => { state.tagFilter = null; renderHome(); };
    row.appendChild(t);
  }
  wrap.appendChild(row);

  // category sections
  const q = state.query.toLowerCase();
  for (const c of CAT_ORDER) {
    const notes = visible
      .filter((n) => n.category === c)
      .sort((a, b) => (matchesSearch(b, state.query) - matchesSearch(a, state.query)) || a.title.localeCompare(b.title));
    if (!notes.length) continue;
    const sec = el("section", "cat-section" + (state.collapsed[c] ? " collapsed" : ""));
    sec.style.setProperty("--cat-color", CATS[c].color);
    const h = el("div", "cat-head");
    h.innerHTML = `<span class="ico">${CATS[c].ico}</span><h2>${CATS[c].label}</h2><span class="count">${notes.length}</span><span class="caret">▾</span>`;
    h.onclick = () => {
      state.collapsed[c] = !state.collapsed[c];
      localStorage.setItem("brain-collapsed", JSON.stringify(state.collapsed));
      sec.classList.toggle("collapsed");
    };
    sec.appendChild(h);
    const cards = el("div", "cards");
    for (const n of notes) cards.appendChild(noteCard(n, q));
    sec.appendChild(cards);
    wrap.appendChild(sec);
  }
  if (!visible.length) {
    wrap.appendChild(el("div", "no-results", `No notes match <b>${esc(state.query)}</b>${state.tagFilter ? " with tag " + esc(state.tagFilter) : ""}`));
  }
  view.appendChild(wrap);
  observeReveals();
}

function noteCard(n, q) {
  const c = el("div", "card reveal");
  c.style.setProperty("--cat-color", (CATS[n.category] || {}).color || "var(--accent)");
  const hl = (s) => {
    if (!q) return esc(s);
    const i = s.toLowerCase().indexOf(q);
    if (i < 0) return esc(s);
    return esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + q.length)) + "</mark>" + esc(s.slice(i + q.length));
  };
  const date = n.updated ? `<span class="date">${new Date(n.updated).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}</span>` : "";
  c.innerHTML = `
    <div class="title">${hl(n.title)}</div>
    ${n.description ? `<div class="desc">${esc(n.description)}</div>` : ""}
    <div class="meta">${(n.tags || []).slice(0, 3).map((t) => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join("")}${date}</div>`;
  c.onclick = () => (location.hash = `#/note/${enc(n.slug)}`);
  c.querySelectorAll(".tag").forEach((t) => {
    t.onclick = (e) => {
      e.stopPropagation();
      state.tagFilter = t.dataset.tag;
      state.catFilter = null;
      renderHome();
    };
  });
  return c;
}

function observeReveals() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    },
    { threshold: 0.05 }
  );
  document.querySelectorAll(".reveal").forEach((e, i) => {
    e.style.transitionDelay = `${Math.min((i % 12) * 28, 240)}ms`;
    io.observe(e);
  });
  // safety: never leave content permanently invisible
  setTimeout(() => document.querySelectorAll(".reveal:not(.in)").forEach((e) => e.classList.add("in")), 2500);
}

// ---------- NOTE ----------
let currentSlug = null;
let tocLinks = [];

async function renderNote(slug) {
  tabActive("home");
  const n = bySlug.get(slug);
  const view = $("#view");
  if (!n) {
    view.innerHTML = `<div class="view notfound"><div class="big">🕳</div><h2>note not found</h2><p>No note with slug <b>${esc(slug)}</b>. The link may be dangling.</p><p><a href="#/">← back to all notes</a></p></div>`;
    document.title = "not found — Brain";
    return;
  }
  currentSlug = slug;
  document.title = `${n.title} — Brain`;
  pushRecent(slug);

  // fetch body
  let html;
  try {
    const r = await fetch(`notes/${enc(slug)}.html`);
    if (!r.ok) throw new Error(r.status);
    html = await r.text();
  } catch {
    view.innerHTML = `<div class="view notfound"><div class="big">📵</div><h2>could not load note</h2><p>Try again — the sync may be mid-build.</p></div>`;
    return;
  }

  const wrap = el("div", "view");
  const grid = el("div", "note-wrap");
  const main = el("div", "note-main");

  const cat = CATS[n.category] || { label: n.category, ico: "📄" };
  const head = el("div", "note-head");
  head.innerHTML = `
    <div class="note-crumb"><a href="#/">${cat.ico} ${esc(cat.label)}</a> <span>›</span> ${esc(n.title)}</div>
    <h1 class="note-title">${esc(n.title)}</h1>
    <div class="note-meta">
      <span>📖 ${n.readMin} min read</span>
      <span>· ${n.words.toLocaleString()} words</span>
      ${n.updated ? `<span>· updated ${new Date(n.updated).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}</span>` : ""}
      ${(n.tags || []).map((t) => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join("")}
    </div>
    <div class="note-share-row">
      <button class="share-btn share-icon" id="shareBtn" title="Share this note" aria-label="Share this note">🔗</button>
      <span class="share-hint" id="shareHint" hidden></span>
    </div>`;
  main.appendChild(head);

  const shareBtn = head.querySelector("#shareBtn");
  const shareHint = head.querySelector("#shareHint");
  shareBtn.onclick = async () => {
    if (shareBtn.disabled) return;
    shareBtn.disabled = true;
    shareHint.hidden = false;
    shareHint.textContent = "creating link…";
    try {
      const r = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: enc(slug) + ".html", label: n.title }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 120));
      const { url } = await r.json();
      showShareModal(url, n.title);
      shareHint.textContent = "";
    } catch (e) {
      shareHint.textContent = "share failed: " + e.message;
    }
    shareBtn.disabled = false;
  };

  const content = el("article", "note-content");
  content.innerHTML = html;
  main.appendChild(content);

  // tags → filter
  head.querySelectorAll(".tag").forEach((t) => {
    t.onclick = () => {
      state.tagFilter = t.dataset.tag;
      state.catFilter = null;
      location.hash = "#/";
    };
  });

  // prev / next within category (alphabetical)
  const siblings = MANIFEST.filter((x) => x.category === n.category).sort((a, b) => a.title.localeCompare(b.title));
  const idx = siblings.findIndex((x) => x.slug === slug);
  const prev = siblings[idx - 1], next = siblings[idx + 1];
  if (prev || next) {
    const nav = el("div", "note-nav");
    if (prev) nav.innerHTML += `<a href="#/note/${enc(prev.slug)}"><span class="dir">← prev</span><span class="t">${esc(prev.title)}</span></a>`;
    if (next) nav.innerHTML += `<a class="next" href="#/note/${enc(next.slug)}"><span class="dir">next →</span><span class="t">${esc(next.title)}</span></a>`;
    main.appendChild(nav);
  }

  grid.appendChild(main);

  // TOC
  const toc = el("aside", "toc");
  const heads = content.querySelectorAll("h2, h3");
  if (heads.length >= 2) {
    toc.innerHTML = `<h4>On this page</h4>`;
    tocLinks = [];
    heads.forEach((h) => {
      if (!h.id) return;
      const a = el("a", h.tagName === "H3" ? "h3" : "h2", esc(h.textContent));
      a.href = "#" + h.id;
      a.onclick = (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      toc.appendChild(a);
      tocLinks.push({ a, h });
    });
    grid.appendChild(toc);
  }

  view.innerHTML = "";
  wrap.appendChild(grid);
  view.appendChild(wrap);
  bindNoteContent(content);
  observeReveals();
  scrollSpy();
}

function bindNoteContent(content) {
  // copy buttons
  content.querySelectorAll(".code-copy").forEach((btn) => {
    btn.onclick = () => {
      const code = btn.closest(".codeblock").querySelector("code").innerText;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "copied ✓";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("copied"); }, 1600);
      });
    };
  });
}

function scrollSpy() {
  if (!tocLinks.length) return;
  const onScroll = () => {
    let active = null;
    for (const t of tocLinks) {
      if (t.h.getBoundingClientRect().top < 120) active = t;
    }
    tocLinks.forEach((t) => t.a.classList.toggle("active", t === active));
  };
  window.removeEventListener("scroll", scrollSpy._h);
  scrollSpy._h = onScroll;
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// ---------- share modal ----------
function showShareModal(url, title) {
  const m = el("div", "share-modal");
  m.innerHTML = `
    <div class="share-modal-card">
      <div class="share-modal-logo">🔗</div>
      <h3>Share link ready</h3>
      <p class="share-modal-sub"><b>${esc(title)}</b> — anyone with this link can view it (read-only). You can't revoke it from here — ask hj to.</p>
      <div class="share-url-row">
        <input class="share-url" value="${esc(url)}">
        <button class="share-copy">Copy</button>
      </div>
      <div class="share-manual" id="shareManual" hidden>If the button didn't work: tap the link above, long-press, and copy.</div>
      <button class="share-done">Done</button>
    </div>`;
  document.body.appendChild(m);
  const urlInput = m.querySelector(".share-url");
  const copyBtn = m.querySelector(".share-copy");
  const manual = m.querySelector("#shareManual");
  const doCopy = async (silent) => {
    urlInput.focus();
    urlInput.select();
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        ok = true;
      } else {
        ok = document.execCommand("copy");
      }
    } catch {}
    if (!ok) { // never block the UI — show an inline hint instead
      manual.hidden = false;
      return;
    }
    copyBtn.textContent = "Copied ✓";
    copyBtn.classList.add("ok");
    if (!silent) setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("ok"); }, 1600);
  };
  copyBtn.onclick = () => doCopy(false);
  m.querySelector(".share-done").onclick = () => m.remove();
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  doCopy(true); // auto-copy on open
}

function pushRecent(slug) {
  state.recent = [slug, ...state.recent.filter((s) => s !== slug)].slice(0, 8);
  localStorage.setItem("brain-recent", JSON.stringify(state.recent));
}

// ---------- GRAPH ----------
let cy = null;

function renderGraph() {
  tabActive("graph");
  document.title = "Graph — Brain";
  const view = $("#view");
  view.innerHTML = `
    <div class="view graph-view">
      <div class="graph-toolbar">
        <button class="chip active" data-gcat="" >All</button>
        ${CAT_ORDER.filter((c) => GRAPH.nodes.some((n) => n.cat === c)).map((c) => `<button class="chip" data-gcat="${c}">${CATS[c].ico} ${CATS[c].label}</button>`).join("")}
        <button class="chip" id="iso-toggle">hide isolates ✓</button>
        <div class="graph-legend">${CAT_ORDER.filter((c) => GRAPH.nodes.some((n) => n.cat === c)).map((c) => `<span class="li"><span class="dot" style="background:${CATS[c].color}"></span>${CATS[c].label}</span>`).join("")}</div>
      </div>
      <div id="cy"></div>
    </div>
    <div class="graph-panel" id="gpanel"></div>`;

  document.querySelectorAll("[data-gcat]").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("[data-gcat]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.graph.cat = b.dataset.gcat || null;
      applyGraphFilter();
    };
  });
  const isoBtn = $("#iso-toggle");
  isoBtn.onclick = () => {
    state.graph.isolates = !state.graph.isolates;
    isoBtn.textContent = state.graph.isolates ? "hide isolates ✓" : "show isolates ✗";
    isoBtn.classList.toggle("active", state.graph.isolates);
    applyGraphFilter();
  };
  isoBtn.classList.add("active");

  buildCytoscape();
}

function buildCytoscape() {
  const elCy = $("#cy");
  if (!elCy) return;
  if (window.cytoscapeCoseBilkent) cytoscape.use(window.cytoscapeCoseBilkent);
  const maxDeg = GRAPH.maxDeg || 1;
  const nodes = GRAPH.nodes.map((n) => ({
    data: {
      id: n.id,
      label: n.title,
      cat: n.cat,
      deg: n.deg,
      size: Math.min(12 + n.deg * 3.2, 52),
      color: (CATS[n.cat] || {}).color || "#89b4fa",
    },
  }));
  const edges = GRAPH.edges.map(([a, b], i) => ({ data: { id: "e" + i, source: a, target: b } }));

  cy = cytoscape({
    container: elCy,
    elements: { nodes, edges },
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          "width": "data(size)",
          "height": "data(size)",
          label: "data(label)",
          color: "#cdd6f4",
          "font-size": "10px",
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": "6px",
          "text-wrap": "ellipsis",
          "text-max-width": "110px",
          opacity: 0.92,
          "border-width": 1.5,
          "border-color": "#11111b",
        },
      },
      { selector: "edge", style: { width: 1, "line-color": "#45475a", opacity: 0.35, "curve-style": "bezier" } },
      { selector: ":selected", style: { "border-width": 3, "border-color": "#89b4fa" } },
      { selector: ".faded", style: { opacity: 0.12 } },
      { selector: ".hl-node", style: { opacity: 1, "border-width": 3, "border-color": "#89b4fa" } },
      { selector: ".hl-edge", style: { opacity: 0.9, "line-color": "#89b4fa", width: 1.6 } },
    ],
    layout: { name: "cose-bilkent", animate: false, padding: 40 },
  });

  cy.on("zoom", () => updateLabels());
  updateLabels();

  cy.on("mouseover", "node", (e) => {
    const n = e.target;
    const nb = n.neighborhood();
    n.union(nb).addClass("hl-node");
    n.connectedEdges().addClass("hl-edge");
    cy.elements().not(n).not(nb).removeClass("hl-node").addClass("faded");
    n.removeClass("faded");
  });
  cy.on("mouseout", "node", () => {
    cy.elements().removeClass("faded hl-node hl-edge");
  });

  cy.on("click", "node", (e) => showGraphPanel(e.target));
  cy.on("dbltclick", "node", (e) => {
    location.hash = `#/note/${enc(e.target.id())}`;
  });
  cy.on("tap", (e) => {
    if (e.target === cy) hideGraphPanel();
  });
}

function updateLabels() {
  if (!cy) return;
  const zoom = cy.zoom();
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const show = zoom > 0.55 || n.data("deg") >= 5;
      n.style("label", show ? n.data("label") : "");
    });
  });
}

function applyGraphFilter() {
  if (!cy) return;
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const okCat = !state.graph.cat || n.data("cat") === state.graph.cat;
      const okIso = !state.graph.isolates || n.data("deg") > 0;
      const okQ = !state.query || n.data("label").toLowerCase().includes(state.query.toLowerCase());
      n.style("display", okCat && okIso ? "element" : "none");
      if (okCat && okIso) n.style("opacity", okQ ? 0.92 : 0.1);
    });
    cy.edges().forEach((e) => {
      const vis = e.data("source").style("display") === "element" && e.data("target").style("display") === "element";
      e.style("display", vis ? "element" : "none");
    });
  });
}

function showGraphPanel(node) {
  const id = node.id();
  const nd = nodeBySlug.get(id);
  const md = bySlug.get(id) || {};
  const p = $("#gpanel");
  const neighbors = cy ? node.neighborhood("node").toArray().sort((a, b) => b.data("deg") - a.data("deg")).slice(0, 6) : [];
  p.innerHTML = `
    <button class="p-close">×</button>
    <div class="p-cat">${(CATS[nd.cat] || {}).ico || "📄"} ${(CATS[nd.cat] || {}).label || nd.cat} · ${nd.deg} links</div>
    <h3>${esc(nd.title)}</h3>
    ${md.description ? `<div class="p-desc">${esc(md.description)}</div>` : ""}
    <div class="p-label">connected to</div>
    ${neighbors.map((nb) => `<div class="p-neigh" data-id="${esc(nb.id())}"><span class="dot" style="background:${nb.data("color")}"></span>${esc(nb.data("label"))}<span class="d">${nb.data("deg")}°</span></div>`).join("") || `<div class="p-desc">no connections</div>`}
    <button class="p-open">open note →</button>`;
  p.classList.add("open");
  p.querySelector(".p-close").onclick = hideGraphPanel;
  p.querySelector(".p-open").onclick = () => (location.hash = `#/note/${enc(id)}`);
  p.querySelectorAll(".p-neigh").forEach((r) => {
    r.onclick = () => {
      const t = cy.getElementById(r.dataset.id);
      if (t) { cy.animate({ center: { eles: t }, duration: 350 }, { duration: 350 }); showGraphPanel(t); }
    };
  });
}

function hideGraphPanel() {
  const p = $("#gpanel");
  if (p) p.classList.remove("open");
}

// ---------- GALAXY (3D) ----------
function galaxyNodes() {
  return GRAPH.nodes.map((n) => ({
    id: n.id,
    label: n.title,
    cat: n.cat,
    deg: n.deg,
    val: n.deg,
    r: 6 + n.deg * 2.6,
    color: (CATS[n.cat] || {}).color || "#89b4fa",
  }));
}
function galaxyLinks() {
  return GRAPH.edges.map(([a, b], i) => ({ id: "g" + i, source: a, target: b }));
}

function renderGalaxy() {
  tabActive("galaxy");
  document.title = "Galaxy — Brain";
  const view = $("#view");
  view.innerHTML = `
    <div class="view galaxy-view">
      <div class="galaxy-toolbar">
        <button class="chip active" data-gcat="">All</button>
        ${CAT_ORDER.filter((c) => GRAPH.nodes.some((n) => n.cat === c)).map((c) => `<button class="chip" data-gcat="${c}">${CATS[c].ico} ${CATS[c].label}</button>`).join("")}
        <button class="chip active" id="galaxy-iso">hide isolates ✓</button>
        <button class="chip" id="galaxy-reset">⟲ reset view</button>
        <div class="graph-legend">${CAT_ORDER.filter((c) => GRAPH.nodes.some((n) => n.cat === c)).map((c) => `<span class="li"><span class="dot" style="background:${CATS[c].color}"></span>${CATS[c].label}</span>`).join("")}</div>
      </div>
      <div class="galaxy-stage" id="galaxy-stage"></div>
      <div class="galaxy-hint">drag to orbit · scroll to zoom · click a node to inspect · double-click to open</div>
    </div>
    <div class="graph-panel" id="gpanel"></div>`;

  const stage = $("#galaxy-stage");
  const W = stage.clientWidth || window.innerWidth;
  const H = stage.clientHeight || window.innerHeight;

  fg3d = ForceGraph3D()(stage)
    .width(W)
    .height(H)
    .backgroundColor(document.documentElement.dataset.theme === "dark" ? "#08080f" : "#eef1fa")
    .showNavInfo(false)
    .nodeId("id")
    .nodeLabel((n) => `${n.label} · ${(CATS[n.cat] || {}).ico || ""} ${(CATS[n.cat] || {}).label || ""}`)
    .nodeVal((n) => n.deg + 2)
    .nodeRelSize(20)
    .nodeColor((n) => n.color)
    .nodeResolution(20)
    .linkColor(() => (document.documentElement.dataset.theme === "dark" ? "rgba(185,200,255,0.8)" : "rgba(70,85,140,0.7)"))
    .linkWidth(10)
    .linkOpacity(1)
    .warmupTicks(120)
    .cooldownTicks(120);

  fg3d.graphData({ nodes: galaxyNodes(), links: galaxyLinks() });

  // hide isolates by default so the camera frames the connected core
  state.galaxy = state.galaxy || { cat: null, isolates: true };
  applyGalaxyFilter(state.galaxy.cat, state.galaxy.isolates);

  // tune forces (sim now exists after graphData)
  try {
    fg3d.d3Force("charge").strength(-55);
    fg3d.d3Force("link").distance(38);
  } catch (e) {}

  // let it settle, then frame to fit (tight padding)
  setTimeout(() => { try { fg3d.zoomToFit(700, 24); } catch (e) {} }, 1600);

  // interactions
  fg3d.onNodeClick((n) => showGalaxyPanel(n));
  fg3d.onNodeRightClick((n) => { location.hash = `#/note/${enc(n.id)}`; });
  fg3d.onNodeHover((n) => { document.body.style.cursor = n ? "pointer" : ""; });

  // category filter
  document.querySelectorAll(".galaxy-toolbar [data-gcat]").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".galaxy-toolbar [data-gcat]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.galaxy.cat = b.dataset.gcat || null;
      applyGalaxyFilter(state.galaxy.cat, state.galaxy.isolates);
    };
  });
  const isoBtn = $("#galaxy-iso");
  isoBtn.onclick = () => {
    state.galaxy.isolates = !state.galaxy.isolates;
    isoBtn.textContent = state.galaxy.isolates ? "hide isolates ✓" : "show isolates ✗";
    isoBtn.classList.toggle("active", state.galaxy.isolates);
    applyGalaxyFilter(state.galaxy.cat, state.galaxy.isolates);
  };
  isoBtn.classList.toggle("active", state.galaxy.isolates);
  const resetBtn = $("#galaxy-reset");
  resetBtn.onclick = () => {
    try { fg3d.zoomToFit(600, 24); } catch (e) { try { fg3d.cameraPosition({ x: 0, y: 0, z: 420 }); } catch (e2) {} }
  };

  // resize
  window.addEventListener("resize", () => {
    if (!fg3d) return;
    fg3d.width(stage.clientWidth || window.innerWidth);
    fg3d.height(stage.clientHeight || window.innerHeight);
  });
}

function applyGalaxyFilter(cat, isolates) {
  if (!fg3d) return;
  const iso = isolates !== undefined ? isolates : (state.galaxy && state.galaxy.isolates);
  const nodeOK = (n) => (!cat || n.cat === cat) && (!iso || n.deg > 0);
  fg3d.nodeVisibility(nodeOK);
  fg3d.linkVisibility((l) => {
    const s = typeof l.source === "object" ? l.source : nodeBySlug.get(l.source);
    const t = typeof l.target === "object" ? l.target : nodeBySlug.get(l.target);
    return s && t && nodeOK(s) && nodeOK(t);
  });
}

function showGalaxyPanel(n) {
  const nd = nodeBySlug.get(n.id) || n;
  const md = bySlug.get(n.id) || {};
  const p = $("#gpanel");
  const neighbors = [...GRAPH.edges]
    .filter(([a, b]) => a === n.id || b === n.id)
    .map(([a, b]) => nodeBySlug.get(a === n.id ? b : a))
    .filter(Boolean)
    .sort((a, b) => b.deg - a.deg)
    .slice(0, 6);
  p.innerHTML = `
    <button class="p-close">×</button>
    <div class="p-cat">${(CATS[nd.cat] || {}).ico || "📄"} ${(CATS[nd.cat] || {}).label || nd.cat} · ${nd.deg} links</div>
    <h3>${esc(nd.title)}</h3>
    ${md.description ? `<div class="p-desc">${esc(md.description)}</div>` : ""}
    <div class="p-label">connected to</div>
    ${neighbors.map((nb) => `<div class="p-neigh" data-id="${esc(nb.id)}"><span class="dot" style="background:${(CATS[nb.cat] || {}).color}"></span>${esc(nb.title)}<span class="d">${nb.deg}°</span></div>`).join("") || `<div class="p-desc">no connections</div>`}
    <button class="p-open">open note →</button>`;
  p.classList.add("open");
  p.querySelector(".p-close").onclick = hideGraphPanel;
  p.querySelector(".p-open").onclick = () => (location.hash = `#/note/${enc(n.id)}`);
  p.querySelectorAll(".p-neigh").forEach((r) => {
    r.onclick = () => {
      const t = nodeBySlug.get(r.dataset.id);
      if (!t) return;
      try { fg3d.cameraPosition({ x: t.x, y: t.y, z: (t.z || 0) + 140 }, { x: t.x, y: t.y, z: t.z || 0 }, 600); } catch (e) {}
      showGalaxyPanel(t);
    };
  });
}

// ---------- PALETTE ----------
let paletteSel = 0;
let paletteItems = [];

function openPalette() {
  $("#scrim").hidden = false;
  const p = $("#palette");
  p.hidden = false;
  paletteSel = 0;
  const input = $("#palette-input");
  input.value = "";
  input.focus();
  renderPalette();
}
function closePalette() {
  $("#palette").hidden = true;
  if (!$("#help").hidden) { /* keep help */ }
  $("#scrim").hidden = true;
}

function paletteResults(q) {
  const s = q.toLowerCase().trim();
  const items = [];
  const actions = [
    { ico: "🏠", label: "Go to notes", run: () => (location.hash = "#/") },
    { ico: "🕸", label: "Go to graph", run: () => (location.hash = "#/graph") },
    { ico: "✍", label: "Review flashcards", run: () => (location.hash = "#/review") },
    { ico: "✦", label: "Go to 3D galaxy", run: () => (location.hash = "#/galaxy") },
    { ico: "🎲", label: "Random note", run: randomNote },
    { ico: "◐", label: "Toggle theme", run: () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
    { ico: "⌨", label: "Keyboard shortcuts", run: () => { closePalette(); $("#help").hidden = false; $("#scrim").hidden = false; } },
  ];
  for (const a of actions) {
    if (!s || a.label.toLowerCase().includes(s)) items.push({ ...a, kind: "action" });
  }
  if (s) {
    const ranked = MANIFEST
      .map((n) => ({ n, score: matchesSearch(n, s) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title))
      .slice(0, 8);
    for (const { n } of ranked) {
      items.push({
        ico: (CATS[n.category] || {}).ico || "📄",
        label: n.title,
        sub: (CATS[n.category] || {}).label || n.category,
        run: () => (location.hash = `#/note/${enc(n.slug)}`),
        kind: "note",
      });
    }
    // recent
    if (!s) {
      for (const slug of state.recent) {
        const n = bySlug.get(slug);
        if (n) items.push({ ico: "🕘", label: n.title, sub: "recent", run: () => (location.hash = `#/note/${enc(slug)}`), kind: "recent" });
      }
    }
  } else {
    for (const slug of state.recent) {
      const n = bySlug.get(slug);
      if (n) items.push({ ico: "🕘", label: n.title, sub: "recent", run: () => (location.hash = `#/note/${enc(slug)}`), kind: "recent" });
    }
  }
  return items.slice(0, 14);
}

function renderPalette() {
  const q = $("#palette-input").value;
  paletteItems = paletteResults(q);
  const list = $("#palette-list");
  list.innerHTML = "";
  let lastKind = "";
  paletteItems.forEach((it, i) => {
    if (it.kind !== lastKind && lastKind !== "") list.appendChild(el("div", "p-sep"));
    lastKind = it.kind;
    const row = el("div", "p-item" + (i === paletteSel ? " sel" : ""));
    row.innerHTML = `<span class="ico">${it.ico}</span>${esc(it.label)}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}`;
    row.onclick = () => pickPalette(i);
    row.onmousemove = () => { paletteSel = i; renderPalette(); };
    list.appendChild(row);
  });
  if (!paletteItems.length) list.innerHTML = `<div class="p-item" style="opacity:.5">no matches</div>`;
  const selRow = list.children[Math.min(paletteSel, Math.max(list.children.length - 1, 0))];
  if (selRow && selRow.classList.contains("p-item")) selRow.scrollIntoView({ block: "nearest" });
}

function pickPalette(i) {
  const it = paletteItems[i];
  if (!it) return;
  closePalette();
  it.run();
}

function closeOverlays() {
  $("#palette").hidden = true;
  const keepHelp = false;
  $("#help").hidden = true;
  $("#scrim").hidden = true;
  hideGraphPanel();
}

// ---------- confetti ----------
function confetti() {
  const colors = ["#89b4fa", "#cba6f7", "#a6e3a1", "#f9e2af", "#fab387", "#f38ba8", "#94e2d5"];
  for (let i = 0; i < 42; i++) {
    const p = el("div", "confetti-piece");
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = colors[(Math.random() * colors.length) | 0];
    p.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
    p.style.animationDuration = 1.6 + Math.random() * 1.6 + "s";
    p.style.animationDelay = Math.random() * 0.25 + "s";
    p.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 3600);
  }
}

// ---------- keyboard ----------
let lastG = 0;
function bindGlobal() {
  const search = $("#search");
  search.addEventListener("input", () => {
    state.query = search.value;
    $("#search-clear").hidden = !search.value;
    const hash = location.hash || "#/";
    if (hash.startsWith("#/graph")) applyGraphFilter();
    else if (!hash.startsWith("#/note/")) renderHome();
  });
  $("#search-clear").onclick = () => {
    search.value = "";
    state.query = "";
    $("#search-clear").hidden = true;
    renderHome();
  };
  $("#random-btn").onclick = randomNote;
  $("#theme-toggle").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("#palette-btn").onclick = openPalette;
  $("#brand").onclick = confetti;
  $("#help-close").onclick = () => { $("#help").hidden = true; $("#scrim").hidden = true; };

  // palette keys
  $("#palette-input").addEventListener("input", renderPalette);
  $("#palette-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); }
    else if (e.key === "Enter") pickPalette(paletteSel);
    else if (e.key === "Escape") closePalette();
  });

  // reading progress
  window.addEventListener("scroll", () => {
    const h = location.hash || "#/";
    if (h.startsWith("#/note/")) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      $("#progress").style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + "%";
    } else {
      $("#progress").style.width = "0";
    }
  }, { passive: true });

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#palette").hidden ? openPalette() : closePalette();
      return;
    }
    if (e.key === "Escape") {
      if (!$("#palette").hidden) closePalette();
      else if (!$("#help").hidden) { $("#help").hidden = true; $("#scrim").hidden = true; }
      else if (typing) document.activeElement.blur();
      return;
    }
    if (typing) return;
    if (location.hash && location.hash.startsWith("#/review")) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revRevealed) revReveal();
        return;
      }
      if (revRevealed && !revBrowse) {
        const map = { "1": 0, "2": 1, "3": 2, "4": 3 };
        if (e.key in map) {
          const btn = $("#fc-g" + map[e.key]);
          if (btn) btn.click();
          return;
        }
      }
    }
    if (e.key === "/") { e.preventDefault(); search.focus(); return; }
    if (e.key === "?") { $("#help").hidden = false; $("#scrim").hidden = false; return; }
    if (e.key === "t") { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); return; }
    if (e.key === "r" || e.key === "R") { randomNote(); return; }
    if (e.key === "g") {
      const now = Date.now();
      if (now - lastG < 800) {
        lastG = 0;
        location.hash = location.hash.startsWith("#/graph") ? "#/" : "#/graph";
        return;
      }
      lastG = now;
      return;
    }
    if (e.key === "j" || e.key === "k") {
      const h = location.hash || "#/";
      const m = h.match(/^#\/note\/(.+)$/);
      if (!m) return;
      const cur = bySlug.get(decodeURIComponent(m[1]));
      if (!cur) return;
      const siblings = MANIFEST.filter((x) => x.category === cur.category).sort((a, b) => a.title.localeCompare(b.title));
      const i = siblings.findIndex((x) => x.slug === cur.slug);
      const t = e.key === "j" ? siblings[i + 1] : siblings[i - 1];
      if (t) location.hash = `#/note/${enc(t.slug)}`;
    }
  });
}

function randomNote() {
  const n = MANIFEST[(Math.random() * MANIFEST.length) | 0];
  location.hash = `#/note/${enc(n.slug)}`;
}

// ---------- REVIEW (spaced repetition, SM-2) ----------
let DECK = { cards: [] };
let NOTE_KEYS = new Set();
const REV_KEY = "brain-review-v1";
let rev = {
  // per-card SRS state: { id: { ef, interval, reps, due } }
  cards: {},
  // session stats: { seen, again, good, easy }
  session: { seen: 0, again: 0, hard: 0, good: 0, easy: 0 },
};
let revQueue = [];      // card ids for this session
let revPos = 0;
let revRevealed = false;
let revBrowse = false;  // browse mode = no scheduling

function revLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(REV_KEY) || "null");
    if (d && d.cards) { rev.cards = d.cards; }
  } catch (e) {}
}
function revSave() {
  localStorage.setItem(REV_KEY, JSON.stringify({ cards: rev.cards }));
}
function cardState(id) {
  if (!rev.cards[id]) rev.cards[id] = { ef: 2.5, interval: 0, reps: 0, due: 0 };
  return rev.cards[id];
}
function today(ts) { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); }
function fmtDue(ms) {
  const d = new Date(ms);
  const now = new Date();
  const diff = Math.round((ms - Date.now()) / 86400000);
  if (diff <= 0) return "now";
  if (diff === 1) return "tomorrow";
  if (diff < 30) return `in ${diff}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// SM-2-ish grading: 0 again, 1 hard, 2 good, 3 easy
function revGrade(id, g) {
  const st = cardState(id);
  st.reps++;
  if (g === 0) {
    // lapse: redo tomorrow-ish, nudge ef down
    st.ef = Math.max(1.3, st.ef - 0.3);
    st.interval = 0;
    st.due = Date.now() + 5 * 60 * 1000; // re-queue in ~5 min
  } else {
    if (g === 1) st.ef = Math.max(1.3, st.ef - 0.15);
    if (g === 3) st.ef = Math.min(3.5, st.ef + 0.1);
    const prev = st.interval;
    if (st.reps === 1) st.interval = g === 1 ? 1 : 1;
    else if (st.reps === 2) st.interval = g === 1 ? 2 : 6;
    else st.interval = Math.max(1, Math.round(prev * (g === 1 ? 1.2 : st.ef)));
    if (g === 3) st.interval = Math.max(st.interval + 1, Math.round(st.interval * 1.3));
    st.due = today() + st.interval * 86400000;
  }
  revSave();
}

function revDeckCards() {
  const cat = (state && state.revCat) || null;
  return cat ? DECK.cards.filter((c) => c.cat === cat) : DECK.cards;
}
function revDueIds() {
  const now = Date.now();
  return revDeckCards().filter((c) => (cardState(c.id).due || 0) <= now).map((c) => c.id);
}

function revBuildQueue() {
  const due = revDueIds();
  if (!revBrowse) {
    // due first (soonest first), then new cards by deck order
    revQueue = due.slice();
    for (const c of revDeckCards()) if (!revQueue.includes(c.id)) revQueue.push(c.id);
  } else {
    revQueue = revDeckCards().map((c) => c.id);
  }
  revPos = 0;
}

function revStats() {
  const now = Date.now();
  let due = 0, learning = 0, mature = 0;
  for (const c of DECK.cards) {
    const st = rev.cards[c.id];
    if (!st || st.reps === 0) { due++; continue; }
    if (st.interval >= 21) mature++;
    else if (st.due <= now) due++;
    else learning++;
  }
  return { due, learning, mature };
}

function revCardById(id) { return DECK.cards.find((c) => c.id === id); }

function renderReview() {
  tabActive("review");
  const main = $("#view");
  main.innerHTML = "";

  if (!DECK.cards.length) {
    main.innerHTML = `<div class="review-view"><div class="review-empty">No flashcards yet — deck is being minted from your notes.</div></div>`;
    return;
  }

  const st = revStats();
  const wrap = el("div", "review-view");

  // header + stats
  const head = el("div", "review-head");
  head.innerHTML = `
    <div class="review-title">✍ Review</div>
    <div class="review-sub">spaced repetition · SM-2 · ${DECK.cards.length} cards · deck ${esc(DECK.version || "1")}</div>
    <div class="review-stats">
      <span class="rv-stat due"><b>${st.due}</b> due</span>
      <span class="rv-stat learning"><b>${st.learning}</b> learning</span>
      <span class="rv-stat mature"><b>${st.mature}</b> mature (≥21d)</span>
      <span class="rv-stat sess"><b>${rev.session.good + rev.session.easy}</b> answered this session</span>
    </div>
    <div class="review-modes">
      <button class="chip ${revBrowse ? "" : "active"}" id="rev-mode-due">Review due (${st.due})</button>
      <button class="chip ${revBrowse ? "active" : ""}" id="rev-mode-browse">Browse all</button>
    </div>
    <div class="review-cats" id="rev-cats"></div>`;
  wrap.appendChild(head);

  // session card area
  const area = el("div", "review-area");
  wrap.appendChild(area);
  main.appendChild(wrap);

  // category chips (touch-friendly)
  const catsRow = $("#rev-cats");
  const catsList = [...new Set(["All", ...DECK.cards.map((c) => c.cat)])];
  for (const c of catsList) {
    const b = el("button", "chip cat-chip" + ((state.revCat || null) === (c === "All" ? null : c) ? " active" : ""), c);
    b.onclick = () => {
      state.revCat = c === "All" ? null : c;
      revBuildQueue();
      revRenderCard(area);
      document.querySelectorAll(".cat-chip").forEach((x) => x.classList.toggle("active", x.textContent === c));
    };
    catsRow.appendChild(b);
  }

  $("#rev-mode-due").onclick = () => { state.revCat = null; revBrowse = false; revBuildQueue(); renderReview(); };
  $("#rev-mode-browse").onclick = () => { revBrowse = true; revBuildQueue(); renderReview(); };

  revRenderCard(area);

  $("#status").textContent = `${st.due} due · ${DECK.cards.length} cards · review mode: ${revBrowse ? "browse" : "due"}`;
}

function revRenderCard(area) {
  area.innerHTML = "";
  const q = revQueue[revPos];
  // keep header stat pills fresh
  const st = revStats();
  document.querySelectorAll(".rv-stat b").forEach((b, i) => {
    const v = [st.due, st.learning, st.mature][i];
    if (v !== undefined) b.textContent = v;
  });
  if (!q) {
    const done = el("div", "review-done");
    const s = revStats();
    done.innerHTML = `
      <div class="done-ico">🎉</div>
      <div class="done-title">Session complete</div>
      <div class="done-sub">
        ${rev.session.seen} card${rev.session.seen === 1 ? "" : "s"} reviewed ·
        ${rev.session.again} again · ${rev.session.hard} hard · ${rev.session.good} good · ${rev.session.easy} easy<br>
        ${s.due} still due overall.
      </div>
      <div class="done-actions">
        <button class="chip" id="rev-again">Start again (due)</button>
        <button class="chip" id="rev-browse">Browse all ${DECK.cards.length}</button>
      </div>`;
    area.appendChild(done);
    $("#rev-again").onclick = () => { revBrowse = false; revBuildQueue(); rev.session = { seen: 0, again: 0, hard: 0, good: 0, easy: 0 }; renderReview(); };
    $("#rev-browse").onclick = () => { revBrowse = true; revBuildQueue(); rev.session = { seen: 0, again: 0, hard: 0, good: 0, easy: 0 }; renderReview(); };
    return;
  }

  const card = revCardById(q);
  const stt = rev.cards[q];
  const catColor = card.cat === "C++" ? "#f9e2af" : card.cat === "System Design" ? "#cba6f7" : card.cat === "Networking" ? "#89b4fa" : card.cat === "Databases" ? "#94e2d5" : card.cat === "DevOps" ? "#fab387" : "#a6e3a1";
  const prog = Math.round((revPos / revQueue.length) * 100);

  const box = el("div", "flashcard");
  box.innerHTML = `
    <div class="fc-progress"><div class="fc-bar" style="width:${prog}%"></div></div>
    <div class="fc-meta">
      <span class="fc-cat" style="--cc:${catColor}">${esc(card.cat)}</span>
      ${NOTE_KEYS.has(card.src) ? `<span class="fc-src">from [[${esc(card.src)}]]</span>` : `<span class="fc-src plain">${esc(card.src)}</span>`}
      ${stt && stt.reps ? `<span class="fc-interval">${stt.interval ? `interval ${stt.interval}d · next ${fmtDue(stt.due)}` : "learning"}</span>` : `<span class="fc-interval new">new card</span>`}
      <span class="fc-count">${revPos + 1} / ${revQueue.length}</span>
    </div>
    <div class="fc-q" id="fc-q">${esc(card.q)}</div>
    <div class="fc-a" id="fc-a" hidden><div class="fc-a-inner">${card.a}</div>
      ${NOTE_KEYS.has(card.src) ? `<div class="fc-a-src"><a href="#/note/${enc(card.src)}">open source note →</a></div>` : `<div class="fc-a-src"><span class="fc-src-plain">source: ${esc(card.src)}</span></div>`}
    </div>
    <div class="fc-actions" id="fc-actions">
      ${revRevealed
        ? (revBrowse
            ? `<button class="fc-btn prev" id="fc-prev">← prev</button><button class="fc-btn next" id="fc-next">next →</button>`
            : `<button class="fc-btn again" id="fc-g0">😵 Again<br><small>1</small></button>
               <button class="fc-btn hard" id="fc-g1">😓 Hard<br><small>2</small></button>
               <button class="fc-btn good" id="fc-g2">🙂 Good<br><small>3</small></button>
               <button class="fc-btn easy" id="fc-g3">🤩 Easy<br><small>4</small></button>`)
        : `<button class="fc-btn reveal" id="fc-show">Reveal answer <span class="fc-kbd">space</span></button>`}
    </div>`;
  area.appendChild(box);

  // bring the new card's question into view (below the sticky top bar)
  requestAnimationFrame(() => {
    const card = document.querySelector(".flashcard");
    if (card) {
      const bar = document.getElementById("topbar");
      const barH = bar ? bar.getBoundingClientRect().height : 60;
      const y = card.getBoundingClientRect().top + window.scrollY - barH - 10;
      window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
    }
  });

  const qEl = $("#fc-q"), aEl = $("#fc-a");
  if (!revRevealed) {
    qEl.onclick = () => revReveal();
    $("#fc-show").onclick = () => revReveal();
  }
  if (revRevealed && !revBrowse) {
    const grade = (g) => {
      revGrade(q, g);
      rev.session.seen++;
      if (g === 0) rev.session.again++;
      else if (g === 1) rev.session.hard++;
      else if (g === 2) rev.session.good++;
      else rev.session.easy++;
      // re-queue 'again' cards later in the same session
      if (g === 0) revQueue.push(q);
      revPos++;
      revRevealed = false;
      revRenderCard(area);
    };
    $("#fc-g0").onclick = () => grade(0);
    $("#fc-g1").onclick = () => grade(1);
    $("#fc-g2").onclick = () => grade(2);
    $("#fc-g3").onclick = () => grade(3);
  }
  if (revRevealed && revBrowse) {
    $("#fc-prev").onclick = () => { revPos = Math.max(0, revPos - 1); revRevealed = false; revRenderCard(area); };
    $("#fc-next").onclick = () => { revPos++; revRevealed = false; revRenderCard(area); };
  }
}

function revReveal() {
  revRevealed = true;
  const aEl = $("#fc-a");
  if (aEl) { aEl.hidden = false; aEl.classList.add("shown"); }
  // bring controls into view (matters on phones where the card is taller than the screen)
  requestAnimationFrame(() => {
    const a = document.getElementById("fc-actions");
    if (!a) return;
    const bottom = a.getBoundingClientRect().bottom;
    const need = bottom - window.innerHeight + 44; // 44px headroom for statusbar
    if (need > 0) window.scrollBy({ top: need, behavior: "smooth" });
  });
  const actions = $("#fc-actions");
  if (actions && !revBrowse) {
    actions.innerHTML = `
      <button class="fc-btn again" id="fc-g0">😵 Again<br><small>1</small></button>
      <button class="fc-btn hard" id="fc-g1">😓 Hard<br><small>2</small></button>
      <button class="fc-btn good" id="fc-g2">🙂 Good<br><small>3</small></button>
      <button class="fc-btn easy" id="fc-g3">🤩 Easy<br><small>4</small></button>`;
    const grade = (g) => {
      const q = revQueue[revPos];
      revGrade(q, g);
      rev.session.seen++;
      if (g === 0) rev.session.again++;
      else if (g === 1) rev.session.hard++;
      else if (g === 2) rev.session.good++;
      else rev.session.easy++;
      if (g === 0) revQueue.push(q);
      revPos++;
      revRevealed = false;
      revRenderCard($("#view .review-area"));
    };
    $("#fc-g0").onclick = () => grade(0);
    $("#fc-g1").onclick = () => grade(1);
    $("#fc-g2").onclick = () => grade(2);
    $("#fc-g3").onclick = () => grade(3);
  }
}

boot().catch((e) => {
  $("#status").textContent = "failed to load: " + e.message;
  console.error(e);
});
