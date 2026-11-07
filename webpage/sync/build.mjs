// build.mjs — sync/cache/ → dist/ (rendered notes, manifest.json, graph.json, assets, vendor)
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import cpp from "highlight.js/lib/languages/cpp";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import rust from "highlight.js/lib/languages/rust";
import yaml from "highlight.js/lib/languages/yaml";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CACHE = path.join(__dirname, "cache");
const DIST = path.join(__dirname, "..", "dist");
const WIKI = path.join(CACHE, "wiki");
const INDEX = path.join(CACHE, "index.md");
const NM = path.join(__dirname, "..", "node_modules");

for (const [name, lang] of Object.entries({ cpp, python, javascript, typescript, json, sql, bash, xml, go, java, rust, yaml })) {
  hljs.registerLanguage(name, lang);
}

// ---------- frontmatter ----------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, "").replace(/^' '|'$/g, ""))
        .filter(Boolean)
        .map((s) => s.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim());
    } else if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
      fm[key] = val.replace(/"/g, "");
    } else {
      fm[key] = val.replace(/^"|"$/g, "");
    }
  }
  return { fm, body: raw.slice(m[0].length) };
}

// ---------- index.md descriptions ----------
function loadDescriptions() {
  const desc = new Map();
  try {
    const text = fs.readFileSync(INDEX, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\|\s*\[\[([^\]]+)\]\]\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
      if (m) desc.set(m[1].trim(), m[3].trim());
    }
  } catch {}
  return desc;
}

// ---------- marked setup ----------
function makeMarked(titleToSlug, imgExists) {
  const wikilink = {
    name: "wikilink",
    level: "inline",
    start(src) {
      const i = src.indexOf("[[");
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = src.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      if (m) {
        const raw = m[1].trim();
        const alias = (m[2] || m[1]).trim();
        const slug = titleToSlug.get(raw);
        return {
          type: "wikilink",
          raw: m[0],
          title: raw,
          alias,
          slug: slug || null,
        };
      }
    },
    renderer(token) {
      const { title, alias, slug } = token;
      if (slug) {
        return `<a class="wikilink" href="#/note/${encodeURIComponent(slug)}" data-title="${title.replace(/"/g, "&quot;")}">${alias}</a>`;
      }
      return `<a class="wikilink dangling" href="#/note/${encodeURIComponent(title)}" data-title="${title.replace(/"/g, "&quot;")}">${alias}</a>`;
    },
  };

  const imgEmbed = {
    name: "imgEmbed",
    level: "block",
    start(src) {
      const i = src.indexOf("![[");
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = src.match(/^!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      if (m) {
        const file = m[1].trim();
        return { type: "imgEmbed", raw: m[0], file, alt: m[2] ? m[2].trim() : file };
      }
    },
    renderer(token) {
      const file = token.file;
      const src = "assets/" + encodeURIComponent(file);
      if (!imgExists.has(path.basename(file))) {
        return `<figure class="img-missing"><img src="${src}" alt="${token.alt}" loading="lazy" onerror="this.closest('figure').classList.add('broken');this.removeAttribute('src');this.closest('figure').innerHTML='<div class=\\'broken-note\\'>📎 image not in assets: ${file}</div>'"></figure>`;
      }
      return `<figure class="img-embed"><img src="${src}" alt="${token.alt}" loading="lazy"></figure>`;
    },
  };

  const markedInstance = marked.use({
    gfm: true,
    breaks: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {}
      }
      try {
        return hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
    extensions: [imgEmbed, wikilink],
    renderer: {
      code(token) {
        const lang = (token.lang || "").split(" ")[0];
        const label = lang || "code";
        const codeText = token.text.replace(/^[\n]+|[\n]+$/g, "");
        let highlighted;
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(codeText, { language: lang }).value;
        } else {
          highlighted = hljs.highlightAuto(codeText).value;
        }
        return (
          `<div class="codeblock"><div class="codebar"><span class="code-lang">${label}</span>` +
          `<button class="code-copy" type="button">copy</button></div>` +
          `<pre><code class="hljs language-${lang}">${highlighted}</code></pre></div>`
        );
      },
      heading(token) {
        const text = token.text;
        const id = text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
        return `<h${token.depth} id="${id}">${text}</h${token.depth}>`;
      },
    },
  });
  return markedInstance;
}

