/**
 * Reconnecter les orphelins — plugin Penpot
 * Port du skill penpot-reconnect-orphans v0.9.4 (reconstruction, jamais de swap brut).
 *
 * Protocole par racine orpheline :
 *   SCAN  → match path+name, puis match de variante par signature
 *   BUILD → instance neuve du maître + delta (textes, fills/strokes + tokens, icônes, visibilité…)
 *   VERIFY → lien, variante, overrides
 *   REPARENT + LAYOUT + CHECK → insertion à l'index de l'orphelin (rien n'est supprimé)
 *   COMMIT (confirmation) → renommage puis remove() de l'orphelin EN DERNIER (gel possible ensuite)
 *   CANCEL → supprime l'instance neuve, l'orphelin reste intact
 */
penpot.ui.open('Reconnecter composant orphelin', 'https://smeeters.github.io/sansfamille/ui-v8.html', { width: 480, height: 760 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (v) => Math.round((v ?? 1) * 1000) / 1000;
const PAGE_ROOT_ID = '00000000-0000-0000-0000-000000000000';
const pending = {}; // orphanId -> état de reconstruction en cours
const harvests = {}; // orphanId -> harvest JSON

const send = (type, payload) => penpot.ui.sendMessage({ type, ...payload });
const byId = (id) => penpot.currentPage?.getShapeById?.(id) ?? null;

// ───────────────────────── utilitaires ─────────────────────────
function isOrphan(s) {
  try {
    if (s.isComponentInstance?.() !== true) return false;
    const c = s.component?.();
    return !c || !c.id;
  } catch (e) { return false; }
}

function orphanAncestor(sh) {
  let a = sh.parent, first = null;
  while (a && a.id !== PAGE_ROOT_ID) {
    if (isOrphan(a)) first = first ?? a.name;
    a = a.parent;
  }
  return first;
}

// Librairies : doublons de noms possibles, les vides ne sont pas des sources.
function libs() {
  return (penpot.library.connected ?? []).filter((l) => (l.components ?? []).length > 0);
}

function splitName(full) {
  const parts = full.split(' / ');
  return { name: parts[parts.length - 1], path: parts.slice(0, -1).join(' / ') };
}

function findMatches(fullName) {
  const { name, path } = splitName(fullName);
  const out = [];
  libs().forEach((lib) => (lib.components ?? []).forEach((c) => {
    if (c.name === name && c.path === path) out.push({ lib, comp: c });
  }));
  return out;
}

function resolveComponent(id) {
  for (const lib of libs()) {
    let c = lib.components.find((x) => x.id === id);
    if (c) return c;
    for (const g of lib.components) {
      try {
        if (g.isVariant?.()) {
          const v = g.variants.variantComponents().find((x) => x.id === id);
          if (v) return v;
        }
      } catch (e) {}
    }
  }
  return null;
}

// ───────────────────────── signature de variante ─────────────────────────
function sig(s) {
  const o = { type: s.type };
  try { o.fills = (s.fills || []).map((f) => [String(f.fillColor || '').toLowerCase(), r3(f.fillOpacity)]); } catch (e) {}
  try { o.strokes = (s.strokes || []).map((f) => [String(f.strokeColor || '').toLowerCase(), r3(f.strokeOpacity), f.strokeWidth]); } catch (e) {}
  try { if (s.flex) o.pad = [s.flex.topPadding, s.flex.rightPadding, s.flex.bottomPadding, s.flex.leftPadding, s.flex.rowGap, s.flex.columnGap]; } catch (e) {}
  if (s.type === 'text') { try { o.font = [s.fontSize, s.fontWeight, s.letterSpacing]; } catch (e) {} }
  try { o.radius = s.borderRadius; o.opacity = r3(s.opacity); } catch (e) {}
  return o;
}
function sigTree(root) {
  const m = new Map();
  (function w(s, p) { m.set(p, sig(s)); (s.children ?? []).forEach((c, i) => w(c, p + '/#' + i)); })(root, '');
  return m;
}
let vcache = new Map(); // arbres de signature des variantes, par représentant (remis à zéro à chaque scan)
function variantTrees(rep) {
  if (vcache.has(rep.id)) return vcache.get(rep.id);
  let variants;
  variants = rep.isVariant?.() ? rep.variants.variantComponents() : [rep];
  const arr = variants.map((v) => { try { return { v, tree: sigTree(v.mainInstance()) }; } catch (e) { return { v, tree: null }; } });
  vcache.set(rep.id, arr);
  return arr;
}
function matchVariant(orphan, rep) {
  let trees;
  try { trees = variantTrees(rep); } catch (e) { return { verdict: 'ERREUR', error: e.message }; }
  const T = sigTree(orphan);
  const scored = [];
  for (const { v, tree: V } of trees) {
    if (!V) { scored.push({ id: v.id, props: v.variantProps ?? null, n: 999, diffs: [] }); continue; }
    const diffs = [];
    for (const k of new Set([...T.keys(), ...V.keys()])) {
      const a = T.get(k), b = V.get(k);
      if (!a || !b) { diffs.push(k + ':structure'); continue; }
      for (const f of Object.keys(a)) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(k + ':' + f + ' orphelin=' + JSON.stringify(a[f]) + ' variante=' + JSON.stringify(b[f]));
    }
    scored.push({ id: v.id, props: v.variantProps ?? null, n: diffs.length, diffs: diffs.slice(0, 8) });
  }
  scored.sort((x, y) => x.n - y.n);
  const zero = scored.filter((x) => x.n === 0);
  return {
    variants: trees.length,
    verdict: zero.length === 1 ? 'MATCH_UNIQUE' : zero.length > 1 ? 'AMBIGU' : 'AUCUNE_VARIANTE_EXACTE',
    chosen: zero.length === 1 ? zero[0] : null,
    best: scored.slice(0, 3),
  };
}

// ───────────────────────── SOURCE PROBABLE (candidats approchés, lecture seule) ─────────────────────────
const stripAcc = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (t) => stripAcc(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function bigrams(t) { const x = ' ' + t + ' '; const m = new Map(); for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function dice(a, b) {
  let inter = 0, na = 0, nb = 0;
  a.forEach((v) => (na += v)); b.forEach((v) => (nb += v));
  a.forEach((v, k) => { if (b.has(k)) inter += Math.min(v, b.get(k)); });
  return na + nb ? (2 * inter) / (na + nb) : 0;
}
let libIdx = null;
function libIndex() {
  if (libIdx) return libIdx;
  libIdx = [];
  libs().forEach((lib) => (lib.components ?? []).forEach((c) => {
    const full = (c.path ? c.path + ' / ' : '') + c.name;
    libIdx.push({ lib, comp: c, full, leaf: norm(c.name), bi: bigrams(norm(full)) });
  }));
  return libIdx;
}
function countNodes(s) { let n = 1; (s.children ?? []).forEach((c) => (n += countNodes(c))); return n; }
function probableSources(orphan, max = 3) {
  const bi = bigrams(norm(orphan.name)), leaf = norm(splitName(orphan.name).name), oN = countNodes(orphan);
  return libIndex()
    .map((e) => ({ e, score: Math.max(dice(bi, e.bi), e.leaf === leaf ? 0.8 : 0) }))
    .filter((x) => x.score >= 0.55).sort((a, b) => b.score - a.score).slice(0, max)
    .map(({ e, score }) => {
      let nodes = null; try { nodes = countNodes(e.comp.mainInstance()); } catch (er) {}
      return { compId: e.comp.id, library: e.lib.name, name: e.full, score: Math.round(score * 100), nodes, orphanNodes: oN,
        confidence: score >= 0.85 && nodes === oN ? 'moyenne' : 'faible' };
    });
}
function classifyRow(orphan, comp, manual) {
  let isVar = false;
  try { isVar = !!comp.isVariant?.(); } catch (e) {}
  if (isVar) {
    const vi = matchVariant(orphan, comp);
    return { status: vi.verdict === 'MATCH_UNIQUE' ? 'VARIANTE_OK' : vi.verdict === 'AMBIGU' ? 'VARIANTE_AMBIGUE' : 'VARIANTE_ABSENTE', componentId: vi.chosen?.id ?? null, variantInfo: vi };
  }
  return { status: manual ? 'CHOIX_MANUEL' : 'MATCH_UNIQUE', componentId: comp.id, variantInfo: null };
}
function rematch(id, compId) {
  const o = byId(id), c = resolveComponent(compId);
  if (!o || !c) return { error: 'orphelin ou composant introuvable' };
  const lib = libs().find((l) => (l.components ?? []).some((x) => x.id === compId) ) ?? null;
  return { ...classifyRow(o, c, true), library: lib?.name ?? null };
}

// ───────────────────────── SCAN ─────────────────────────
function scan(scope) {
  vcache = new Map(); libIdx = null;
  // compteurs globaux de la page (règle 22 : à noter avant/après)
  let instances = 0, nestedAll = 0, rootsAll = 0;
  (function walk(s) {
    try { if (s.isComponentInstance?.() === true) instances++; } catch (e) {}
    if (isOrphan(s)) {
      rootsAll++;
      (function count(x) { (x.children ?? []).forEach((c) => { if (isOrphan(c)) nestedAll++; count(c); }); })(s);
      return;
    }
    (s.children ?? []).forEach(walk);
  })(penpot.currentPage.root);

  // racines du périmètre (page entière ou sélection)
  const roots = [], seen = new Set();
  const tops = scope === 'selection' ? (penpot.selection ?? []) : [penpot.currentPage.root];
  (function walk(s) {
    if (isOrphan(s)) { if (!seen.has(s.id)) { seen.add(s.id); roots.push(s); } return; }
    (s.children ?? []).forEach(walk);
  })({ children: tops });

  const rows = roots.map((r) => {
    const matches = findMatches(r.name);
    let base;
    if (matches.length === 1) base = { ...classifyRow(r, matches[0].comp, false), library: matches[0].lib.name };
    else base = { status: matches.length > 1 ? 'MATCH_AMBIGU' : 'AUCUN_MATCH', componentId: null, variantInfo: null, library: null };
    let candidates = [];
    if (!base.componentId) {
      if (matches.length > 1) candidates = matches.slice(0, 4).map((m) => ({ compId: m.comp.id, library: m.lib.name, name: (m.comp.path ? m.comp.path + ' / ' : '') + m.comp.name, score: 100, nodes: null, orphanNodes: null, confidence: 'faible' }));
      else if (matches.length === 0) { candidates = probableSources(r); if (candidates.length) base.status = 'SOURCE_PROBABLE'; }
    }
    return { id: r.id, name: r.name, ...base, candidates };
  });

  return {
    summary: {
      page: penpot.currentPage.name, scope,
      instances, orphanRoots: rootsAll, orphanNodes: rootsAll + nestedAll,
      inScope: rows.length, ready: rows.filter((r) => r.componentId).length,
      probable: rows.filter((r) => r.status === 'SOURCE_PROBABLE').length,
    },
    rows,
  };
}

// ───────────────────────── HARVEST ─────────────────────────
function harvest(root) {
  const nodes = [];
  (function h(sh, path) {
    const n = { id: sh.id, path, name: sh.name, type: sh.type };
    try { n.w = sh.width; n.h = sh.height; n.hidden = sh.hidden; n.opacity = sh.opacity; } catch (e) {}
    try { const l = sh.layoutChild; if (l) n.lc = { hs: l.horizontalSizing, vs: l.verticalSizing, abs: l.absolute, mt: l.topMargin, mr: l.rightMargin, mb: l.bottomMargin, ml: l.leftMargin, minW: l.minWidth, maxW: l.maxWidth, minH: l.minHeight, maxH: l.maxHeight }; } catch (e) {}
    try {
      if (Array.isArray(sh.fills)) n.fills = JSON.parse(JSON.stringify(sh.fills));
      if (Array.isArray(sh.strokes)) n.strokes = JSON.parse(JSON.stringify(sh.strokes));
    } catch (e) {}
    if (sh.type === 'text') { n.characters = sh.characters; try { n.fontSize = sh.fontSize; } catch (e) {} }
    nodes.push(n);
    (sh.children ?? []).forEach((c, i) => h(c, path + '/#' + i));
  })(root, '');
  return { at: new Date().toISOString(), rootId: root.id, rootName: root.name, rootX: root.x, rootY: root.y, nodes };
}

// ───────────────────────── DELTA ─────────────────────────
function paintKey(list, kind) {
  if (!Array.isArray(list)) return null;
  return list.map((f) => kind === 'fill'
    ? [String(f.fillColor || '').toLowerCase(), r3(f.fillOpacity), f.fillColorRefId ?? null, !!f.fillImage]
    : [String(f.strokeColor || '').toLowerCase(), r3(f.strokeOpacity), f.strokeColorRefId ?? null, f.strokeWidth]);
}
function snap(s) {
  const o = { type: s.type };
  try { o.hidden = !!s.hidden; } catch (e) {}
  try { o.opacity = r3(s.opacity); } catch (e) {}
  try { o.fills = paintKey(s.fills, 'fill'); } catch (e) {}
  try { o.strokes = paintKey(s.strokes, 'stroke'); } catch (e) {}
  if (s.type === 'text') { try { o.characters = s.characters; o.fontSize = String(s.fontSize); } catch (e) {} }
  return o;
}
function posMap(root) {
  const m = new Map();
  (function w(s, p) { m.set(p, s); (s.children ?? []).forEach((c, i) => w(c, p + '/#' + i)); })(root, '');
  return m;
}

/** Tête de sous-instance (icône…) côté instance NEUVE : les enfants d'une instance se disent tous « instance », et le nom d'un texte est son contenu. */
function isHead(s) {
  try { return typeof s.isComponentHead === 'function' ? s.isComponentHead() === true : s.type !== 'text'; }
  catch (e) { return false; }
}

/** Photo à plat d'un arbre (chemins par POSITION) : permet de comparer APRÈS que l'orphelin a changé ou disparu. */
function snapTree(root) {
  const m = new Map();
  (function w(s, p) {
    const raw = {};
    try { raw.hidden = !!s.hidden; raw.opacity = s.opacity; } catch (e) {}
    try { if (Array.isArray(s.fills)) raw.fills = JSON.parse(JSON.stringify(s.fills)); } catch (e) {}
    try { if (Array.isArray(s.strokes)) raw.strokes = JSON.parse(JSON.stringify(s.strokes)); } catch (e) {}
    if (s.type === 'text') { try { raw.characters = s.characters; raw.fontSize = s.fontSize; } catch (e) {} }
    m.set(p, { type: s.type, name: s.name, sn: snap(s), raw });
    (s.children ?? []).forEach((c, i) => w(c, p + '/#' + i));
  })(root, '');
  return m;
}

/** Compare orphelin (forme vivante OU photo) ↔ instance neuve. Renvoie swaps (icônes), ops (overrides), problems (STOP). */
function computeDelta(orphan, fresh) {
  const A = orphan instanceof Map ? orphan : snapTree(orphan), B = posMap(fresh);
  const swaps = [], ops = [], problems = [];
  const skip = [];
  for (const [p, a] of A) {
    if (skip.some((sp) => p.startsWith(sp + '/'))) continue;
    const b = B.get(p);
    if (!b) { problems.push({ path: p, why: 'absent du maître (structure divergente)' }); continue; }
    // Sous-instance échangée : nom différent (le nom d'un texte est son contenu : on ne regarde que les instances)
    if (p !== '' && a.type !== 'text' && isHead(b) && a.name !== b.name) {
      const m = findMatches(a.name);
      if (m.length === 1) swaps.push({ path: p, libPath: m[0].comp.path, libName: m[0].comp.name, compId: m[0].comp.id, from: a.name });
      else problems.push({ path: p, why: 'icône/sous-instance "' + a.name + '" : ' + (m.length ? 'source ambiguë' : 'source introuvable') });
      skip.push(p);
      continue;
    }
    const x = a.sn, y = snap(b), props = {};
    for (const f of Object.keys(x)) if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) props[f] = true;
    if (Object.keys(props).length) ops.push({ path: p, fields: Object.keys(props) });
  }
  for (const p of B.keys()) {
    if (skip.some((sp) => p.startsWith(sp + '/'))) continue;
    if (!A.has(p)) problems.push({ path: p, why: 'absent de l\'orphelin (structure divergente)' });
  }
  return { swaps, ops, problems };
}

function applyOps(orphan, fresh, ops) {
  const A = orphan instanceof Map ? orphan : snapTree(orphan), B = posMap(fresh), res = [];
  for (const op of ops) {
    const a = A.get(op.path), b = B.get(op.path);
    if (!a || !b) { res.push({ path: op.path, error: 'forme introuvable' }); continue; }
    const r = a.raw;
    for (const f of op.fields) {
      try {
        if (f === 'characters') b.characters = r.characters;
        else if (f === 'fontSize') b.fontSize = String(r.fontSize);
        else if (f === 'hidden') b.hidden = !!r.hidden;
        else if (f === 'opacity') b.opacity = r.opacity;
        else if (f === 'fills') b.fills = JSON.parse(JSON.stringify(r.fills));
        else if (f === 'strokes') {
          const clean = JSON.parse(JSON.stringify(r.strokes)).map((k) => {
            if (k.strokeCapStart === 'none') delete k.strokeCapStart;
            if (k.strokeCapEnd === 'none') delete k.strokeCapEnd;
            return k;
          });
          try { b.strokes = clean; }
          catch (e1) { b.strokes = clean.map((k) => ({ ...k, strokeCapStart: 'square', strokeCapEnd: 'square' })); }
        }
        res.push({ path: op.path, f, ok: true });
      } catch (e) { res.push({ path: op.path, f, error: e.message }); }
    }
  }
  return res;
}

// ───────────────────────── PHASES ─────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes) {
  let out = '', i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}
async function exportPng(shape) {
  try {
    const scale = Math.max(0.25, Math.min(2, 440 / Math.max(1, shape.width)));
    const bytes = await shape.export({ type: 'png', scale });
    return 'data:image/png;base64,' + toBase64(bytes);
  } catch (e) { return null; }
}
const clip = (t, n = 48) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n) + '…' : x; };
/** Ce qui sera conservé, en français (à partir de la photo de l'orphelin et du delta). */
function describeDelta(A, d) {
  const lines = [];
  d.swaps.forEach((w) => lines.push({ kind: 'icone', text: 'Icône conservée : « ' + clip(w.from) + ' »' }));
  d.ops.forEach((op) => {
    const a = A.get(op.path); const nom = a?.type === 'text' ? '' : ' (' + clip(a?.name, 28) + ')';
    op.fields.forEach((f) => {
      const r = a?.raw ?? {};
      if (f === 'characters') lines.push({ kind: 'texte', text: 'Texte conservé : « ' + clip(r.characters) + ' »' });
      else if (f === 'fontSize') lines.push({ kind: 'texte', text: 'Taille de police conservée : ' + r.fontSize });
      else if (f === 'fills') lines.push({ kind: 'couleur', text: 'Remplissage conservé' + nom + ((r.fills ?? []).some((x) => x.fillColorRefId) ? ' · lié à un token' : '') });
      else if (f === 'strokes') lines.push({ kind: 'couleur', text: 'Contour conservé' + nom + ((r.strokes ?? []).some((x) => x.strokeColorRefId) ? ' · lié à un token' : '') });
      else if (f === 'hidden') lines.push({ kind: 'etat', text: 'Visibilité conservée' + nom + ' : ' + (r.hidden ? 'masqué' : 'visible') });
      else if (f === 'opacity') lines.push({ kind: 'etat', text: 'Opacité conservée' + nom + ' : ' + r.opacity });
    });
  });
  return lines;
}

