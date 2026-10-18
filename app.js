/* Birdie Book – Notizen pro Golfplatz, Tee und Loch. Alles lokal in IndexedDB. */
'use strict';

const HOLES = 18;
const TEES = [
  { id: 'schwarz', name: 'Schwarz', color: '#1b1b1b' },
  { id: 'weiss',   name: 'Weiß',    color: '#f5f5f2' },
  { id: 'gelb',    name: 'Gelb',    color: '#f2c230' },
  { id: 'blau',    name: 'Blau',    color: '#2f6fd6' },
  { id: 'rot',     name: 'Rot',     color: '#d23b3b' },
];
const SHOT_LABELS = ['Abschlag', '2. Schlag', '3. Schlag'];
const PLACEHOLDERS = [
  'z. B. Holz 3, auf linke Fairwayseite zielen – rechts Aus',
  'z. B. Eisen 7 auf Grünmitte, lieber kurz als lang',
  'z. B. Vorlegen auf ca. 90 m, Wasser vor dem Grün',
];
const GREEN_PLACEHOLDER = 'z. B. Fällt von hinten nach vorne, Putts brechen Richtung See';

/* ---------- Datenbank ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('birdie-book', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('courses')) db.createObjectStore('courses', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  store(mode) { return this.db.transaction('courses', mode).objectStore('courses'); },
  all() { return reqP(this.store('readonly').getAll()); },
  get(id) { return reqP(this.store('readonly').get(id)); },
  put(course) { course.updated = new Date().toISOString(); return txP(s => s.put(course)); },
  del(id) { return txP(s => s.delete(id)); },
  putMany(list) { return txP(s => list.forEach(c => { c.updated = c.updated || new Date().toISOString(); s.put(c); })); },
};
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function txP(fn) {
  return new Promise((res, rej) => {
    const tx = DB.db.transaction('courses', 'readwrite');
    fn(tx.objectStore('courses'));
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}

/* ---------- Datenmodell ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = o => JSON.parse(JSON.stringify(o));
const teeById = id => TEES.find(t => t.id === id);
const emptyHole = () => ({ par: 4, length: '', shots: ['', '', ''], green: '' });
const emptyHoles = () => Array.from({ length: HOLES }, emptyHole);
const shotCount = par => Math.min(3, Math.max(1, par - 2));
const hasNotes = h => h.shots.some(s => s.trim()) || h.green.trim();
const parTotal = holes => holes.reduce((s, h) => s + h.par, 0);

function normHole(h = {}) {
  const par = [3, 4, 5].includes(+h.par) ? +h.par : 4;
  const len = parseInt(h.length, 10);
  return {
    par,
    length: Number.isFinite(len) && len > 0 ? len : '',
    shots: [0, 1, 2].map(i => String((h.shots && h.shots[i]) ?? '')),
    green: String(h.green ?? ''),
  };
}
function normCourse(c) {
  const tees = {};
  for (const t of TEES) {
    const src = c.tees && c.tees[t.id];
    if (src) tees[t.id] = { holes: Array.from({ length: HOLES }, (_, i) => normHole((src.holes || [])[i])) };
  }
  const now = new Date().toISOString();
  return { id: String(c.id || uid()), name: String(c.name || 'Unbenannter Platz').trim(), created: c.created || now, updated: c.updated || now, tees };
}

/* ---------- Zustand ---------- */
const state = { courses: [], course: null, teeId: null, hole: 0, draft: null, dirty: false };
const $app = document.getElementById('app');
const DRAFT_KEY = 'birdie-book-draft';

/* ---------- Hilfsfunktionen UI ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  back: '<svg class="i" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  edit: '<svg class="i" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>',
  up: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 3h14"/></svg>',
};

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/** Dialog. buttons: [{label, value, cls, primary}]. Mit input → {action, value}. Esc → '' */
function modal({ title, text = '', input = null, buttons, stack = false }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<form method="dialog">
      <h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input name="v" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off" enterkeyhint="done">` : ''}
      <div class="modal-btns${stack ? ' stack' : ''}">${buttons.map(b => `<button value="${esc(b.value)}" class="btn ${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div>
    </form>`;
    document.body.append(d);
    const inp = d.querySelector('input');
    const primary = buttons.find(b => b.primary);
    if (inp && primary) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); d.close(primary.value); } });
    d.addEventListener('close', () => {
      const action = d.returnValue || '';
      const value = inp ? inp.value.trim() : undefined;
      d.remove();
      resolve(inp ? { action, value } : action);
    });
    d.showModal();
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}
const confirmBox = (title, text, okLabel = 'OK', danger = false) =>
  modal({ title, text, buttons: [{ label: 'Abbrechen', value: 'cancel' }, { label: okLabel, value: 'ok', cls: danger ? 'danger solid' : 'primary' }] })
    .then(v => v === 'ok');