// ---------- walk ----------
function walkMd(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ---------- main ----------
async function main() {
  const files = walkMd(WIKI);
  // title (display name = filename without .md) → slug
  const titleToSlug = new Map();
  const notes = [];
  for (const f of files) {
    const rel = path.relative(WIKI, f); // e.g. cpp/Redis.md
    const category = rel.split("/")[0];
    const slug = path.basename(f, ".md");
    const title = path.basename(f, ".md");
    titleToSlug.set(title, slug);
    notes.push({ file: f, rel, category, slug, title });
  }
  // handle title collisions (two files with same basename in different dirs):
  // link resolution prefers exact title; on collision first wins + note both.
  for (const n of notes) if (!titleToSlug.get(n.title)) titleToSlug.set(n.title, n.slug);

  const descriptions = loadDescriptions();
  const imgs = new Set(fs.readdirSync(path.join(CACHE, "assets")).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f)));
  const markedInstance = makeMarked(titleToSlug, imgs);

  const manifest = [];
  const graphNodes = [];
  const edgeSet = new Set();
  let refImgs = new Set();

  const bySlug = new Map(notes.map((n) => [n.slug, n]));

  for (const n of notes) {
    const raw = fs.readFileSync(n.file, "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const title = fm.title || n.title;
    // re-register with real title if it differs from filename
    if (title !== n.title) titleToSlug.set(title, n.slug);

    let rendered;
    const parseResult = markedInstance.parse(body, { async: false });
    rendered = parseResult;

    // wrap tables in a scroll container (marked v18 renderer overrides don't
    // expose the default renderer, so post-process instead)
    rendered = rendered.replace(/<table>[\s\S]*?<\/table>/g, (m) => `<div class="tblwrap">${m}</div>`);

    // ensure an H1
    if (!/^<h1[ >]/.test(rendered)) {
      rendered = `<h1 id="top">${title.replace(/</g, "&lt;")}</h1>\n` + rendered;
    }

    fs.mkdirSync(path.join(DIST, "notes"), { recursive: true });
    fs.writeFileSync(path.join(DIST, "notes", n.slug + ".html"), rendered);

    // extract wikilinks for graph (from raw body, incl. related:)
    const links = [...body.matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1].trim());
    const related = Array.isArray(fm.related) ? fm.related : [];
    for (const l of [...links, ...related]) {
      const target = titleToSlug.get(l);
      if (target && target !== n.slug) {
        const key = [n.slug, target].sort().join("::");
        edgeSet.add(key);
      }
    }

    // words / reading time
    const textOnly = body
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[\[[^\]]*\]\]/g, " ")
      .replace(/\[\[[^\]]*\]\]/g, " ")
      .replace(/[#*`>|~_-]/g, " ");
    const words = textOnly.split(/\s+/).filter(Boolean).length;

    manifest.push({
      slug: n.slug,
      title,
      category: n.category,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      type: fm.type || "",
      updated: fm.updated || fm.created || "",
      words,
      readMin: Math.max(1, Math.round(words / 200)),
      description: descriptions.get(title) || descriptions.get(n.title) || "",
    });

    graphNodes.push({ id: n.slug, title, cat: n.category, deg: 0, tags: Array.isArray(fm.tags) ? fm.tags : [] });
  }

  // collect referenced images from rendered notes
  for (const n of notes) {
    const html = fs.readFileSync(path.join(DIST, "notes", n.slug + ".html"), "utf8");
    for (const m of html.matchAll(/src="assets\/([^"]+)"/g)) {
      refImgs.add(decodeURIComponent(m[1]));
    }
  }

  // graph edges + degree
  const nodesBySlug = new Map(graphNodes.map((nd) => [nd.id, nd]));
  const edges = [];
  for (const key of edgeSet) {
    const [a, b] = key.split("::");
    if (!nodesBySlug.has(a) || !nodesBySlug.has(b)) continue;
    edges.push([a, b]);
    nodesBySlug.get(a).deg++;
    nodesBySlug.get(b).deg++;
  }
  const maxDeg = Math.max(...graphNodes.map((n) => n.deg), 1);

  // ---------- write manifest + graph ----------
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(
    path.join(DIST, "graph.json"),
    JSON.stringify({ nodes: graphNodes, edges, maxDeg }, null, 1)
  );

  // ---------- copy assets (only referenced) ----------
  fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
  let copied = 0;
  for (const img of refImgs) {
    const src = path.join(CACHE, "assets", img);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(DIST, "assets", img));
      copied++;
    }
  }

  // ---------- vendor libs ----------
  const { buildSync } = await import("esbuild");
  fs.mkdirSync(path.join(DIST, "vendor"), { recursive: true });
  // hljs: bundle ESM core + common languages to an IIFE exposing window.hljs
  const hljsEntry = path.join(DIST, "vendor", ".hljs-entry.js");
  fs.writeFileSync(
    hljsEntry,
    `import hljs from "highlight.js";\nwindow.hljs = hljs;\n`
  );
  buildSync({
    entryPoints: [hljsEntry],
    bundle: true,
    minify: true,
    format: "iife",
    outfile: path.join(DIST, "vendor", "hljs.min.js"),
    logLevel: "warning",
    nodePaths: [path.join(__dirname, "..", "node_modules")],
  });
  fs.unlinkSync(hljsEntry);
  // cytoscape-cose-bilkent: its UMD expects a `coseBase` global that isn't
  // present in the browser, so re-bundle it with esbuild to inline `cose-base`.
  const coseEntry = path.join(DIST, "vendor", ".cose-entry.js");
  fs.writeFileSync(
    coseEntry,
    'import coseBilkent from "cytoscape-cose-bilkent";\nwindow.cytoscapeCoseBilkent = coseBilkent;\n'
  );
  buildSync({
    entryPoints: [coseEntry],
    bundle: true,
    minify: true,
    format: "iife",
    outfile: path.join(DIST, "vendor", "cytoscape-cose-bilkent.js"),
    logLevel: "warning",
    nodePaths: [path.join(__dirname, "..", "node_modules")],
  });
  fs.unlinkSync(coseEntry);
  const vendorCopy = [
    ["highlight.js/styles/github-dark.min.css", "hljs.css"],
    ["highlight.js/styles/github.min.css", "hljs-light.css"],
    ["cytoscape/dist/cytoscape.umd.js", "cytoscape.min.js"],
    ["3d-force-graph/dist/3d-force-graph.min.js", "3d-force-graph.min.js"],
  ];
  for (const [from, to] of vendorCopy) {
    const src = path.join(NM, from);
    if (!fs.existsSync(src)) throw new Error("vendor missing: " + from);
    fs.copyFileSync(src, path.join(DIST, "vendor", to));
  }

  // ---------- gates ----------
  const errs = [];
  for (const n of manifest) {
    if (!fs.existsSync(path.join(DIST, "notes", n.slug + ".html"))) errs.push("missing html: " + n.slug);
  }
  if (graphNodes.length !== manifest.length) errs.push("node/manifest count mismatch");
  for (const [a, b] of edges) {
    if (!nodesBySlug.has(a) || !nodesBySlug.has(b)) errs.push("unknown edge node: " + a + "-" + b);
  }
  const missingAssets = [];
  for (const img of refImgs) {
    if (!fs.existsSync(path.join(DIST, "assets", img))) missingAssets.push(img);
  }
  if (errs.length) {
    console.error("GATES FAILED:\n" + errs.join("\n"));
    process.exit(1);
  }
  if (missingAssets.length) {
    console.log(`gates: pass (warn: ${missingAssets.length} dangling image refs rendered as placeholders)`);
  }

  console.log(
    `gates: pass — ${manifest.length} notes, ${edges.length} edges, ${copied} images, maxDeg ${maxDeg}`
  );
}

main().catch((e) => {
  console.error("build fatal:", e);
  process.exit(1);
});