async function preview(id, componentId) {
  const orphan = byId(id);
  if (!orphan) return { error: 'orphelin introuvable' };
  const comp = resolveComponent(componentId);
  if (!comp) return { error: 'composant introuvable' };
  const A = snapTree(orphan);
  const before = await exportPng(orphan);
  const before0 = penpot.currentPage.root.children?.length ?? 0;
  const tmp = comp.instance();
  tmp.name = 'TEMP-APERCU';
  try { tmp.x = orphan.x; tmp.y = orphan.y + 3000; } catch (e) {}
  let out = {};
  try {
    await sleep(700);
    let d = computeDelta(A, tmp);
    const lines = describeDelta(A, d);
    const swapRes = [];
    if (d.swaps.length) {
      const map = posMap(tmp);
      for (const sw of d.swaps) { try { map.get(sw.path).swapComponent(resolveComponent(sw.compId)); swapRes.push({ path: sw.path, ok: true }); } catch (e) { swapRes.push({ path: sw.path, error: e.message }); } }
      await sleep(900);
      d = computeDelta(A, tmp);
    }
    applyOps(A, tmp, d.ops);
    await sleep(900);
    const after = await exportPng(tmp);
    out = { before, after, lines, swaps: d.swaps, problems: d.problems, ops: d.ops.length, noExport: !before || !after };
  } catch (e) {
    out = { error: 'aperçu : ' + e.message };
  } finally {
    try { tmp.remove(); } catch (e) {}
  }
  return out;
}