function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }

/* ---------- Startseite ---------- */
async function showHome() {
  state.courses = (await DB.all()).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  state.course = null; state.teeId = null;
  $app.className = '';
  const list = state.courses.map(c => {
    const tees = TEES.filter(t => c.tees[t.id]);
    const meta = tees.length
      ? tees.map(t => `<span class="tee-dot" style="--tee:${t.color}" title="${t.name}"></span>`).join('') + `<span>${tees.length} Tee${tees.length > 1 ? 's' : ''}</span>`
      : '<span>Noch kein Tee angelegt</span>';
    return `<li><button class="card" data-act="open-course" data-id="${esc(c.id)}">
      <span class="card-title">${esc(c.name)}</span><span class="card-meta">${meta}</span><span class="chev">›</span></button></li>`;
  }).join('');

  $app.innerHTML = `
    <header class="topbar"><h1 class="brand"><img src="icon-192.png" alt=""><span class="t">Birdie Book</span></h1></header>
    <main class="page">
      <section>
        <div class="sec-head"><h2>Golfplätze</h2>
          <button class="btn primary" data-act="new-course">${ICON.plus} Neuer Platz</button></div>
        ${state.courses.length ? `<ul class="list">${list}</ul>` : `
          <div class="empty"><p><strong>Noch keine Plätze angelegt.</strong></p>
          <p class="muted">Lege deinen Heimatplatz an, wähle das Tee und notiere pro Loch, worauf du achten willst.</p></div>`}
      </section>
      <section>
        <h2>Datensicherung</h2>
        <p class="muted">Alle Daten liegen nur auf diesem Gerät. Exportiere ab und zu ein Backup.</p>
        <div class="btn-row">
          <button class="btn" data-act="export-json" ${state.courses.length ? '' : 'disabled'}>${ICON.down} Backup (JSON)</button>
          <button class="btn" data-act="export-csv" ${state.courses.length ? '' : 'disabled'}>${ICON.down} Tabelle (CSV)</button>
          <button class="btn" data-act="import">${ICON.up} Importieren…</button>
        </div>
      </section>
    </main>`;
  window.scrollTo(0, 0);
}

async function newCourse() {
  const r = await modal({
    title: 'Neuer Golfplatz', input: { placeholder: 'Name, z. B. GC Schloss Monrepos' },
    buttons: [{ label: 'Abbrechen', value: 'cancel' }, { label: 'Anlegen', value: 'ok', cls: 'primary', primary: true }],
  });
  if (r.action !== 'ok' || !r.value) return;
  const c = normCourse({ name: r.value });
  await DB.put(c);
  showCourse(c.id);
}

/* ---------- Platz: Tee wählen ---------- */
async function showCourse(id) {
  const c = await DB.get(id);
  if (!c) return showHome();
  state.course = c; state.teeId = null;
  $app.className = '';
  const rows = TEES.map(t => {
    const td = c.tees[t.id];
    const info = td
      ? `Par ${parTotal(td.holes)} · Notizen bei ${td.holes.filter(hasNotes).length} von ${HOLES} Löchern`
      : 'Noch nicht angelegt – antippen zum Anlegen';
    return `<div class="tee-row">
      <button class="tee-card${td ? '' : ' is-new'}" data-act="pick-tee" data-tee="${t.id}">
        <span class="tee-dot lg" style="--tee:${t.color}"></span>
        <span class="tee-name">Tee ${t.name}</span><span class="tee-info">${info}</span><span class="chev">›</span>
      </button>
      ${td ? `<button class="del" data-act="del-tee" data-tee="${t.id}" aria-label="Tee ${t.name} löschen">${ICON.trash}</button>` : ''}
    </div>`;
  }).join('');

  $app.innerHTML = `
    <header class="topbar">
      <button class="iconbtn" data-act="home" aria-label="Zurück">${ICON.back}</button>
      <h1><span class="t">${esc(c.name)}</span></h1>
      <button class="iconbtn" data-act="rename-course" aria-label="Umbenennen">${ICON.edit}</button>
      <button class="iconbtn" data-act="del-course" aria-label="Platz löschen">${ICON.trash}</button>
    </header>
    <main class="page">
      <div class="sec-head"><h2>Von welchem Tee spielst du?</h2></div>
      <div class="tee-list">${rows}</div>
    </main>`;
  window.scrollTo(0, 0);
}

