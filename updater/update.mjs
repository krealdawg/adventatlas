#!/usr/bin/env node
/* =====================================================================
   Advent Atlas — robot de mise à jour quotidienne du catalogue
   ---------------------------------------------------------------------
   1. Lit les flux produits de vos programmes d'affiliation (Awin,
      Tradedoubler/Galaxus, etc.) et AJOUTE les nouveaux calendriers.
   2. Vérifie la disponibilité : flux (en stock / plus listé) et, pour
      les fiches qui ont une URL produit, les données schema.org de la page.
   3. MASQUE les calendriers indisponibles depuis X jours (removeAfterDays)
      et les réaffiche s'ils reviennent en stock.
   4. Écrit data/calendars.json + data/last-run.json.
   Aucune dépendance : Node 18+ suffit.  Usage : node updater/update.mjs [--dry]
   ===================================================================== */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = path.join(ROOT, "data", "calendars.json");
const RUN_FILE = path.join(ROOT, "data", "last-run.json");
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, "updater", "config.json"), "utf8"));
const DRY = process.argv.includes("--dry");
const NOW = new Date(process.env.AA_NOW || Date.now());
const TODAY = NOW.toISOString().slice(0, 10);
const UA = `AdventAtlasBot/1.0 (+${CFG.siteUrl})`;
const CATS = ["toys","collect","choc","sweets","gourmet","tea","drinks","beauty","wellness","jewel","home","games","diy","pets"];

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = s => String(s || "").replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || "");
const days = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);
const strip = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const slug = s => strip(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/* ---------- téléchargement (http, https ou fichier local) ---------- */
async function fetchBuf(url, timeout = 30000) {
  if (!/^https?:/i.test(url)) return fs.readFile(url.replace(/^file:\/\//, ""));
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}
const gunzipIf = b => (b[0] === 0x1f && b[1] === 0x8b) ? zlib.gunzipSync(b) : b;

/* ------------------------------ parseurs ------------------------------ */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const first = text.slice(0, text.indexOf("\n") + 1 || text.length);
  const delim = [",", ";", "|", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
function parseXML(text, tag = "product") {
  const out = [], re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi");
  const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
  for (const m of text.matchAll(re)) {
    const inner = m[0].replace(/^<[^>]+>/, "").replace(/<\/[^>]+>\s*$/, "");
    const o = {}; for (const f of inner.matchAll(/<([\w:.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) if (!(f[1] in o)) o[f[1]] = dec(f[2]);
    out.push(o);
  }
  return out;
}
function parseJSON(text) { const j = JSON.parse(text); return Array.isArray(j) ? j : (j.products || j.items || j.data || []); }

/* ------------------------------ taux de change ------------------------------ */
let RATES = { EUR: 1, CHF: 0.92, USD: 1.15, GBP: 0.85, CAD: 1.6, SEK: 11, NOK: 11.7, DKK: 7.46, PLN: 4.25, CZK: 24.5 };
async function loadRates() {
  for (const u of ["https://api.frankfurter.app/latest?from=EUR", "https://api.frankfurter.dev/v1/latest?base=EUR"]) {
    try { const j = JSON.parse((await fetchBuf(u, 10000)).toString()); if (j.rates) { RATES = { ...RATES, ...j.rates, EUR: 1 }; return true; } } catch {}
  }
  return false;
}
const toEUR = (p, cur) => { const v = parseFloat(String(p).replace(/[^\d.,]/g, "").replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "")); return isFinite(v) ? Math.round(v / (RATES[(cur || "EUR").toUpperCase()] || 1) * 100) / 100 : 0; };

/* ------------------------------ classement ------------------------------ */
// Un mot-clé correspond au début d'un mot (« bijou » trouve « bijoux ») ; les mots de 3 lettres ou moins doivent correspondre en entier.
const wordRe = new Map();
const has = (text, w) => { w = strip(w).trim(); if (!w) return false;
  if (!wordRe.has(w)) { const e = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); wordRe.set(w, new RegExp(`(^|[^a-z0-9])${e}${w.length <= 3 ? "([^a-z0-9]|$)" : ""}`)); }
  return wordRe.get(w).test(text); };
const rule = (rules, text, dflt) => { const t = strip(text); for (const [k, words] of rules) if (words.some(w => has(t, w))) return k; return dflt; };
function audiences(text) { const t = strip(text), a = []; for (const [k, words] of CFG.audienceRules) if (words.some(w => has(t, w))) a.push(k); return (a.length ? a.slice(0, 3) : ["f"]).join(""); }
function doorsOf(title) { const m = strip(title).match(/(\d{1,2})\s*(cases|jours|surprises|portes|turchen|tuerchen|tage|doors|days|windows|giorni|finestre|dias|ventanas)/); const n = m ? +m[1] : 24; return n >= 6 && n <= 31 ? n : 24; }
const isCalendar = title => { const t = strip(title); return CFG.keywords.some(k => t.includes(strip(k))) && !CFG.exclude.some(x => t.includes(strip(x))); };
const truthy = v => /^(1|true|yes|oui|ja|y|in ?stock|instock|available|disponible|verfugbar|auf lager|lieferbar|in_stock)$/i.test(strip(v).trim()) || /instock/i.test(String(v));
function cleanName(title, brand) {
  let n = String(title).replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "");
  n = n.replace(/calendrier de l['’]avent|adventskalender|advent calendar|calendario dell['’]avvento|calendario de adviento|\b20\d\d\b/gi, " ");
  n = n.replace(/\s*[-–|·:,]\s*$/, "").replace(/^\s*[-–|·:,]\s*/, "").replace(/\s{2,}/g, " ").trim();
  return n || "Advent Calendar";
}
const tokens = s => strip(s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !["advent", "calendar", "calendrier", "avent", "adventskalender", "the", "and", "les", "des", "edition", "classique"].includes(w));

/* ------------------------------ vérification des pages produit ------------------------------ */
async function checkPage(url) {
  try {
    const html = (await fetchBuf(url, 20000)).toString("utf8");
    const avail = [];
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      const s = m[1]; for (const a of s.matchAll(/"availability"\s*:\s*"([^"]+)"/gi)) avail.push(a[1]);
    }
    for (const a of html.matchAll(/itemprop=["']availability["'][^>]*(?:href|content)=["']([^"']+)/gi)) avail.push(a[1]);
    if (!avail.length) return { state: "unknown" };
    const ok = avail.some(a => /InStock|PreOrder|LimitedAvailability|OnlineOnly|BackOrder|PreSale/i.test(a));
    const ko = avail.some(a => /OutOfStock|SoldOut|Discontinued/i.test(a));
    return { state: ok ? "available" : ko ? "unavailable" : "unknown" };
  } catch (e) {
    if (e.status === 404 || e.status === 410) return { state: "unavailable", reason: "HTTP " + e.status };
    return { state: "unknown", reason: e.message };
  }
}

/* ================================== PRINCIPAL ================================== */
const db = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
const items = db.items; const byId = new Map(items.map(i => [i.id, i]));
const seen = new Map();            // id -> {available:bool}
const report = { date: TODAY, feeds: [], added: [], removed: [], restored: [], checked: 0, unknown: 0, errors: [] };
const rateLive = await loadRates();

function findExisting(brand, title) {
  const b = strip(brand); const tt = new Set(tokens(title));
  let best = null, bestScore = -1;
  for (const it of items) {
    if (strip(it.brand) !== b) continue;
    const nt = tokens(it.name); const hit = nt.filter(w => tt.has(w)).length;
    if (nt.length === 0 ? true : hit === nt.length) { const sc = nt.length; if (sc > bestScore) { best = it; bestScore = sc; } }
  }
  return best;
}

for (const f of CFG.feeds || []) {
  if (!f.enabled) continue;
  const url = env(f.url); const name = f.name.split("—")[0].trim();
  if (!url) { report.errors.push(`${name} : URL manquante (secret non défini)`); continue; }
  try {
    const text = gunzipIf(await fetchBuf(url, 120000)).toString("utf8");
    const rows = f.format === "xml" ? parseXML(text, f.itemTag) : f.format === "json" ? parseJSON(text) : parseCSV(text);
    const F = f.fields, g = (r, k) => (F[k] ? r[F[k]] ?? "" : "");
    let n = 0, newCount = 0;
    for (const r of rows) {
      const title = g(r, "title"); if (!title || !isCalendar(title)) continue; n++;
      const brand = (g(r, "brand") || g(r, "merchant") || title.split(/\s+/)[0]).trim();
      const inStock = F.inStock ? truthy(g(r, "inStock")) : true;
      const price = toEUR(g(r, "price"), g(r, "currency"));
      const key = name + "|" + (g(r, "id") || g(r, "link") || title);
      let it = items.find(i => i.feedKey === key) || findExisting(brand, title);
      if (!it) {
        if (!inStock || price <= 0 || newCount >= CFG.maxNewPerRun) continue;
        const text = brand + " " + title;
        let id = slug(brand + " " + cleanName(title, brand)); while (byId.has(id)) id += "-x";
        it = { id, brand, name: cleanName(title, brand), cat: rule(CFG.categoryRules, text, "gourmet"), price, doors: doorsOf(title),
               aud: audiences(text), flags: "n", site: "", url: g(r, "productUrl"), link: g(r, "link"), source: "feed:" + name,
               status: "active", added: TODAY, lastChecked: TODAY, unavailableSince: "", feedKey: key };
        if (!CATS.includes(it.cat)) it.cat = "gourmet";
        items.push(it); byId.set(id, it); newCount++; report.added.push(`${brand} — ${it.name} (${it.cat}, ${price} €)`);
      } else {
        if (!it.feedKey) it.feedKey = key;
        if (!it.link && g(r, "link")) it.link = g(r, "link");
        if (!it.url && g(r, "productUrl")) it.url = g(r, "productUrl");
        if (price > 0 && inStock && it.source !== "manual") it.price = price;
      }
      const prev = seen.get(it.id); seen.set(it.id, { available: (prev?.available) || inStock });
    }
    report.feeds.push({ name, rows: rows.length, calendars: n, new: newCount });
  } catch (e) { report.errors.push(`${name} : ${e.message}`); }
}

// Pages produit des fiches qui ont une URL et n'ont pas été confirmées par un flux
if (CFG.checkProductPages) {
  for (const it of items) {
    if (!it.url || seen.has(it.id) || it.status === "removed" && it.source !== "manual") continue;
    const r = await checkPage(it.url); report.checked++;
    if (r.state === "unknown") { report.unknown++; continue; }
    seen.set(it.id, { available: r.state === "available" });
    await sleep(800);
  }
}

// Décision : masquer / réafficher
const anyFeed = report.feeds.length > 0;
for (const it of items) {
  let s = seen.get(it.id);
  // Calendrier venu d'un flux qui n'y figure plus (flux lu avec succès) => considéré indisponible
  if (!s && anyFeed && String(it.source).startsWith("feed:") && report.feeds.some(f => it.source === "feed:" + f.name)) s = { available: false };
  if (!s) continue;                                     // rien de nouveau : on ne touche pas
  it.lastChecked = TODAY;
  if (s.available) {
    if (it.status === "removed") { it.status = "active"; report.restored.push(`${it.brand} — ${it.name}`); }
    it.unavailableSince = "";
  } else {
    if (!it.unavailableSince) it.unavailableSince = TODAY;
    if (it.status === "active" && days(it.unavailableSince, TODAY) >= CFG.removeAfterDays) { it.status = "removed"; report.removed.push(`${it.brand} — ${it.name}`); }
  }
}
// Le badge « Nouveau » des fiches ajoutées automatiquement disparaît après 14 jours
for (const it of items) if (String(it.source).startsWith("feed:") && it.flags.includes("n") && days(it.added, TODAY) > 14) it.flags = it.flags.replace("n", "");

db.updatedAt = NOW.toISOString();
const active = items.filter(i => i.status === "active").length;
Object.assign(report, { active, total: items.length, ratesLive: rateLive });
if (!DRY) { await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 1)); await fs.writeFile(RUN_FILE, JSON.stringify(report, null, 1)); }

log(`\n🎄 Advent Atlas — mise à jour du ${TODAY}${DRY ? " (simulation)" : ""}`);
log(`   Flux lus : ${report.feeds.map(f => `${f.name} (${f.calendars} calendriers, ${f.new} nouveaux)`).join(", ") || "aucun"}`);
log(`   Ajoutés : ${report.added.length} · Masqués : ${report.removed.length} · Réaffichés : ${report.restored.length} · Pages vérifiées : ${report.checked} (${report.unknown} sans info)`);
log(`   Catalogue visible : ${active} / ${items.length}`);
for (const k of ["added", "removed", "restored"]) for (const l of report[k]) log(`   ${{ added: "+", removed: "−", restored: "↺" }[k]} ${l}`);
for (const e of report.errors) log(`   ⚠️ ${e}`);