async function build(id, componentId) {
  const orphan = byId(id);
  if (!orphan) return { error: 'orphelin introuvable' };
  if (pending[id]) return { error: 'reconstruction déjà en cours pour cette racine' };
  const blocked = orphanAncestor(orphan);
  if (blocked) return { error: 'Le parent est dans le sous-arbre orphelin "' + blocked + '". Reconstruire l\'ancêtre orphelin le plus externe d\'abord.' };
  const comp = resolveComponent(componentId);
  if (!comp) return { error: 'composant introuvable' };

  harvests[id] = harvest(orphan);

  const inst = comp.instance();
  // construite hors zone : jamais superposée à l'orphelin
  try { inst.x = orphan.x; inst.y = orphan.y + 3000; } catch (e) {}
  const state = { newId: inst.id, componentId, orphanId: id };
  pending[id] = state;

  const linkedId = inst.component?.()?.id ?? null;
  if (linkedId !== componentId) {
    try { inst.remove(); } catch (e) {}
    delete pending[id];
    return { error: 'Variante liée ≠ variante demandée : instance neuve supprimée, orphelin intact.' };
  }

  // 1) swaps d'icônes (jamais d'op sous un slot swappé dans le même passage)
  await sleep(700);
  let d = computeDelta(orphan, inst);
  const swapRes = [];
  if (d.swaps.length) {
    const map = posMap(inst);
    for (const sw of d.swaps) {
      const slot = map.get(sw.path), target = resolveComponent(sw.compId);
      try { slot.swapComponent(target); swapRes.push({ path: sw.path, ok: true }); }
      catch (e) { swapRes.push({ path: sw.path, error: e.message }); }
    }
    await sleep(900);
    d = computeDelta(orphan, inst);
  }
  if (d.swaps.length || d.problems.length) {
    try { inst.remove(); } catch (e) {}
    delete pending[id];
    return { error: 'Structure non réconciliable : orphelin laissé intact, instance neuve supprimée.', problems: d.problems, swaps: d.swaps };
  }

  // 2) overrides
  const applied = applyOps(orphan, inst, d.ops);
  await sleep(900);

  // 3) VERIFY : relecture après attente, nouveau delta
  const fresh = byId(state.newId);
  const d2 = computeDelta(orphan, fresh);
  const remaining = d2.ops.filter((o) => !o.fields.every((f) => false));
  const linkOk = fresh.component?.()?.id === componentId;

  // 4) REPARENT (n'efface rien)
  const parent = orphan.parent;
  if (!parent) { try { fresh.remove(); } catch (e) {} delete pending[id]; return { error: 'orphelin sans parent' }; }
  state.parentId = parent.id;
  state.index = (parent.children ?? []).findIndex((c) => c.id === orphan.id);
  state.siblingIds = (parent.children ?? []).map((c) => c.id);
  state.size = { w: orphan.width, h: orphan.height };
  try {
    if (state.index >= 0 && typeof parent.insertChild === 'function') parent.insertChild(state.index, fresh);
    else parent.appendChild(fresh);
  } catch (e) { try { fresh.remove(); } catch (x) {} delete pending[id]; return { error: 'insertChild: ' + e.message }; }
  await sleep(700);
  // parent sans flex/grid : on reprend la position de l'orphelin (le layout pilote x/y sinon)
  try {
    const np = byId(state.parentId);
    if (np && !np.flex && !np.grid) { const nf = byId(state.newId); nf.x = orphan.x; nf.y = orphan.y; }
  } catch (e) {}

  // 5) LAYOUT : layoutChild n'est pas hérité d'une instance neuve
  const lc = harvests[id].nodes[0].lc;
  const lcRes = [];
  if (lc) {
    const map = { horizontalSizing: lc.hs, verticalSizing: lc.vs, absolute: lc.abs, topMargin: lc.mt, rightMargin: lc.mr, bottomMargin: lc.mb, leftMargin: lc.ml, minWidth: lc.minW, maxWidth: lc.maxW, minHeight: lc.minH, maxHeight: lc.maxH };
    const target = byId(state.newId);
    for (const [k, v] of Object.entries(map)) {
      if (v === undefined || v === null) continue;
      try { target.layoutChild[k] = v; lcRes.push({ k, ok: true }); } catch (e) { lcRes.push({ k, error: e.message }); }
    }
  }
  await sleep(900);

  // 6) CHECK_PARENT
  const p2 = byId(state.parentId), n2 = byId(state.newId);
  const children = (p2?.children ?? []).map((c) => c.id);
  const idx = children.indexOf(state.newId);
  const siblingsKept = state.siblingIds.every((s) => children.includes(s));
  const parentOk = n2?.parent?.id === state.parentId;
  const sizeNow = n2 ? { w: n2.width, h: n2.height } : null;
  const sizeOk = !!sizeNow && Math.abs(sizeNow.w - state.size.w) < 1 && Math.abs(sizeNow.h - state.size.h) < 1;
  const ok = linkOk && parentOk && idx >= 0 && siblingsKept && d2.problems.length === 0 && remaining.length === 0;
  state.ok = ok;
  const detail = {
    linkOk, parentOk, siblingsKept,
    index: idx, wantedIndex: state.index, orderMatches: idx === state.index,
    sizeBefore: state.size, sizeAfter: sizeNow, sizeOk,
    swaps: swapRes, appliedCount: applied.filter((a) => a.ok).length,
    appliedErrors: applied.filter((a) => a.error), remainingDiffs: remaining, layoutChild: lcRes,
    problems: d2.problems,
  };
  if (!ok) {
    // retour arrière : l'instance neuve disparaît, l'orphelin n'a pas bougé
    try { byId(state.newId)?.remove(); } catch (e) {}
    delete pending[id];
    return { built: false, error: 'Vérification non concluante : rien n\'a été modifié (instance neuve retirée, orphelin intact).', ...detail };
  }
  // succès : l'orphelin est masqué (pas de doublon visible), supprimé à la finalisation
  try { orphan.hidden = true; state.hidden = true; } catch (e) {}
  return {
    built: true, ok, linkOk, parentOk, siblingsKept,
    index: idx, wantedIndex: state.index, orderMatches: idx === state.index,
    sizeBefore: state.size, sizeAfter: sizeNow, sizeOk,
    swaps: swapRes, appliedCount: applied.filter((a) => a.ok).length,
    appliedErrors: applied.filter((a) => a.error), remainingDiffs: remaining, layoutChild: lcRes,
  };
}