async function pickTee(teeId) {
  const c = state.course;
  if (!c.tees[teeId]) {
    const existing = TEES.filter(t => c.tees[t.id]);
    let holes = emptyHoles();
    if (existing.length) {
      const src = existing[0];
      const v = await modal({
        title: `Tee ${teeById(teeId).name} anlegen`,
        text: `Daten von Tee ${src.name} übernehmen?`, stack: true,
        buttons: [
          { label: 'Par übernehmen', value: 'par', cls: 'primary' },
          { label: 'Par + Notizen übernehmen', value: 'all' },
          { label: 'Leer starten', value: 'empty' },
          { label: 'Abbrechen', value: 'cancel' },
        ],
      });
      if (!v || v === 'cancel') return;
      const sh = c.tees[src.id].holes;
      if (v === 'par') holes = sh.map(h => ({ ...emptyHole(), par: h.par }));
      if (v === 'all') holes = clone(sh).map(h => ({ ...h, length: '' }));
    }
    c.tees[teeId] = { holes };
    await DB.put(c);
  }
  openHoles(teeId, 0);
}

async function deleteTee(teeId) {
  const t = teeById(teeId);
  if (!await confirmBox(`Tee ${t.name} löschen?`, 'Alle Notizen dieses Tees gehen verloren.', 'Löschen', true)) return;
  delete state.course.tees[teeId];
  await DB.put(state.course);
  showCourse(state.course.id);
}

async function renameCourse() {
  const r = await modal({
    title: 'Platz umbenennen', input: { value: state.course.name },
    buttons: [{ label: 'Abbrechen', value: 'cancel' }, { label: 'Speichern', value: 'ok', cls: 'primary', primary: true }],
  });
  if (r.action !== 'ok' || !r.value) return;
  state.course.name = r.value;
  await DB.put(state.course);
  showCourse(state.course.id);
}

async function deleteCourse() {
  if (!await confirmBox(`„${state.course.name}“ löschen?`, 'Der Platz mit allen Tees und Notizen wird entfernt.', 'Löschen', true)) return;
  await DB.del(state.course.id);
  toast('Platz gelöscht');
  showHome();
}

/* ---------- Loch-Ansicht ---------- */
const holesOf = () => state.course.tees[state.teeId].holes;

function openHoles(teeId, hole, draft = null) {
  state.teeId = teeId;
  state.hole = hole;
  state.draft = draft ? normHole(draft) : clone(holesOf()[hole]);
  const t = teeById(teeId);
  $app.className = 'full';
  $app.innerHTML = `
    <header class="topbar">
      <button class="iconbtn" data-act="back-course" aria-label="Zurück zur Tee-Auswahl">${ICON.back}</button>
      <h1><span class="t">${esc(state.course.name)}</span>
        <span class="sub"><span class="tee-dot" style="--tee:${t.color}"></span>Tee ${t.name} · Par <span id="parSum"></span></span></h1>
    </header>
    <div class="hole-layout">
      <nav class="holes" id="holeNav" aria-label="Löcher"></nav>
      <main class="hole-main" id="holeMain"></main>
    </div>`;
  updateDirty();
  renderNav();
  renderHole();
}

