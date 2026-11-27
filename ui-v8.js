/* Reconnecter composant orphelin — interface. Parle à plugin-v8.js par messages. Aucun appel réseau. */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const post = (m) => parent.postMessage(m, '*');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3000); }
function download(name, text, mime) {
  const el = document.createElement('a');
  el.href = URL.createObjectURL(new Blob([text], { type: mime || 'application/json' }));
  el.download = name; el.click();
}
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

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

// ── État
const S = { method: 'inplace', scope: 'page', saved: false, data: null, rows: [], built: new Set(), finished: new Set(), results: new Map(), busy: false, abort: false, before: null, undoOk: null };
const tagCls = { MATCH_UNIQUE: 'p', VARIANTE_OK: 'p', CHOIX_MANUEL: 'p', SOURCE_PROBABLE: 'w', MATCH_AMBIGU: 'w', VARIANTE_AMBIGUE: 'w', AUCUN_MATCH: 'f', VARIANTE_ABSENTE: 'f' };
const tagTxt = { MATCH_UNIQUE: 'Source trouvée', VARIANTE_OK: 'Variante exacte', CHOIX_MANUEL: 'Source choisie', SOURCE_PROBABLE: 'Source probable (à confirmer)', MATCH_AMBIGU: 'Plusieurs sources', VARIANTE_AMBIGUE: 'Variante ambiguë', AUCUN_MATCH: 'Source absente', VARIANTE_ABSENTE: 'Variante non trouvée' };
const advice = {
  AUCUN_MATCH: 'Aucune source de ce nom dans les librairies connectées : connectez la librairie (Assets, Libraries) puis relancez la liste.',
  SOURCE_PROBABLE: 'Source approchée à confirmer : cliquez « Utiliser cette source » après contrôle.',
  MATCH_AMBIGU: 'Plusieurs composants portent ce nom : choisissez la source.',
  VARIANTE_AMBIGUE: 'Plusieurs variantes identiques : choisissez à la main.',
  VARIANTE_ABSENTE: 'Aucune variante identique dans la librairie : choisissez la plus proche ou republiez la librairie.',
};

$$('#scope button').forEach((b) => b.onclick = () => {
  S.scope = b.dataset.s;
  $$('#scope button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
});
$$('#method button').forEach((b) => b.onclick = () => {
  S.method = b.dataset.m;
  $$('#method button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#carefulRow').hidden = S.method === 'inplace';
  if (S.data) { renderBar(); }
});
$('#scan').onclick = () => doScan();
$('#save').onclick = async () => {
  $('#save').disabled = true;
  const r = await ask('save');
  $('#save').disabled = false; S.saved = !!r.ok;
  $('#save').textContent = r.ok ? 'Version enregistrée ✓' : 'Échec de la sauvegarde';
};
const careful = () => $('#careful').checked;

// ── Confirmation préalable : 1er clic = armer, 2e clic (dans les 6 s) = exécuter
function armed(btn, label, fn) {
  btn.onclick = () => {
    if (btn.dataset.armed) { clearTimeout(btn._t); delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
    btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }, 6000);
  };
}