function cancel(id) {
  const st = pending[id];
  if (!st) return { removed: false };
  const n = byId(st.newId);
  try { n?.remove(); } catch (e) { return { error: e.message }; }
  try { const o = byId(id); if (o && st.hidden) o.hidden = false; } catch (e) {}
  delete pending[id];
  return { removed: true };
}

function commit(id) {
  const st = pending[id];
  if (!st) return { error: 'aucune reconstruction en cours' };
  if (!st.ok) return { error: 'vérification non concluante : suppression refusée' };
  const orphan = byId(id), inst = byId(st.newId);
  if (!orphan) return { error: 'orphelin introuvable' };
  if (!inst) return { error: 'instance neuve introuvable : orphelin conservé' };
  try { inst.name = orphan.name; } catch (e) {}
  delete pending[id];
  // remove() EN DERNIER : le plugin peut geler ensuite (règle 27). Aucune relecture ici.
  try { orphan.remove(); } catch (e) { return { error: 'remove: ' + e.message + ' (Ctrl+Z possible)' }; }
  return { requested: true };
}


// ───────────────────────── RECONNEXION EN PLACE (méthode par défaut) ─────────────────────────
// La racine garde son id, son parent, son index, ses interactions : seule sa liaison change.
// Garde-fou du skill (règle 2bis) : le swap peut détruire la racine sans erreur. SONDE obligatoire sur un clone.
const pageRootShapes = () => (penpot.currentPage.root.children ?? []).map((c) => c.id);