function renderNav() {
  const nav = document.getElementById('holeNav');
  if (!nav) return;
  const holes = holesOf();
  nav.innerHTML = holes.map((h, i) => `
    ${i === 0 ? '<div class="hn-sep" style="border:0;margin:0">OUT</div>' : ''}
    ${i === 9 ? '<div class="hn-sep">IN</div>' : ''}
    <button class="hn${i === state.hole ? ' is-active' : ''}${hasNotes(h) ? ' has-notes' : ''}" data-act="go-hole" data-i="${i}"
      aria-current="${i === state.hole ? 'true' : 'false'}" aria-label="Loch ${i + 1}, Par ${h.par}">
      <span class="hn-no">${i + 1}</span><span class="hn-par">Par ${h.par}</span></button>`).join('');
  document.getElementById('parSum').textContent = parTotal(holes);
  const active = nav.querySelector('.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function noteField(key, label, badge, value, placeholder) {
  return `<div class="note">
    <label for="f-${key}"><span class="badge">${badge}</span>${label}</label>
    <textarea id="f-${key}" data-field="${key}" rows="2" placeholder="${esc(placeholder)}" enterkeyhint="enter">${esc(value)}</textarea>
  </div>`;
}

function renderHole(keepScroll = false) {
  const main = document.getElementById('holeMain');
  const h = state.draft;
  const n = state.hole + 1;
  const last = state.hole === HOLES - 1;
  const fields = Array.from({ length: shotCount(h.par) }, (_, i) =>
    noteField('shot' + i, SHOT_LABELS[i], i + 1, h.shots[i], PLACEHOLDERS[i])).join('');
  const scroll = main.scrollTop;

  main.innerHTML = `<div class="hole-inner">
    <div class="hole-head">
      <div><div class="eyebrow">Loch</div><div class="hole-no">${n}</div></div>
      <div class="hole-props">
        <div class="seg" role="group" aria-label="Par">
          ${[3, 4, 5].map(p => `<button data-act="set-par" data-par="${p}" aria-pressed="${h.par === p}">Par ${p}</button>`).join('')}
        </div>
        <label class="len" title="Länge in Metern"><input id="f-length" data-field="length" type="number" inputmode="numeric"
          min="0" max="999" value="${h.length}" placeholder="—" aria-label="Länge in Metern"> m</label>
      </div>
    </div>
    <div class="notes">
      ${fields}
      ${noteField('green', 'Auf dem Grün', '⛳', h.green, GREEN_PLACEHOLDER)}
    </div>
    <div class="unsaved" id="unsaved"></div>
    <div class="actions">
      <button class="btn" data-act="prev-hole" ${state.hole === 0 ? 'disabled' : ''} aria-label="Vorheriges Loch">${ICON.back}</button>
      <button class="btn" id="saveBtn" data-act="save-hole">Speichern</button>
      <button class="btn primary grow" data-act="next-hole">${last ? 'Runde beenden' : 'Weiter →'}</button>
    </div>
  </div>`;
  main.querySelectorAll('textarea').forEach(autosize);
  main.scrollTop = keepScroll ? scroll : 0;
  updateDirty();
}

function updateDirty() {
  state.dirty = !!state.draft && JSON.stringify(state.draft) !== JSON.stringify(holesOf()[state.hole]);
  const b = document.getElementById('saveBtn');
  if (b) { b.disabled = !state.dirty; b.classList.toggle('primary', state.dirty); }
  const u = document.getElementById('unsaved');
  if (u) u.textContent = state.dirty ? '● Ungespeicherte Änderungen' : '';
  if (!state.dirty) clearStoredDraft();
}

async function saveHole() {
  if (!state.dirty) return;
  holesOf()[state.hole] = clone(state.draft);
  await DB.put(state.course);
  clearStoredDraft();
  updateDirty();
  renderNav();
  toast('Gespeichert ✓');
}

/** Fragt bei ungespeicherten Änderungen nach. true = darf weiter. */
async function confirmLeave() {
  if (!state.dirty) return true;
  const v = await modal({
    title: 'Änderungen speichern?',
    text: `Du hast die Notizen zu Loch ${state.hole + 1} geändert.`,
    buttons: [
      { label: 'Verwerfen', value: 'discard', cls: 'danger' },
      { label: 'Abbrechen', value: 'cancel' },
      { label: 'Speichern', value: 'save', cls: 'primary' },
    ],
  });
  if (v === 'save') { await saveHole(); return true; }
  if (v === 'discard') { state.draft = clone(holesOf()[state.hole]); state.dirty = false; clearStoredDraft(); return true; }
  return false;
}

async function goHole(i) {
  if (i < 0 || i >= HOLES || i === state.hole) return;
  if (!await confirmLeave()) return;
  state.hole = i;
  state.draft = clone(holesOf()[i]);
  renderNav();
  renderHole();
}

async function nextHole() {
  if (state.hole < HOLES - 1) return goHole(state.hole + 1);
  if (!await confirmLeave()) return;
  toast('Runde beendet ⛳');
  showCourse(state.course.id);
}

/* Entwurf sichern, falls iOS die App im Hintergrund beendet */
function storeDraft() {
  if (!state.dirty) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ courseId: state.course.id, teeId: state.teeId, hole: state.hole, draft: state.draft }));
  } catch (e) { /* ignorieren */ }
}
function clearStoredDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignorieren */ } }

async function restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
  if (!d) return false;
  const c = await DB.get(d.courseId);
  if (!c || !c.tees[d.teeId] || !(d.hole >= 0 && d.hole < HOLES)) { clearStoredDraft(); return false; }
  const v = await modal({
    title: 'Nicht gespeicherte Notizen',
    text: `Es gibt ungespeicherte Änderungen an Loch ${d.hole + 1} (${c.name}, Tee ${teeById(d.teeId).name}). Wiederherstellen?`,
    buttons: [{ label: 'Verwerfen', value: 'discard', cls: 'danger' }, { label: 'Wiederherstellen', value: 'restore', cls: 'primary' }],
  });
  if (v !== 'restore') { clearStoredDraft(); return false; }
  state.course = c;
  openHoles(d.teeId, d.hole, d.draft);
  return true;
}

/* ---------- Export ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function saveFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  // In der installierten iPhone-App funktionieren Downloads nicht zuverlässig → Teilen-Menü („In Dateien sichern“)
  if (isIOS && navigator.canShare) {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: filename }).catch(() => {});
      return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

function exportJSON() {
  const data = { app: 'birdie-book', version: 1, exported: new Date().toISOString(), courses: state.courses };
  saveFile(`birdie-book-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

const CSV_HEAD = ['Platz', 'Tee', 'Loch', 'Par', 'Laenge_m', 'Abschlag', 'Schlag_2', 'Schlag_3', 'Gruen'];
function csvCell(v) {
  const s = String(v ?? '');
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCSV() {
  const rows = [CSV_HEAD];
  for (const c of state.courses) for (const t of TEES) {
    const td = c.tees[t.id];
    if (!td) continue;
    td.holes.forEach((h, i) => rows.push([c.name, t.name, i + 1, h.par, h.length, h.shots[0], h.shots[1], h.shots[2], h.green]));
  }
  // Semikolon + BOM, damit Excel (deutsch) Umlaute und Spalten korrekt erkennt
  saveFile(`birdie-book-${today()}.csv`, '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n'), 'text/csv');
}

/* ---------- Import ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function teeFromName(name) {
  const n = String(name).trim().toLowerCase().replace('ß', 'ss');
  return TEES.find(t => t.id === n || t.name.toLowerCase().replace('ß', 'ss') === n);
}

async function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Die CSV-Datei enthält keine Daten.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = name => head.indexOf(name.toLowerCase());
  const idx = Object.fromEntries(CSV_HEAD.map(h => [h, col(h)]));
  if (idx.Platz < 0 || idx.Tee < 0 || idx.Loch < 0) throw new Error('Spalten „Platz“, „Tee“ und „Loch“ fehlen.');

  const all = await DB.all();
  const touched = new Map();
  let count = 0;
  for (const r of rows.slice(1)) {
    const name = (r[idx.Platz] || '').trim();
    const tee = teeFromName(r[idx.Tee] || '');
    const hole = parseInt(r[idx.Loch], 10);
    if (!name || !tee || !(hole >= 1 && hole <= HOLES)) continue;
    let c = touched.get(name.toLowerCase()) || all.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!c) c = normCourse({ name });
    touched.set(name.toLowerCase(), c);
    if (!c.tees[tee.id]) c.tees[tee.id] = { holes: emptyHoles() };
    const g = k => (idx[k] >= 0 ? r[idx[k]] ?? '' : '');
    c.tees[tee.id].holes[hole - 1] = normHole({
      par: g('Par'), length: g('Laenge_m'), shots: [g('Abschlag'), g('Schlag_2'), g('Schlag_3')], green: g('Gruen'),
    });
    count++;
  }
  if (!count) throw new Error('Keine gültigen Zeilen gefunden.');
  const ok = await confirmBox('CSV importieren?',
    `${count} Löcher für ${touched.size} Platz/Plätze. Vorhandene Notizen derselben Plätze, Tees und Löcher werden überschrieben.`, 'Importieren');
  if (!ok) return;
  await DB.putMany([...touched.values()]);
  toast(`${count} Löcher importiert`);
}

async function importJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Die Datei ist kein gültiges JSON.'); }
  const list = Array.isArray(data) ? data : data && data.courses;
  if (!Array.isArray(list) || !list.length) throw new Error('Keine Golfplätze in der Datei gefunden.');
  const courses = list.filter(c => c && typeof c === 'object').map(normCourse);
  const existing = new Set((await DB.all()).map(c => c.id));
  const overlap = courses.filter(c => existing.has(c.id)).length;
  const ok = await confirmBox('Backup importieren?',
    `${courses.length} Platz/Plätze gefunden.` + (overlap ? ` ${overlap} davon sind schon vorhanden und werden überschrieben.` : ''), 'Importieren');
  if (!ok) return;
  await DB.putMany(courses);
  toast(`${courses.length} Platz/Plätze importiert`);
}

async function handleImportFile(file) {
  try {
    const text = await file.text();
    if (/\.csv$/i.test(file.name) || (!/\.json$/i.test(file.name) && !text.trim().startsWith('{') && !text.trim().startsWith('['))) await importCSV(text);
    else await importJSON(text);
  } catch (e) {
    await modal({ title: 'Import fehlgeschlagen', text: e.message || String(e), buttons: [{ label: 'OK', value: 'ok', cls: 'primary' }] });
  }
  showHome();
}

/* ---------- Ereignisse ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  switch (act) {
    case 'home': return showHome();
    case 'new-course': return newCourse();
    case 'open-course': return showCourse(el.dataset.id);
    case 'rename-course': return renameCourse();
    case 'del-course': return deleteCourse();
    case 'pick-tee': return pickTee(el.dataset.tee);
    case 'del-tee': return deleteTee(el.dataset.tee);
    case 'export-json': return exportJSON();
    case 'export-csv': return exportCSV();
    case 'import': return document.getElementById('importFile').click();
    case 'back-course': if (await confirmLeave()) showCourse(state.course.id); return;
    case 'go-hole': return goHole(+el.dataset.i);
    case 'prev-hole': return goHole(state.hole - 1);
    case 'next-hole': return nextHole();
    case 'save-hole': return saveHole();
    case 'set-par':
      state.draft.par = +el.dataset.par;
      renderHole(true);
      return;
  }
});

document.addEventListener('input', e => {
  const f = e.target.dataset && e.target.dataset.field;
  if (!f || !state.draft) return;
  const v = e.target.value;
  if (f === 'green') state.draft.green = v;
  else if (f === 'length') { const n = parseInt(v, 10); state.draft.length = n > 0 ? n : ''; }
  else if (f.startsWith('shot')) state.draft.shots[+f.slice(4)] = v;
  if (e.target.tagName === 'TEXTAREA') autosize(e.target);
  updateDirty();
});

document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) handleImportFile(file);
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.draft && document.getElementById('holeMain')) {
    e.preventDefault();
    saveHole();
  }
});

window.addEventListener('beforeunload', e => { if (state.dirty) { storeDraft(); e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') storeDraft(); });
window.addEventListener('resize', () => document.querySelectorAll('.note textarea').forEach(autosize));

/* ---------- Start ---------- */
(async function init() {
  try {
    await DB.open();
  } catch (e) {
    $app.innerHTML = `<main class="page"><h2>Fehler</h2><p>Die lokale Datenbank konnte nicht geöffnet werden (${esc(e && e.message)}).
      Im privaten Modus mancher Browser ist IndexedDB gesperrt.</p></main>`;
    return;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await showHome();
  await restoreDraft();
})();