async function doScan() {
  if (S.busy) return;
  $('#scan').disabled = true; $('#scan').textContent = 'Lecture en cours…';
  const d = await ask('scan', { scope: S.scope });
  $('#scan').disabled = false; $('#scan').textContent = '1 · Lister les orphelins';
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
      <div class="stat"><b>${s.ready}</b><span>prêtes (${s.inScope} ciblées${s.probable ? ', ' + s.probable + ' à confirmer' : ''})</span></div>
    </div>`;
  renderBar();
  const groups = new Map();
  S.rows.forEach((r) => { if (!groups.has(r.name)) groups.set(r.name, []); groups.get(r.name).push(r); });
  const list = $('#list'); list.innerHTML = '';
  if (!S.rows.length) { list.innerHTML = '<div class="card sm">Aucune racine orpheline dans ce périmètre.</div>'; renderReport(); return; }
  const wrap = document.createElement('div'); wrap.className = 'row'; wrap.style.flexDirection = 'column'; wrap.style.alignItems = 'stretch';
  for (const [name, rows] of groups) {
    const g = document.createElement('div'); g.className = 'group'; g.dataset.group = name;
    const ready = rows.filter((r) => r.componentId).length;
    g.innerHTML = `<div class="ghead"><b class="grow">${esc(name)}</b><span class="pill n">${rows.length}</span>
      <button class="btn sm" data-group ${ready ? '' : 'disabled'}>Reconnecter (${ready})</button></div>`;
    armed(g.querySelector('[data-group]'), 'Confirmer ?', () => runBuild(rows.filter((r) => r.componentId).map((r) => r.id)));
    rows.forEach((r) => g.appendChild(rowEl(r)));
    wrap.appendChild(g);
  }
  list.appendChild(wrap);
  renderReport();
}

function candHtml(r) {
  const vi = r.variantInfo;
  let h = '';
  if (vi) h += `<div class="sm">${vi.variants} variantes${vi.chosen ? ' · variante exacte trouvée' : ' · aucune identique, les plus proches :'}</div>`;
  if (vi && !vi.chosen) {
    h += (vi.best || []).map((b) => `<div class="cand"><div><b>${b.n} écart(s)</b> · ${esc(Object.entries(b.props || {}).map(([k, v]) => k + '=' + v).join(' · '))}${(b.diffs || []).map((x) => '<br>• ' + esc(x)).join('')}</div><button class="btn ghost sm" data-variant="${b.id}">Utiliser cette variante</button></div>`).join('');
  }
  if (!r.componentId && (r.candidates || []).length) {
    h += '<div class="sm">Sources possibles :</div>' + r.candidates.map((c) => `<div class="cand"><div class="meta"><b>${esc(c.name)}</b><span class="pill ${c.confidence === 'moyenne' ? 'w' : 'n'}">${c.score}% · confiance ${c.confidence}</span></div>
      <div>Librairie : ${esc(c.library)}${c.nodes != null ? ` · ${c.orphanNodes} nœuds (orphelin) contre ${c.nodes} (source)` : ''}</div>
      <button class="btn ghost sm" data-source="${c.compId}">Utiliser cette source</button></div>`).join('');
  }
  if (h) h += '<div class="msg">Choix manuel : vérifiez l\'aperçu avant / après avant de reconnecter.</div>';
  return h;
}

function rowEl(r) {
  const d = document.createElement('div'); d.className = 'item'; d.id = 'row-' + r.id;
  const can = !!r.componentId;
  d.innerHTML = `<div class="row"><span class="pill ${tagCls[r.status] || 'n'}">${tagTxt[r.status] || r.status}</span>${r.library ? `<span class="sm">${esc(r.library)}</span>` : ''}</div>
    ${candHtml(r)}
    <div class="acts">
      <button class="btn ghost sm" data-a="preview" ${can ? '' : 'disabled'}>Aperçu avant / après</button>
      <button class="btn sm" data-a="build" ${can ? '' : 'disabled'}>Reconnecter</button>
      <button class="text-btn" data-a="harvest">Valeurs (JSON)</button>
    </div>
    <div class="acts" data-conf hidden>
      <button class="btn danger sm" data-a="commit">Valider : supprimer l'orphelin masqué</button>
      <button class="btn ghost sm" data-a="cancel">Annuler (réafficher l'orphelin)</button>
    </div>
    <div data-prev hidden></div>
    <div class="msg" data-out hidden></div>`;
  d.querySelectorAll('[data-variant]').forEach((b) => b.onclick = () => {
    r.componentId = b.dataset.variant; r.status = 'CHOIX_MANUEL';
    d.replaceWith(rowEl(r)); renderBar(); renderReport();
  });
  d.querySelectorAll('[data-source]').forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Analyse…';
    const m = await ask('rematch', { id: r.id, compId: b.dataset.source });
    if (m.error) { b.disabled = false; b.textContent = 'Utiliser cette source'; return toast('⚠ ' + m.error); }
    r.status = m.status; r.componentId = m.componentId; r.variantInfo = m.variantInfo; r.library = m.library;
    if (m.componentId) r.candidates = [];
    d.replaceWith(rowEl(r)); renderBar(); renderReport();
  });
  d.querySelectorAll('[data-a]').forEach((b) => {
    if (b.dataset.a === 'build') armed(b, 'Confirmer ?', () => rowAction(r, 'build'));
    else b.onclick = () => rowAction(r, b.dataset.a);
  });
  return d;
}
const rowNode = (id) => document.querySelector('#row-' + CSS.escape(id));
function setOut(id, kind, text, detail) {
  const el = rowNode(id)?.querySelector('[data-out]'); if (!el) return;
  el.hidden = false; el.className = 'msg ' + (kind || '');
  el.innerHTML = esc(text) + (detail ? '<details><summary>Détails</summary><pre>' + esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)) + '</pre></details>' : '');
}
function showConf(id, on) { const c = rowNode(id)?.querySelector('[data-conf]'); if (c) c.hidden = !on; }

async function rowAction(r, a) {
  if (a === 'build') return runBuild([r.id]);
  if (a === 'preview') return showPreview(r);
  if (a === 'harvest') {
    const m = await ask('harvest', { id: r.id });
    if (!m.data) return setOut(r.id, 'ko', 'Aucune valeur enregistrée : lancez « Reconnecter » d\'abord.');
    return download('valeurs-' + r.id + '.json', JSON.stringify(m.data, null, 2));
  }
  if (a === 'commit') return commitIds([r.id]);
  if (a === 'cancel') return cancelIds([r.id]);
}

// ── Aperçu avant / après
async function showPreview(r) {
  const box = rowNode(r.id)?.querySelector('[data-prev]'); if (!box) return;
  box.hidden = false; box.innerHTML = '<div class="msg">Aperçu en cours (rien n\'est modifié, une instance temporaire est créée hors zone puis supprimée)…</div>';
  const m = await ask('preview', { id: r.id, componentId: r.componentId });
  if (m.error) { box.innerHTML = `<div class="msg ko">✗ ${esc(m.error)}</div>`; return; }
  const img = (src, t) => `<figure><figcaption>${t}</figcaption><div class="frame">${src ? `<img alt="${t}" src="${src}">` : '<span class="none">Export indisponible</span>'}</div></figure>`;
  const lines = (m.lines || []).map((l) => `<li>${esc(l.text)}</li>`).join('') + (m.problems || []).map((p) => `<li class="ko">${esc(p.path || '/')} : ${esc(p.why)}</li>`).join('');
  box.innerHTML = `<div class="imgs">${img(m.before, 'Avant (orphelin)')}${img(m.after, 'Après (reconnecté)')}</div>
    <ul class="lines">${lines || '<li>Aucun contenu modifié à reporter : l\'instance du composant est identique.</li>'}</ul>
    ${(m.problems || []).length ? '<div class="msg ko">Éléments qui ne seront pas reconnectés : structure différente du composant. La reconnexion sera refusée.</div>' : ''}`;
}

// ── Reconnexion : une racine à la fois, interruptible, arrêt à la première erreur
async function runBuild(ids) {
  if (S.busy) return;
  const todo = ids.filter((id) => !S.built.has(id) && !S.finished.has(id));
  if (!todo.length) return;
  S.busy = true; S.abort = false; renderBar();
  const inplace = S.method === 'inplace';
  if (inplace && !S.saved) {
    toast('Enregistrement d\'une version du fichier…');
    const sv = await ask('save'); S.saved = !!sv.ok;
    if (!sv.ok) { S.busy = false; renderBar(); return toast('⚠ Sauvegarde impossible : reconnexion annulée. Sauvegardez à la main puis réessayez.'); }
  }
  // un seul « Ctrl+Z » annule tout le lot, quand l'API le permet
  if (inplace) { const u = await ask('undoBegin'); S.undoOk = !!u.ok; }
  const done = [];
  for (const id of todo) {
    if (S.abort) { toast('Lot interrompu : les racines déjà traitées sont conservées.'); break; }
    const r = S.rows.find((x) => x.id === id);
    if (!r || !r.componentId) continue;
    setOut(id, '', inplace ? 'Valeurs enregistrées… sonde sur un clone… reconnexion…' : 'Valeurs enregistrées… reconnexion en cours…');
    const m = await ask(inplace ? 'swap' : 'build', { id, componentId: r.componentId });
    const { type, id: _i, ...rest } = m;
    const rec = (etat, detail) => S.results.set(id, { id, nom: r.name, source: r.library, methode: inplace ? 'en place' : 'remplacement', etat, detail });
    if (inplace) {
      if (m.swapped && m.ok) {
        S.finished.add(id); done.push(id);
        setOut(id, 'ok', `✓ Reconnectée en place · ${m.appliedCount} valeur(s) conservée(s)${m.idChanged ? ' · id changé' : ''}${m.orderMatches ? '' : ' · ordre à contrôler'}${m.sizeOk ? '' : ' · taille différente'}`, rest);
        rec('reconnectée', m.sizeOk ? '' : 'taille différente après reconnexion');
      } else {
        if (m.swapped) S.finished.add(id);
        const why = m.error || m.note || 'Échec';
        setOut(id, 'ko', '✗ ' + why, rest); rec('échec', why);
        toast(m.needsUndo ? 'Arrêt : Ctrl+Z puis contrôle visuel.' : 'Lot arrêté à la première erreur.');
        break;
      }
    } else if (m.built && m.ok) {
      S.built.add(id); done.push(id);
      if (careful()) showConf(id, true);
      setOut(id, 'ok', `✓ Reconnectée au bon composant · ${m.appliedCount} valeur(s) conservée(s)${m.orderMatches ? '' : ' · ordre à contrôler'}${m.sizeOk ? '' : ' · taille différente'}`, rest);
      rec('reconnectée', '');
    } else {
      const why = m.error || 'Échec';
      setOut(id, 'ko', '✗ ' + why, rest); rec('échec', why);
      if (todo.length > 1) { toast('Lot arrêté à la première erreur.'); break; }
    }
  }
  if (inplace) await ask('undoEnd');
  S.busy = false;
  const h = await ask('harvestAll');
  if (h.data && Object.keys(h.data).length) download('valeurs-orphelins-' + stamp() + '.json', JSON.stringify(h.data, null, 2));
  if (!inplace && done.length && !careful()) await commitIds(done);
  else if (!inplace && done.length) toast(done.length + ' reconnectée(s), orphelin(s) masqué(s). Contrôlez, puis validez ou annulez.');
  else if (inplace && done.length) toast(done.length + ' racine(s) reconnectée(s) en place.' + (S.undoOk ? ' Ctrl+Z annule tout le lot.' : ' Ctrl+Z annule pas à pas.'));
  renderBar(); renderReport();
}

async function commitIds(ids) {
  const good = ids.filter((id) => S.built.has(id));
  if (!good.length) return;
  S.busy = true; renderBar();
  const m = await ask('commitMany', { ids: good });
  S.busy = false;
  let n = 0;
  (m.results || []).forEach((x) => {
    if (x.requested) { n++; S.built.delete(x.id); S.finished.add(x.id); showConf(x.id, false); setOut(x.id, 'ok', 'Orphelin supprimé. Contrôle visuel dans l\'UI, puis relancez la liste quand le plugin répond.'); }
    else setOut(x.id, 'ko', '✗ ' + x.error);
  });
  if (m.error) toast('⚠ ' + m.error);
  renderBar(); renderReport();
  if (n) toast(n + ' orphelin(s) supprimé(s). Le plugin peut geler un moment : ne relancez rien.');
}
async function cancelIds(ids) {
  const good = ids.filter((id) => S.built.has(id));
  if (!good.length) return;
  const m = await ask('cancelMany', { ids: good });
  (m.results || []).forEach((x) => {
    if (x.removed) { S.built.delete(x.id); S.results.delete(x.id); showConf(x.id, false); setOut(x.id, '', 'Annulé : instance neuve supprimée, orphelin réaffiché et intact.'); }
    else if (x.error) setOut(x.id, 'ko', '✗ ' + x.error);
  });
  renderBar(); renderReport();
}

// ── Barre de lot
function renderBar() {
  const bar = $('#bar');
  if (!S.data) { bar.hidden = true; return; }
  bar.hidden = false;
  const ip = S.method === 'inplace';
  const ready = S.rows.filter((r) => r.componentId && !S.built.has(r.id) && !S.finished.has(r.id)).length;
  const built = S.built.size;
  bar.innerHTML = `<div class="row"><b class="grow">Lot</b><span class="pill ${ready ? 'p' : 'n'}">${ready} prête(s)</span>${ip ? `<span class="pill ${S.finished.size ? 'p' : 'n'}">${S.finished.size} reconnectée(s)</span>` : `<span class="pill ${built ? 'w' : 'n'}">${built} en attente de validation</span>`}</div>
    <div class="acts row">
      <button class="btn" id="b-build" ${ready && !S.busy ? '' : 'disabled'}>Reconnecter le lot (${ready})</button>
      ${S.busy ? '<button class="btn warn" id="b-stop">Interrompre</button>' : ''}
      ${ip ? '' : `<button class="btn danger" id="b-commit" ${built && !S.busy ? '' : 'disabled'}>Valider le lot (${built})</button>
      <button class="btn ghost" id="b-cancel" ${built && !S.busy ? '' : 'disabled'}>Annuler le lot</button>`}
    </div>
    <div class="sm">${ip ? 'En place : la racine garde son id, sa place et sa mise en page. Une sonde sur un clone précède chaque reconnexion et une version du fichier est enregistrée avant la première. Annulation : « Interrompre » arrête le lot après la racine en cours ; Ctrl+Z annule ensuite le lot (en une fois si l\'API le permet).' : 'Remplacement : « Annuler le lot » réaffiche les orphelins et supprime les instances neuves tant que vous n\'avez pas validé.'}</div>`;
  armed($('#b-build'), 'Confirmer le lot ?', () => runBuild(S.rows.filter((r) => r.componentId).map((r) => r.id)));
  if (S.busy) $('#b-stop').onclick = () => { S.abort = true; $('#b-stop').disabled = true; $('#b-stop').textContent = 'Arrêt après la racine en cours…'; };
  if (!ip) { $('#b-commit').onclick = () => commitIds([...S.built]); $('#b-cancel').onclick = () => cancelIds([...S.built]); }
}

// ── Rapport : reconnectées, échecs, éléments non reconnectés
function reportData() {
  const res = [...S.results.values()];
  const notDone = S.rows.filter((r) => !S.finished.has(r.id) && !S.built.has(r.id) && !res.some((x) => x.id === r.id && x.etat === 'reconnectée'))
    .filter((r) => !res.some((x) => x.id === r.id && x.etat === 'échec'))
    .map((r) => ({ id: r.id, nom: r.name, statut: tagTxt[r.status] || r.status, action: advice[r.status] || (r.componentId ? 'Prête : non traitée dans cette session.' : '') }));
  return {
    date: new Date().toISOString(), page: S.data?.summary.page, perimetre: S.scope, methode: S.method === 'inplace' ? 'en place' : 'remplacement',
    compteurs: { avant: S.before, apres: S.data ? { roots: S.data.summary.orphanRoots, nodes: S.data.summary.orphanNodes, instances: S.data.summary.instances } : null },
    reconnectees: res.filter((x) => x.etat === 'reconnectée'), echecs: res.filter((x) => x.etat === 'échec'), nonReconnectees: notDone,
  };
}
function reportText(d) {
  const L = [`Rapport de reconnexion des composants orphelins`, `Page : ${d.page} · périmètre : ${d.perimetre} · méthode : ${d.methode}`, `Date : ${d.date}`, ''];
  L.push(`Reconnectées (${d.reconnectees.length})`); d.reconnectees.forEach((x) => L.push(`  - ${x.nom}${x.detail ? ' : ' + x.detail : ''}`));
  L.push('', `Échecs (${d.echecs.length})`); d.echecs.forEach((x) => L.push(`  - ${x.nom} : ${x.detail}`));
  L.push('', `Non reconnectées (${d.nonReconnectees.length})`); d.nonReconnectees.forEach((x) => L.push(`  - ${x.nom} [${x.statut}] ${x.action}`));
  return L.join('\n');
}
function renderReport() {
  const box = $('#report');
  if (!S.data) { box.hidden = true; return; }
  const d = reportData();
  box.hidden = false;
  const li = (a, f) => a.length ? '<ul class="rep-list">' + a.slice(0, 12).map(f).join('') + (a.length > 12 ? `<li>… et ${a.length - 12} autre(s) dans le fichier</li>` : '') + '</ul>' : '';
  box.innerHTML = `<div class="row"><b class="grow">Rapport</b><span class="pill p">${d.reconnectees.length} reconnectée(s)</span><span class="pill ${d.echecs.length ? 'f' : 'n'}">${d.echecs.length} échec(s)</span><span class="pill ${d.nonReconnectees.length ? 'w' : 'n'}">${d.nonReconnectees.length} non reconnectée(s)</span></div>
    ${d.echecs.length ? '<div class="sm">Échecs</div>' + li(d.echecs, (x) => `<li><b>${esc(x.nom)}</b> : ${esc(x.detail)}</li>`) : ''}
    ${d.nonReconnectees.length ? '<div class="sm">Éléments non reconnectés</div>' + li(d.nonReconnectees, (x) => `<li><b>${esc(x.nom)}</b> [${esc(x.statut)}] ${esc(x.action)}</li>`) : ''}
    <div class="acts row"><button class="btn ghost sm" id="r-txt">Télécharger (.txt)</button><button class="btn ghost sm" id="r-json">Télécharger (.json)</button></div>`;
  $('#r-txt').onclick = () => download('rapport-orphelins-' + stamp() + '.txt', reportText(reportData()), 'text/plain');
  $('#r-json').onclick = () => download('rapport-orphelins-' + stamp() + '.json', JSON.stringify(reportData(), null, 2));
}