async function probeSwap(orphan, comp) {
  const before = new Set(pageRootShapes());
  const pBefore = new Set((orphan.parent?.children ?? []).map((c) => c.id));
  let clone = null;
  try {
    clone = orphan.clone();
    try { penpot.currentPage.root.appendChild(clone); } catch (e) {}   // hors du parent : pas de décalage de mise en page
    try { clone.x = orphan.x; clone.y = orphan.y + 4000; } catch (e) {}
    const cid = clone.id, cy = clone.y;
    clone.swapComponent(comp);
    await sleep(1300);
    let alive = byId(cid);
    if (!alive) alive = (penpot.currentPage.root.children ?? []).find((c) => !before.has(c.id) && c.isComponentInstance?.() && Math.abs(c.y - cy) < 5) ?? null;
    const linked = alive?.component?.()?.id === comp.id;
    const kids = (alive?.children ?? []).length;
    return { ok: !!alive && linked && kids > 0, alive: !!alive, linked, kids };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // nettoyage : tout ce qui a été ajouté à la racine de la page par la sonde disparaît
    try { (penpot.currentPage.root.children ?? []).filter((c) => !before.has(c.id)).forEach((c) => c.remove()); } catch (e) {}
    try { (orphan.parent?.children ?? []).filter((c) => !pBefore.has(c.id)).forEach((c) => c.remove()); } catch (e) {}   // clone resté dans le parent
  }
}

