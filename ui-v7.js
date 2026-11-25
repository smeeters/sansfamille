/* Reconnecter les orphelins — interface. Parle à plugin-v7.js par messages. */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const post = (m) => parent.postMessage(m, '*');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }

// ── Appels au plugin : une réponse par (commande, id)
const waiters = new Map();
function ask(cmd, payload = {}, timeout = 180000) {
  return new Promise((resolve) => {
    const key = cmd + (payload.id ? ':' + payload.id : '');
    const timer = setTimeout(() => { waiters.delete(key); resolve({ error: 'Pas de réponse du plugin (' + cmd + '). Attendez ~60 s puis relisez, sans rejouer d\'écriture.' }); }, timeout);
    waiters.set(key, (m) => { clearTimeout(timer); resolve(m); });
    post({ cmd, ...payload });
  });
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || !m.type) return;
  const key = m.type === 'error' ? m.cmd + (m.id ? ':' + m.id : '') : m.type + (m.id ? ':' + m.id : '');
  const w = waiters.get(key);
  if (!w) return;
  waiters.delete(key);
  w(m.type === 'error' ? { error: m.message } : m);
});

// ── Confirmation préalable : 1er clic = armer, 2e clic (dans les 6 s) = exécuter
function armed(btn, label, fn) {
  btn.onclick = () => {
    if (btn.dataset.armed) { clearTimeout(btn._t); delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
    btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }, 6000);
  };
}
const careful = () => $('#careful').checked;

// ── État
const S = { method: 'inplace', saved: false, finished: new Set(), scope: 'page', data: null, rows: [], built: new Set(), busy: false, removed: 0, before: null };
const tagCls = { MATCH_UNIQUE: 'p', VARIANTE_OK: 'p', MATCH_AMBIGU: 'w', VARIANTE_AMBIGUE: 'w', AUCUN_MATCH: 'f', VARIANTE_ABSENTE: 'f' };
const tagTxt = { MATCH_UNIQUE: 'Match unique', VARIANTE_OK: 'Variante exacte', MATCH_AMBIGU: 'Match ambigu', VARIANTE_AMBIGUE: 'Variante ambiguë', AUCUN_MATCH: 'Source absente', VARIANTE_ABSENTE: 'Variante non trouvée' };

