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
penpot.ui.open('Reconnecter les orphelins', 'https://smeeters.github.io/sansfamille/ui-v3.html', { width: 460, height: 680 });

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
function matchVariant(orphan, rep) {
  let variants;
  try { variants = rep.isVariant?.() ? rep.variants.variantComponents() : [rep]; }
  catch (e) { return { verdict: 'ERREUR', error: e.message }; }
  const T = sigTree(orphan);
  const scored = [];
  for (const v of variants) {
    try {
      const V = sigTree(v.mainInstance());
      const diffs = [];
      for (const k of new Set([...T.keys(), ...V.keys()])) {
        const a = T.get(k), b = V.get(k);
        if (!a || !b) { diffs.push(k + ':structure'); continue; }
        for (const f of Object.keys(a)) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(k + ':' + f + ' orphelin=' + JSON.stringify(a[f]) + ' variante=' + JSON.stringify(b[f]));
      }
      scored.push({ id: v.id, props: v.variantProps ?? null, n: diffs.length, diffs: diffs.slice(0, 8) });
    } catch (e) { scored.push({ id: v.id, n: 999 }); }
  }
  scored.sort((x, y) => x.n - y.n);
  const zero = scored.filter((s) => s.n === 0);
  return {
    variants: variants.length,
    verdict: zero.length === 1 ? 'MATCH_UNIQUE' : zero.length > 1 ? 'AMBIGU' : 'AUCUNE_VARIANTE_EXACTE',
    chosen: zero.length === 1 ? zero[0] : null,
    best: scored.slice(0, 3),
  };
}

// ───────────────────────── SCAN ─────────────────────────
function scan() {
  const roots = [];
  let instances = 0, nested = 0;
  (function walk(s) {
    try { if (s.isComponentInstance?.() === true) instances++; } catch (e) {}
    if (isOrphan(s)) {
      roots.push(s);
      (function count(x) { (x.children ?? []).forEach((c) => { if (isOrphan(c)) nested++; count(c); }); })(s);
      return;
    }
    (s.children ?? []).forEach(walk);
  })(penpot.currentPage.root);

  const rows = roots.map((r) => {
    const matches = findMatches(r.name);
    let status = matches.length === 1 ? 'MATCH_UNIQUE' : matches.length > 1 ? 'MATCH_AMBIGU' : 'AUCUN_MATCH';
    let componentId = matches.length === 1 ? matches[0].comp.id : null;
    let variantInfo = null;
    if (matches.length === 1) {
      const rep = matches[0].comp;
      let isVar = false;
      try { isVar = !!rep.isVariant?.(); } catch (e) {}
      if (isVar) {
        variantInfo = matchVariant(r, rep);
        status = variantInfo.verdict === 'MATCH_UNIQUE' ? 'VARIANTE_OK'
          : variantInfo.verdict === 'AMBIGU' ? 'VARIANTE_AMBIGUE' : 'VARIANTE_ABSENTE';
        componentId = variantInfo.chosen?.id ?? null;
      }
    }
    return { id: r.id, name: r.name, status, componentId, variantInfo,
      library: matches.length === 1 ? matches[0].lib.name : null };
  });

  return {
    summary: {
      page: penpot.currentPage.name,
      instances, orphanRoots: roots.length, orphanNodes: roots.length + nested,
      connectedLibraries: (penpot.library.connected ?? []).map((l) => ({ name: l.name, components: (l.components ?? []).length })),
      ready: rows.filter((r) => r.componentId).length,
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

/** Compare orphelin ↔ instance neuve. Renvoie swaps (icônes), ops (overrides), problems (STOP). */
function computeDelta(orphan, fresh) {
  const A = posMap(orphan), B = posMap(fresh);
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
    const x = snap(a), y = snap(b), props = {};
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
  const A = posMap(orphan), B = posMap(fresh), res = [];
  for (const op of ops) {
    const a = A.get(op.path), b = B.get(op.path);
    if (!a || !b) { res.push({ path: op.path, error: 'forme introuvable' }); continue; }
    for (const f of op.fields) {
      try {
        if (f === 'characters') b.characters = a.characters;
        else if (f === 'fontSize') b.fontSize = String(a.fontSize);
        else if (f === 'hidden') b.hidden = !!a.hidden;
        else if (f === 'opacity') b.opacity = a.opacity;
        else if (f === 'fills') b.fills = JSON.parse(JSON.stringify(a.fills));
        else if (f === 'strokes') {
          const clean = JSON.parse(JSON.stringify(a.strokes)).map((k) => {
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
async function preview(id, componentId) {
  const orphan = byId(id);
  if (!orphan) return { error: 'orphelin introuvable' };
  const comp = resolveComponent(componentId);
  if (!comp) return { error: 'composant introuvable' };
  const tmp = comp.instance();
  tmp.name = 'TEMP-REFERENCE-DIFF';
  try { tmp.x = orphan.x; tmp.y = orphan.y + 3000; } catch (e) {}
  await sleep(700);
  const d = computeDelta(orphan, tmp);
  try { tmp.remove(); } catch (e) {}
  return d;
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
  try { inst.x = orphan.x; inst.y = orphan.y; } catch (e) {}
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

// ───────────────────────── messages UI ─────────────────────────
penpot.ui.onMessage(async (msg) => {
  try {
    switch (msg.cmd) {
      case 'scan': send('scan', scan()); break;
      case 'save': {
        let r = { ok: false };
        try { await penpot.currentFile?.saveVersion?.('avant-reconnexion-orphelins'); r = { ok: true }; } catch (e) { r = { ok: false, error: e.message }; }
        send('save', r); break;
      }
      case 'preview': send('preview', { id: msg.id, ...(await preview(msg.id, msg.componentId)) }); break;
      case 'build': send('build', { id: msg.id, ...(await build(msg.id, msg.componentId)) }); break;
      case 'cancel': send('cancel', { id: msg.id, ...cancel(msg.id) }); break;
      case 'commit': send('commit', { id: msg.id, ...commit(msg.id) }); break;
      case 'harvest': send('harvest', { id: msg.id, data: harvests[msg.id] ?? null }); break;
    }
  } catch (e) {
    send('error', { cmd: msg.cmd, id: msg.id, message: String(e?.message ?? e) });
  }
});