function locateAfterSwap(id, parentId, siblingIds, compId) {
  let inst = byId(id);
  if (inst && inst.component?.()?.id === compId) return inst;
  const parent = byId(parentId) ?? penpot.currentPage.root;
  const cand = (parent.children ?? []).filter((c) => !siblingIds.includes(c.id) || c.id === id);
  return cand.find((c) => { try { return c.isComponentInstance?.() && c.component?.()?.id === compId; } catch (e) { return false; } }) ?? null;
}

async function swapInPlace(id, componentId) {
  const orphan = byId(id);
  if (!orphan) return { error: 'orphelin introuvable' };
  const blocked = orphanAncestor(orphan);
  if (blocked) return { error: 'Le parent est dans le sous-arbre orphelin "' + blocked + '". Reconnecter l\'ancêtre orphelin le plus externe d\'abord.' };
  const comp = resolveComponent(componentId);
  if (!comp) return { error: 'composant introuvable' };
  const parent = orphan.parent;
  if (!parent) return { error: 'orphelin sans parent' };

  // 1) ENREGISTRER LES VALEURS (photo à plat + harvest téléchargeable)
  harvests[id] = harvest(orphan);
  const A = snapTree(orphan);
  const lc = harvests[id].nodes[0].lc;
  const state = {
    parentId: parent.id,
    index: (parent.children ?? []).findIndex((c) => c.id === id),
    siblingIds: (parent.children ?? []).map((c) => c.id),
    size: { w: orphan.width, h: orphan.height },
  };

  // 2) SONDE sur clone : racine détruite => on s'arrête, l'original n'est pas touché
  const probe = await probeSwap(orphan, comp);
  if (!probe.ok) return { error: 'Reconnexion en place jugée dangereuse pour ce composant (la sonde sur un clone a détruit ou mal lié la racine). Rien n\'a été modifié. Utilisez la méthode « Remplacement ».', probe };

  // 3) RECONNECTER au bon composant (en place)
  let swapErr = null;
  try { orphan.swapComponent(comp); } catch (e) { swapErr = e.message; }
  await sleep(1300);
  if (swapErr) return { error: 'swapComponent : ' + swapErr, needsUndo: true };
  let inst = locateAfterSwap(id, state.parentId, state.siblingIds, componentId);
  if (!inst) return { error: 'Racine introuvable après la reconnexion : annulez avec Ctrl+Z (une version a été enregistrée).', needsUndo: true };
  const idChanged = inst.id !== id;

  // 4) APPLIQUER LES VALEURS au composant : icônes échangées d'abord, puis overrides
  let d = computeDelta(A, inst);
  const swapRes = [];
  if (d.swaps.length) {
    const map = posMap(inst);
    for (const sw of d.swaps) {
      try { map.get(sw.path).swapComponent(resolveComponent(sw.compId)); swapRes.push({ path: sw.path, ok: true }); }
      catch (e) { swapRes.push({ path: sw.path, error: e.message }); }
    }
    await sleep(900);
    inst = byId(inst.id) ?? inst;
    d = computeDelta(A, inst);
  }
  if (d.problems.length) return { error: 'Structure différente du composant : valeurs partielles. Ctrl+Z pour revenir en arrière.', problems: d.problems, needsUndo: true };
  const applied = applyOps(A, inst, d.ops);
  await sleep(900);

  // 5) LAYOUT : layoutChild de l'orphelin (sizing fill/auto, marges, min/max), seulement ce qui diffère
  const lcRes = [];
  inst = byId(inst.id) ?? inst;
  if (lc && inst.layoutChild) {
    const want = { horizontalSizing: lc.hs, verticalSizing: lc.vs, absolute: lc.abs, topMargin: lc.mt, rightMargin: lc.mr, bottomMargin: lc.mb, leftMargin: lc.ml, minWidth: lc.minW, maxWidth: lc.maxW, minHeight: lc.minH, maxHeight: lc.maxH };
    for (const [k, v] of Object.entries(want)) {
      if (v === undefined || v === null) continue;
      try { if (inst.layoutChild[k] !== v) { inst.layoutChild[k] = v; lcRes.push({ k, ok: true }); } } catch (e) { lcRes.push({ k, error: e.message }); }
    }
    await sleep(900);
  }

  // 6) VÉRIFIER (lecture après attente) : même place, même ordre, frères intacts, lien, valeurs
  const f = byId(inst.id) ?? inst;
  const d2 = computeDelta(A, f);
  const p2 = byId(state.parentId) ?? penpot.currentPage.root;
  const kidsNow = (p2.children ?? []).map((c) => c.id);
  const idx = kidsNow.indexOf(f.id);
  const siblingsKept = state.siblingIds.filter((x) => x !== id).every((x) => kidsNow.includes(x));
  const linkOk = f.component?.()?.id === componentId;
  const sizeNow = { w: f.width, h: f.height };
  const sizeOk = Math.abs(sizeNow.w - state.size.w) < 1 && Math.abs(sizeNow.h - state.size.h) < 1;
  const ok = linkOk && idx >= 0 && siblingsKept && d2.problems.length === 0 && d2.ops.length === 0;
  return {
    swapped: true, ok, idChanged, linkOk, siblingsKept,
    index: idx, wantedIndex: state.index, orderMatches: idx === state.index,
    sizeBefore: state.size, sizeAfter: sizeNow, sizeOk,
    iconSwaps: swapRes, appliedCount: applied.filter((a) => a.ok).length, appliedErrors: applied.filter((a) => a.error),
    remainingDiffs: d2.ops, problems: d2.problems, layoutChild: lcRes,
    note: ok ? undefined : 'Vérification non concluante : contrôlez à l\'œil, Ctrl+Z annule (version enregistrée avant le lot).',
  };
}