$$('#scope button').forEach((b) => b.onclick = () => {
  S.scope = b.dataset.s;
  $$('#scope button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
});
$$('#method button').forEach((b) => b.onclick = () => {
  S.method = b.dataset.m;
  $$('#method button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#carefulRow').hidden = S.method === 'inplace';
  if (S.data) { render(); }
});
$('#scan').onclick = () => doScan();
$('#save').onclick = async () => {
  $('#save').disabled = true;
  const r = await ask('save');
  $('#save').disabled = false;
  $('#save').textContent = r.ok ? 'Version enregistrée ✓' : 'Échec de la sauvegarde';
};

async function doScan() {
  if (S.busy) return;
  $('#scan').disabled = true; $('#scan').textContent = 'Scan en cours…';
  const d = await ask('scan', { scope: S.scope });
  $('#scan').disabled = false; $('#scan').textContent = 'Scanner';
  if (d.error) return toast('⚠ ' + d.error);
  if (!S.before) S.before = { roots: d.summary.orphanRoots, nodes: d.summary.orphanNodes, instances: d.summary.instances };
  S.data = d; S.rows = d.rows; S.built = new Set(); S.finished = new Set();
  render();
}

// ── Rendu
function render() {
  const s = S.data.summary;
  const sum = $('#sum'); sum.hidden = false;
  const delta = S.before && S.before.roots !== s.orphanRoots ? ` <span class="pill p">${S.before.roots} → ${s.orphanRoots} racines</span>` : '';
  sum.innerHTML = `<div class="sm">Page <b>${esc(s.page)}</b> · périmètre : ${s.scope === 'selection' ? 'sélection' : 'page entière'}${delta}</div>
    <div class="stats">
      <div class="stat"><b>${s.instances}</b><span>instances</span></div>
      <div class="stat"><b>${s.orphanRoots}</b><span>racines orphelines</span></div>
      <div class="stat"><b>${s.orphanNodes}</b><span>nœuds orphelins</span></div>
      <div class="stat"><b>${s.ready}</b><span>prêtes (${s.inScope} ciblées)</span></div>
    </div>`;
  renderBar();

  const groups = new Map();
  S.rows.forEach((r) => { if (!groups.has(r.name)) groups.set(r.name, []); groups.get(r.name).push(r); });
  const list = $('#list'); list.innerHTML = '';
  if (!S.rows.length) { list.innerHTML = '<div class="card sm">Aucune racine orpheline dans ce périmètre.</div>'; return; }
  const wrap = document.createElement('div'); wrap.className = 'row'; wrap.style.flexDirection = 'column'; wrap.style.alignItems = 'stretch';
  for (const [name, rows] of groups) {
    const g = document.createElement('div'); g.className = 'group';
    const ready = rows.filter((r) => r.componentId).length;
    g.innerHTML = `<div class="ghead"><b class="grow">${esc(name)}</b><span class="pill n">${rows.length}</span>
      <button class="btn sm" data-group ${ready ? '' : 'disabled'}>Reconnecter (${ready})</button></div>`;
    armed(g.querySelector('[data-group]'), 'Confirmer ?', () => runBuild(rows.filter((r) => r.componentId).map((r) => r.id)));
    rows.forEach((r) => g.appendChild(rowEl(r)));
    wrap.appendChild(g);
  }
  list.appendChild(wrap);
}

function rowEl(r) {
  const d = document.createElement('div'); d.className = 'item'; d.id = 'row-' + r.id;
  const vi = r.variantInfo;
  const cands = vi && !vi.chosen ? (vi.best || []).map((b) => `<div class="cand"><div><b>${b.n} écart(s)</b> · ${esc(Object.entries(b.props || {}).map(([k, v]) => k + '=' + v).join(' · '))}${(b.diffs || []).map((x) => '<br>• ' + esc(x)).join('')}</div><button class="btn ghost sm" data-pick="${b.id}">Utiliser</button></div>`).join('') +
    '<div class="msg">« Utiliser » = choix manuel, hors garde-fou : vérifiez le résultat à l\'œil avant de valider.</div>' : '';
  d.innerHTML = `<div class="row"><span class="pill ${tagCls[r.status] || 'n'}">${tagTxt[r.status] || r.status}</span>
      ${vi ? `<span class="sm">${vi.variants} variantes</span>` : ''}</div>
    ${cands}
    <div class="acts">
      <button class="btn ghost sm" data-a="preview" ${r.componentId ? '' : 'disabled'}>Aperçu du delta</button>
      <button class="btn sm" data-a="build" ${r.componentId ? '' : 'disabled'}>Reconnecter</button>
      <button class="text-btn" data-a="harvest">Harvest JSON</button>
    </div>
    <div class="acts" data-conf hidden>
      <button class="btn danger sm" data-a="commit">Valider : supprimer l'orphelin masqué</button>
      <button class="btn ghost sm" data-a="cancel">Annuler (réafficher l'orphelin)</button>
    </div>
    <div class="msg" data-out hidden></div>`;
  d.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
    r.componentId = b.dataset.pick;
    d.querySelectorAll('[data-a="preview"],[data-a="build"]').forEach((x) => (x.disabled = false));
    d.querySelectorAll('[data-pick]').forEach((x) => (x.textContent = x === b ? 'Choisie ✓' : 'Utiliser'));
    renderBar();
  });
  d.querySelectorAll('[data-a]').forEach((b) => {
    if (b.dataset.a === 'build') armed(b, 'Confirmer ?', () => rowAction(r, 'build'));
    else b.onclick = () => rowAction(r, b.dataset.a);
  });
  return d;
}

function setOut(id, kind, text, detail) {
  const el = document.querySelector('#row-' + CSS.escape(id) + ' [data-out]');
  if (!el) return;
  el.hidden = false; el.className = 'msg ' + (kind || '');
  el.innerHTML = esc(text) + (detail ? '<details><summary>Détails</summary><pre>' + esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)) + '</pre></details>' : '');
}
function showConf(id, on) { const c = document.querySelector('#row-' + CSS.escape(id) + ' [data-conf]'); if (c) c.hidden = !on; }

async function rowAction(r, a) {
  if (a === 'build') return runBuild([r.id]);
  if (a === 'preview') {
    setOut(r.id, '', 'Aperçu en cours…');
    const m = await ask('preview', { id: r.id, componentId: r.componentId });
    const { type, id, ...rest } = m;
    setOut(r.id, rest.error || (rest.problems && rest.problems.length) ? 'ko' : '', rest.error ? rest.error : `${(rest.swaps || []).length} icône(s) à échanger · ${(rest.ops || []).length} override(s) · ${(rest.problems || []).length} problème(s)`, rest);
  } else if (a === 'harvest') {
    const m = await ask('harvest', { id: r.id });
    if (!m.data) return setOut(r.id, 'ko', 'Aucune valeur enregistrée : lancez « Reconnecter » d\'abord.');
    const el = document.createElement('a');
    el.href = URL.createObjectURL(new Blob([JSON.stringify(m.data, null, 2)], { type: 'application/json' }));
    el.download = 'harvest-' + r.id + '.json'; el.click();
  } else if (a === 'commit') await commitIds([r.id]);
  else if (a === 'cancel') await cancelIds([r.id]);
}