let undoId = null;
function undoBegin() {
  try {
    if (penpot.history && typeof penpot.history.undoBlockBegin === 'function') { undoId = penpot.history.undoBlockBegin(); return { ok: true }; }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: false, error: 'historique non exposé par cette version' };
}
function undoEnd() {
  try {
    if (undoId != null && penpot.history && typeof penpot.history.undoBlockFinish === 'function') { penpot.history.undoBlockFinish(undoId); undoId = null; return { ok: true }; }
  } catch (e) { undoId = null; return { ok: false, error: e.message }; }
  return { ok: false };
}

function commitMany(ids) {
  const res = [], todo = [];
  for (const id of ids) {
    const st = pending[id], orphan = byId(id), inst = st ? byId(st.newId) : null;
    if (!st || !st.ok || !orphan || !inst) { res.push({ id, error: 'non prêt : orphelin conservé' }); continue; }
    try { inst.name = orphan.name; } catch (e) {}
    todo.push({ id, orphan });
  }
  // tout le renommage d'abord, les remove() ensuite et en dernier (gel possible, règle 27)
  for (const t of todo) {
    delete pending[t.id];
    try { t.orphan.remove(); res.push({ id: t.id, requested: true }); }
    catch (e) { res.push({ id: t.id, error: 'remove: ' + e.message + ' (Ctrl+Z possible)' }); }
  }
  return res;
}
function cancelMany(ids) { return ids.map((id) => ({ id, ...cancel(id) })); }