// ── Reconnexion en place : une racine à la fois, arrêt à la première erreur (lot)
async function runBuild(ids) {
  if (S.busy) return;
  const todo = ids.filter((id) => !S.built.has(id) && !S.finished.has(id));
  if (!todo.length) return;
  S.busy = true; renderBar();
  const inplace = S.method === 'inplace';
  if (inplace && !S.saved) {                       // filet de sécurité avant la première reconnexion en place
    toast('Enregistrement d\'une version du fichier…');
    const sv = await ask('save'); S.saved = !!sv.ok;
    if (!sv.ok) { S.busy = false; renderBar(); return toast('⚠ Sauvegarde impossible : reconnexion annulée. Sauvegardez à la main puis réessayez.'); }
  }
  const done = [];
  for (const id of todo) {
    const r = S.rows.find((x) => x.id === id);
    if (!r || !r.componentId) continue;
    setOut(id, '', inplace ? 'Valeurs enregistrées… sonde sur un clone… reconnexion…' : 'Valeurs enregistrées… reconnexion en cours…');
    const m = await ask(inplace ? 'swap' : 'build', { id, componentId: r.componentId });
    const { type, id: _i, ...rest } = m;
    if (inplace) {
      if (m.swapped && m.ok) {
        S.finished.add(id); done.push(id);
        setOut(id, 'ok', `✓ Reconnectée en place · ${m.appliedCount} valeur(s) appliquée(s)${m.idChanged ? ' · id changé' : ''}${m.orderMatches ? '' : ' · ordre à contrôler'}${m.sizeOk ? '' : ' · taille différente'}`, rest);
      } else {
        if (m.swapped) S.finished.add(id);            // swap fait mais vérification douteuse : ne pas rejouer
        setOut(id, 'ko', '✗ ' + (m.error || m.note || 'Échec'), rest);
        toast(m.needsUndo ? 'Arrêt : Ctrl+Z puis contrôle visuel.' : 'Lot arrêté à la première erreur.');
        break;
      }
    } else if (m.built && m.ok) {
      S.built.add(id); done.push(id);
      if (careful()) showConf(id, true);
      setOut(id, 'ok', `✓ Reconnectée au bon composant · ${m.appliedCount} valeur(s) appliquée(s)${m.orderMatches ? '' : ' · ordre à contrôler'}${m.sizeOk ? '' : ' · taille différente'}`, rest);
    } else {
      setOut(id, 'ko', '✗ ' + (m.error || 'Échec'), rest);
      if (todo.length > 1) { toast('Lot arrêté à la première erreur.'); break; }
    }
  }
  S.busy = false;
  const h = await ask('harvestAll');                 // les valeurs de l'orphelin, dans un fichier
  if (h.data && Object.keys(h.data).length) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const el = document.createElement('a');
    el.href = URL.createObjectURL(new Blob([JSON.stringify(h.data, null, 2)], { type: 'application/json' }));
    el.download = `valeurs-orphelins-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    el.click();
  }
  if (!inplace && done.length && !careful()) await commitIds(done);
  else if (!inplace && done.length) toast(done.length + ' reconnectée(s), orphelin(s) masqué(s). Contrôlez, puis validez.');
  else if (inplace && done.length) toast(done.length + ' racine(s) reconnectée(s) en place. Relancez le scan pour vérifier les compteurs.');
  renderBar();
}

async function commitIds(ids) {
  const good = ids.filter((id) => S.built.has(id));
  if (!good.length) return;
  S.busy = true; renderBar();
  const m = await ask('commitMany', { ids: good });
  S.busy = false;
  let n = 0;
  (m.results || []).forEach((x) => {
    if (x.requested) { n++; S.built.delete(x.id); showConf(x.id, false); setOut(x.id, 'ok', 'Orphelin supprimé. Contrôle visuel dans l\'UI, puis relancez le scan quand le plugin répond.'); }
    else setOut(x.id, 'ko', '✗ ' + x.error);
  });
  if (m.error) toast('⚠ ' + m.error);
  renderBar();
  if (n) toast(n + ' orphelin(s) supprimé(s). Le plugin peut geler un moment : ne relancez rien.');
}
async function cancelIds(ids) {
  const good = ids.filter((id) => S.built.has(id));
  if (!good.length) return;
  const m = await ask('cancelMany', { ids: good });
  (m.results || []).forEach((x) => { if (x.removed) { S.built.delete(x.id); showConf(x.id, false); setOut(x.id, '', 'Instance neuve supprimée, orphelin intact.'); } else if (x.error) setOut(x.id, 'ko', '✗ ' + x.error); });
  renderBar();
}

// ── Barre de lot
function renderBar() {
  const bar = $('#bar');
  if (!S.data) { bar.hidden = true; return; }
  bar.hidden = false;
  const ready = S.rows.filter((r) => r.componentId && !S.built.has(r.id) && !S.finished.has(r.id)).length;
  const built = S.built.size;
  const ip = S.method === 'inplace';
  bar.innerHTML = `<div class="row"><b class="grow">Lot</b><span class="pill ${ready ? 'p' : 'n'}">${ready} prête(s)</span>${ip ? `<span class="pill ${S.finished.size ? 'p' : 'n'}">${S.finished.size} reconnectée(s)</span>` : `<span class="pill ${built ? 'w' : 'n'}">${built} en attente de validation</span>`}</div>
    <div class="acts row">
      <button class="btn" id="b-build" ${ready && !S.busy ? '' : 'disabled'}>Reconnecter le lot (${ready})</button>
      ${ip ? '' : `<button class="btn danger" id="b-commit" ${built && !S.busy ? '' : 'disabled'}>Valider le lot (${built})</button>
      <button class="btn ghost" id="b-cancel" ${built && !S.busy ? '' : 'disabled'}>Annuler le lot</button>`}
    </div>
    <div class="sm">${ip ? 'En place : la racine garde son id, sa place et sa mise en page. Sonde sur un clone avant chaque reconnexion, une version du fichier est enregistrée avant la première. Le lot s\'arrête à la première erreur.' : 'Remplacement : le lot s\'arrête à la première erreur ; hors mode prudent, les orphelins reconnectés sont supprimés à la fin du lot.'}</div>`;
  armed($('#b-build'), 'Confirmer le lot ?', () => runBuild(S.rows.filter((r) => r.componentId).map((r) => r.id)));
  if (!ip) { $('#b-commit').onclick = () => commitIds([...S.built]); $('#b-cancel').onclick = () => cancelIds([...S.built]); }
}