// ───────────────────────── messages UI ─────────────────────────
penpot.ui.onMessage(async (msg) => {
  try {
    switch (msg.cmd) {
      case 'scan': send('scan', scan(msg.scope)); break;
      case 'save': {
        let r = { ok: false };
        try { await penpot.currentFile?.saveVersion?.('avant-reconnexion-orphelins'); r = { ok: true }; } catch (e) { r = { ok: false, error: e.message }; }
        send('save', r); break;
      }
      case 'preview': send('preview', { id: msg.id, ...(await preview(msg.id, msg.componentId)) }); break;
      case 'build': send('build', { id: msg.id, ...(await build(msg.id, msg.componentId)) }); break;
      case 'cancel': send('cancel', { id: msg.id, ...cancel(msg.id) }); break;
      case 'commit': send('commit', { id: msg.id, ...commit(msg.id) }); break;
      case 'commitMany': send('commitMany', { results: commitMany(msg.ids ?? []) }); break;
      case 'cancelMany': send('cancelMany', { results: cancelMany(msg.ids ?? []) }); break;
      case 'swap': send('swap', { id: msg.id, ...(await swapInPlace(msg.id, msg.componentId)) }); break;
      case 'rematch': send('rematch', { id: msg.id, ...rematch(msg.id, msg.compId) }); break;
      case 'undoBegin': send('undoBegin', undoBegin()); break;
      case 'undoEnd': send('undoEnd', undoEnd()); break;
      case 'harvestAll': send('harvestAll', { data: harvests }); break;
      case 'harvest': send('harvest', { id: msg.id, data: harvests[msg.id] ?? null }); break;
    }
  } catch (e) {
    send('error', { cmd: msg.cmd, id: msg.id, message: String(e?.message ?? e) });
  }
});
