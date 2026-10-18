/* Birdie Book – Notizen und Fotos pro Golfplatz, Tee und Loch. Alles lokal in IndexedDB. */
'use strict';

const APP_VERSION = '2.1';
const HOLES = 18;
const TEES = [
  { id: 'schwarz', name: 'Schwarz', color: '#1b1b1b' },
  { id: 'weiss',   name: 'Weiß',    color: '#f5f5f2' },
  { id: 'gelb',    name: 'Gelb',    color: '#f2c230' },
  { id: 'blau',    name: 'Blau',    color: '#2f6fd6' },
  { id: 'rot',     name: 'Rot',     color: '#d23b3b' },
];
const SLOTS = ['shot0', 'shot1', 'shot2', 'green', 'book'];
const SHOT_LABELS = ['Abschlag', '2. Schlag', '3. Schlag'];
const PLACEHOLDERS = [
  'z. B. Holz 3, auf linke Fairwayseite zielen – rechts Aus',
  'z. B. Eisen 7 auf Grünmitte, lieber kurz als lang',
  'z. B. Vorlegen auf ca. 90 m, Wasser vor dem Grün',
];
const GREEN_PLACEHOLDER = 'z. B. Fällt von hinten nach vorne, Putts brechen Richtung See';
const PHOTO_MAX_PX = { book: 2400, other: 1600 };
const DRAFT_KEY = 'birdie-book-draft';
const PHOTOS_KEY = 'birdie-book-show-photos';

/* ---------- Datenbank ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('birdie-book', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('courses')) db.createObjectStore('courses', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  ro(name) { return this.db.transaction(name, 'readonly').objectStore(name); },
  // Beim Lesen immer normalisieren – so funktionieren auch Plätze aus älteren Versionen (z. B. ohne Fotos)
  async all() { return (await reqP(this.ro('courses').getAll())).map(normCourse); },
  async get(id) { const c = await reqP(this.ro('courses').get(id)); return c ? normCourse(c) : c; },
  put(course) { course.updated = new Date().toISOString(); return txP('courses', s => s.put(course)); },
  del(id) { return txP('courses', s => s.delete(id)); },
  putMany(list) { return txP('courses', s => list.forEach(c => s.put(c))); },
  photo(id) { return reqP(this.ro('photos').get(id)); },
  putPhoto(rec) { return txP('photos', s => s.put(rec)); },
  putPhotos(list) { return txP('photos', s => list.forEach(p => s.put(p))); },
  delPhotos(ids) { return ids.length ? txP('photos', s => ids.forEach(id => s.delete(id))) : Promise.resolve(); },
};
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function txP(name, fn) {
  return new Promise((res, rej) => {
    const tx = DB.db.transaction(name, 'readwrite');
    fn(tx.objectStore(name));
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}

/* ---------- Datenmodell ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = o => JSON.parse(JSON.stringify(o));
const teeById = id => TEES.find(t => t.id === id);
const emptyPhotos = () => Object.fromEntries(SLOTS.map(s => [s, []]));
const emptyHole = () => ({ par: 4, length: '', shots: ['', '', ''], green: '', photos: emptyPhotos() });
const emptyHoles = () => Array.from({ length: HOLES }, emptyHole);
const shotCount = par => Math.min(3, Math.max(1, par - 2));
const holePhotoIds = h => SLOTS.flatMap(s => h.photos[s]);
const hasNotes = h => h.shots.some(s => s.trim()) || h.green.trim() || holePhotoIds(h).length > 0;
const parTotal = holes => holes.reduce((s, h) => s + h.par, 0);
const teePhotoIds = td => td.holes.flatMap(holePhotoIds);
const coursePhotoIds = c => Object.values(c.tees).flatMap(teePhotoIds);

function normHole(h = {}) {
  const par = [3, 4, 5].includes(+h.par) ? +h.par : 4;
  const len = parseInt(h.length, 10);
  const p = h.photos || {};
  return {
    par,
    length: Number.isFinite(len) && len > 0 ? len : '',
    shots: [0, 1, 2].map(i => String((h.shots && h.shots[i]) ?? '')),
    green: String(h.green ?? ''),
    photos: Object.fromEntries(SLOTS.map(s => [s, Array.isArray(p[s]) ? p[s].map(String) : []])),
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
const state = {
  courses: [], course: null, teeId: null, hole: 0, draft: null, dirty: false,
  mode: 'play', photoSlot: null,
  showPhotos: (() => { try { return localStorage.getItem(PHOTOS_KEY) !== 'off'; } catch (e) { return true; } })(),
};
const $app = document.getElementById('app');
const $ = sel => document.querySelector(sel);

/* ---------- Hilfsfunktionen UI ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = d => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  next: svg('<path d="M9 18l6-6-6-6"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  down: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  up: svg('<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 3h14"/>'),
  share: svg('<path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>'),
  cam: svg('<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>'),
  camOff: svg('<path d="M1 1l22 22"/><path d="M21 21H3a2 2 0 01-2-2V8a2 2 0 012-2h3m3-3h6l2 3h4a2 2 0 012 2v9.34"/><path d="M14.12 14.12A3 3 0 119.88 9.88"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  play: svg('<path d="M4 22V3"/><path d="M4 4h13l-3 4 3 4H4"/>'),
  pen: svg('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.59 7.59"/><circle cx="11" cy="11" r="2"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/>'),
  book: svg('<path d="M2 4h7a3 3 0 013 3v14a2 2 0 00-2-2H2z"/><path d="M22 4h-7a3 3 0 00-3 3v14a2 2 0 012-2h8z"/>'),
};

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/**
 * Dialog. buttons: [{label, value, cls, primary, run}] – run() wird direkt im Klick ausgeführt
 * (nötig fürs Teilen-Menü auf dem iPhone). Mit input/read → {action, value, data}, sonst action.
 */
function modal({ title, text = '', html = '', input = null, read = null, buttons, stack = false }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<form method="dialog">
      <h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${html}
      ${input ? `<input name="v" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off" enterkeyhint="done">` : ''}
      <div class="modal-btns${stack ? ' stack' : ''}">${buttons.map((b, i) => `<button value="${esc(b.value)}" data-i="${i}" class="btn ${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div>
    </form>`;
    document.body.append(d);
    const inp = d.querySelector('input[name=v]');
    const primary = buttons.find(b => b.primary);
    if (inp && primary) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); d.close(primary.value); } });
    d.querySelectorAll('.modal-btns button').forEach(btn => {
      const b = buttons[+btn.dataset.i];
      if (b.run) btn.addEventListener('click', () => b.run());
    });
    d.addEventListener('close', () => {
      const action = d.returnValue || '';
      const value = inp ? inp.value.trim() : undefined;
      const data = read ? read(d) : undefined;
      d.remove();
      resolve(inp || read ? { action, value, data } : action);
    });
    d.showModal();
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}
const confirmBox = (title, text, okLabel = 'OK', danger = false) =>
  modal({ title, text, buttons: [{ label: 'Abbrechen', value: 'cancel' }, { label: okLabel, value: 'ok', cls: danger ? 'danger solid' : 'primary' }] })
    .then(v => v === 'ok');
const infoBox = (title, text) => modal({ title, text, buttons: [{ label: 'OK', value: 'ok', cls: 'primary' }] });

function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtMB = bytes => (bytes / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB';

/* ---------- Fotos: Speicher & Anzeige ---------- */
const urlCache = new Map();
async function photoURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const rec = await DB.photo(id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(id, url);
  return url;
}
function forgetURL(id) { const u = urlCache.get(id); if (u) URL.revokeObjectURL(u); urlCache.delete(id); }
function releaseURLs() { urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear(); }
async function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-photo]')) {
    const url = await photoURL(img.dataset.photo);
    if (url) img.src = url; else img.closest('.thumb')?.classList.add('missing');
  }
}
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild konnte nicht gelesen werden')); i.src = src; });
const canvasBlob = (c, q = 0.85) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Bild konnte nicht gespeichert werden'))), 'image/jpeg', q));

/** Verkleinert ein Foto (spart Speicher) und gibt ein JPEG zurück. */
async function processImage(file, maxPx) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const s = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { blob: await canvasBlob(c), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

async function dupPhotoIds(ids) {
  const out = [];
  for (const id of ids) {
    const r = await DB.photo(id);
    if (!r) continue;
    const nid = uid();
    await DB.putPhoto({ ...r, id: nid });
    out.push(nid);
  }
  return out;
}

const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function dataURLToBlob(u) {
  const [head, b64] = u.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
async function photosForExport(ids) {
  const out = {};
  for (const id of new Set(ids)) {
    const r = await DB.photo(id);
    if (r) out[id] = { w: r.w, h: r.h, data: await blobToDataURL(r.blob) };
  }
  return out;
}

/* ---------- Startseite ---------- */
async function showHome() {
  releaseURLs();
  state.courses = (await DB.all()).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  state.course = null; state.teeId = null; state.draft = null; state.dirty = false;
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
          <p class="muted">Lege deinen Heimatplatz an oder importiere einen Platz, den dir ein Freund geschickt hat.</p></div>`}
      </section>
      <section>
        <h2>Datensicherung &amp; Import</h2>
        <p class="muted">Alle Daten liegen nur auf diesem Gerät. Exportiere ab und zu ein Backup.
          Über „Importieren…“ übernimmst du auch Plätze, die dir Freunde geschickt haben.</p>
        <div class="btn-row">
          <button class="btn" data-act="export-json" ${state.courses.length ? '' : 'disabled'}>${ICON.down} Backup (JSON)</button>
          <button class="btn" data-act="export-csv" ${state.courses.length ? '' : 'disabled'}>${ICON.down} Tabelle (CSV)</button>
          <button class="btn" data-act="import">${ICON.up} Importieren…</button>
        </div>
        <p class="muted small" id="storageInfo"></p>
        <p class="muted small">Birdie Book · Version ${APP_VERSION}</p>
      </section>
    </main>`;
  window.scrollTo(0, 0);
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(e => {
      const el = document.getElementById('storageInfo');
      if (el && e.usage != null) el.textContent = `Belegter Speicher: ${fmtMB(e.usage)}`;
    }).catch(() => {});
  }
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
  releaseURLs();
  const c = await DB.get(id);
  if (!c) return showHome();
  state.course = c; state.teeId = null; state.draft = null; state.dirty = false;
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
  const anyTee = TEES.some(t => c.tees[t.id]);

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
      <section>
        <h2>Mit Freunden teilen</h2>
        <p class="muted">Exportiert diesen Platz mit den gewählten Tees (und auf Wunsch Fotos) als Datei.
          Dein Freund übernimmt ihn über „Importieren…“ als neuen Platz.</p>
        <div class="btn-row"><button class="btn" data-act="share-course" ${anyTee ? '' : 'disabled'}>${ICON.share} Platz teilen…</button></div>
      </section>
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
          { label: 'Par + Notizen + Fotos übernehmen', value: 'all' },
          { label: 'Leer starten', value: 'empty' },
          { label: 'Abbrechen', value: 'cancel' },
        ],
      });
      if (!v || v === 'cancel') return;
      const sh = c.tees[src.id].holes;
      if (v === 'par') holes = sh.map(h => ({ ...emptyHole(), par: h.par }));
      if (v === 'all') {
        holes = clone(sh).map(h => ({ ...h, length: '' }));
        for (const h of holes) for (const s of SLOTS) h.photos[s] = await dupPhotoIds(h.photos[s]);
      }
    }
    c.tees[teeId] = { holes };
    await DB.put(c);
  }
  const holes = c.tees[teeId].holes;
  openHoles(teeId, 0, { mode: holes.some(hasNotes) ? 'play' : 'edit' });
}

async function deleteTee(teeId) {
  const t = teeById(teeId);
  if (!await confirmBox(`Tee ${t.name} löschen?`, 'Alle Notizen und Fotos dieses Tees gehen verloren.', 'Löschen', true)) return;
  const ids = teePhotoIds(state.course.tees[teeId]);
  delete state.course.tees[teeId];
  await DB.put(state.course);
  await DB.delPhotos(ids);
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
  if (!await confirmBox(`„${state.course.name}“ löschen?`, 'Der Platz mit allen Tees, Notizen und Fotos wird entfernt.', 'Löschen', true)) return;
  const ids = coursePhotoIds(state.course);
  await DB.del(state.course.id);
  await DB.delPhotos(ids);
  toast('Platz gelöscht');
  showHome();
}

/* ---------- Loch-Ansicht ---------- */
const holesOf = () => state.course.tees[state.teeId].holes;
const savedHole = () => holesOf()[state.hole];

function openHoles(teeId, hole, { draft = null, mode = 'play' } = {}) {
  releaseURLs();
  state.teeId = teeId;
  state.hole = hole;
  state.mode = mode;
  state.draft = draft ? normHole(draft) : clone(holesOf()[hole]);
  const t = teeById(teeId);
  $app.className = 'full';
  $app.innerHTML = `
    <header class="topbar">
      <button class="iconbtn" data-act="back-course" aria-label="Zurück zur Tee-Auswahl">${ICON.back}</button>
      <h1><span class="t">${esc(state.course.name)}</span>
        <span class="sub"><span class="tee-dot" style="--tee:${t.color}"></span>Tee ${t.name} · Par <span id="parSum"></span></span></h1>
      <button class="iconbtn" id="photoToggle" data-act="toggle-photos"></button>
    </header>
    <div class="hole-layout">
      <nav class="holes" id="holeNav" aria-label="Löcher"></nav>
      <main class="hole-main" id="holeMain"></main>
    </div>`;
  renderPhotoToggle();
  renderNav();
  renderHole();
}

function renderPhotoToggle() {
  const b = document.getElementById('photoToggle');
  if (!b) return;
  b.innerHTML = state.showPhotos ? ICON.cam : ICON.camOff;
  b.setAttribute('aria-label', state.showPhotos ? 'Fotos ausblenden' : 'Fotos einblenden');
  b.setAttribute('aria-pressed', String(state.showPhotos));
  b.title = b.getAttribute('aria-label');
}

function renderNav() {
  const nav = document.getElementById('holeNav');
  if (!nav) return;
  const holes = holesOf();
  nav.innerHTML = holes.map((h, i) => `
    ${i === 0 ? '<div class="hn-sep first">OUT</div>' : ''}
    ${i === 9 ? '<div class="hn-sep">IN</div>' : ''}
    <button class="hn${i === state.hole ? ' is-active' : ''}${hasNotes(h) ? ' has-notes' : ''}" data-act="go-hole" data-i="${i}"
      aria-current="${i === state.hole ? 'true' : 'false'}" aria-label="Loch ${i + 1}, Par ${h.par}">
      <span class="hn-no">${i + 1}</span><span class="hn-par">Par ${h.par}</span></button>`).join('');
  document.getElementById('parSum').textContent = parTotal(holes);
  const active = nav.querySelector('.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function thumbsHTML(slot, ids, editable) {
  const th = ids.map((id, i) => `<button class="thumb" data-act="photo-open" data-slot="${slot}" data-i="${i}" aria-label="Foto ${i + 1} öffnen">
      <img data-photo="${esc(id)}" alt=""></button>`).join('');
  const add = editable ? `<button class="thumb add" data-act="photo-add" data-slot="${slot}" aria-label="Foto hinzufügen">${ICON.cam}<span>+</span></button>` : '';
  return th + add;
}

function slotBlock({ key, label, badge, text, placeholder }) {
  const h = state.draft;
  const ids = h.photos[key];
  const edit = state.mode === 'edit';
  const photoCol = state.showPhotos && (edit || ids.length) ? `<div class="photos-col">${thumbsHTML(key, ids, edit)}</div>` : '';
  if (edit) {
    return `<div class="note">
      <div class="note-body">
        <label for="f-${key}"><span class="badge">${badge}</span>${label}</label>
        <textarea id="f-${key}" data-field="${key}" rows="2" placeholder="${esc(placeholder)}">${esc(text)}</textarea>
      </div>${photoCol}</div>`;
  }
  const empty = !text.trim();
  return `<div class="note pnote${empty ? ' is-empty' : ''}" data-act="edit-field" data-field="${key}" role="button" tabindex="0"
      aria-label="${esc(label)} bearbeiten">
    <div class="note-body">
      <div class="plabel"><span class="badge">${badge}</span>${label}</div>
      <div class="ptext">${empty ? 'Keine Notiz – antippen zum Schreiben' : esc(text)}</div>
    </div>${photoCol}</div>`;
}

function renderHole(keepScroll = false) {
  const main = document.getElementById('holeMain');
  const h = state.draft;
  const n = state.hole + 1;
  const last = state.hole === HOLES - 1;
  const edit = state.mode === 'edit';
  const scroll = main.scrollTop;

  const slots = Array.from({ length: shotCount(h.par) }, (_, i) =>
    slotBlock({ key: 'shot' + i, label: SHOT_LABELS[i], badge: i + 1, text: h.shots[i], placeholder: PLACEHOLDERS[i] })).join('')
    + slotBlock({ key: 'green', label: 'Auf dem Grün', badge: '⛳', text: h.green, placeholder: GREEN_PLACEHOLDER });

  const bookIds = h.photos.book;
  const book = state.showPhotos && (edit || bookIds.length) ? `
    <section class="book">
      <div class="book-head"><h2>${ICON.book} Birdiebook vom Club</h2></div>
      ${bookIds.length || edit ? `<div class="book-grid">${thumbsHTML('book', bookIds, edit)}</div>` : ''}
      ${edit && !bookIds.length ? '<p class="muted small">Fotografiere die Seite aus dem offiziellen Birdiebook – auch mehrere Fotos sind möglich.</p>' : ''}
    </section>` : '';

  const props = edit ? `
    <div class="hole-props">
      <div class="seg" role="group" aria-label="Par">
        ${[3, 4, 5].map(p => `<button data-act="set-par" data-par="${p}" aria-pressed="${h.par === p}">Par ${p}</button>`).join('')}
      </div>
      <label class="len" title="Länge in Metern"><input id="f-length" data-field="length" type="number" inputmode="numeric"
        min="0" max="999" value="${h.length}" placeholder="—" aria-label="Länge in Metern"> m</label>
    </div>` : `
    <div class="hole-props"><span class="chip">Par ${h.par}</span>${h.length ? `<span class="chip">${h.length} m</span>` : ''}</div>`;

  main.innerHTML = `<div class="hole-inner ${edit ? 'is-edit' : 'is-play'}">
    <div class="hole-head">
      <div class="hole-title"><div class="eyebrow">Loch</div><div class="hole-no">${n}</div></div>
      <div class="seg mode" role="group" aria-label="Modus">
        <button data-act="mode" data-mode="play" aria-pressed="${!edit}">${ICON.play} Spielen</button>
        <button data-act="mode" data-mode="edit" aria-pressed="${edit}">${ICON.edit} Bearbeiten</button>
      </div>
    </div>
    ${props}
    <div class="notes">${slots}</div>
    ${book}
    <div class="unsaved" id="unsaved"></div>
    <div class="actions">
      <button class="btn" data-act="prev-hole" ${state.hole === 0 ? 'disabled' : ''} aria-label="Vorheriges Loch">${ICON.back}</button>
      ${edit
        ? '<button class="btn" id="saveBtn" data-act="save-hole">Speichern</button>'
        : `<button class="btn" data-act="mode" data-mode="edit" aria-label="Bearbeiten" title="Bearbeiten">${ICON.edit}</button>`}
      <button class="btn primary grow" data-act="next-hole">${last ? 'Runde beenden' : 'Weiter →'}</button>
    </div>
  </div>`;
  main.querySelectorAll('textarea').forEach(autosize);
  main.scrollTop = keepScroll ? scroll : 0;
  updateDirty();
  hydratePhotos(main);
}

function updateDirty() {
  if (!state.draft || !state.course || !state.teeId) return;
  state.dirty = JSON.stringify(state.draft) !== JSON.stringify(savedHole());
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
  if (v === 'discard') { state.draft = clone(savedHole()); state.dirty = false; clearStoredDraft(); return true; }
  return false;
}

async function goHole(i) {
  if (i < 0 || i >= HOLES || i === state.hole) return;
  if (!await confirmLeave()) return;
  releaseURLs();
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

async function setMode(mode, focusField = null) {
  if (mode === state.mode && !focusField) return;
  if (mode === 'play' && !await confirmLeave()) return;
  state.mode = mode;
  renderHole();
  if (focusField) {
    const t = document.getElementById('f-' + focusField);
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.scrollIntoView({ block: 'center' }); }
  }
}

/* Fotos hinzufügen / löschen – wird sofort gespeichert, unabhängig von den Texten */
async function addPhotos(slot, files) {
  if (!files.length) return;
  const hole = savedHole();
  let added = 0;
  toast(files.length > 1 ? 'Fotos werden übernommen…' : 'Foto wird übernommen…');
  for (const f of files) {
    try {
      const { blob, w, h } = await processImage(f, slot === 'book' ? PHOTO_MAX_PX.book : PHOTO_MAX_PX.other);
      const id = uid();
      await DB.putPhoto({ id, blob, w, h, created: new Date().toISOString() });
      hole.photos[slot].push(id);
      state.draft.photos[slot].push(id);
      added++;
    } catch (e) {
      await infoBox('Foto nicht übernommen', `${f.name}: ${e.message || e}`);
    }
  }
  if (!added) return;
  await DB.put(state.course);
  renderNav();
  renderHole(true);
  toast(added > 1 ? `${added} Fotos gespeichert` : 'Foto gespeichert');
}

async function removePhoto(slot, id) {
  const del = arr => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };
  del(savedHole().photos[slot]);
  del(state.draft.photos[slot]);
  await DB.put(state.course);
  await DB.delPhotos([id]);
  forgetURL(id);
  renderNav();
  renderHole(true);
}

/* ---------- Vollbild-Ansicht mit Zoom ---------- */
let V = null;

function openViewer(slot, idx) {
  const ids = state.draft.photos[slot];
  if (!ids.length) return;
  V = { slot, ids: [...ids], idx, s: 1, tx: 0, ty: 0, ptrs: new Map(), g: null, down: null, lastTap: 0 };
  const el = document.createElement('div');
  el.className = 'viewer';
  el.id = 'viewer';
  el.innerHTML = `
    <div class="v-stage" id="vStage"><img id="vImg" alt="" draggable="false"></div>
    <div class="v-top">
      <span class="v-count" id="vCount"></span>
      <div class="v-btns">
        <button class="vbtn" data-v="draw">${ICON.pen}<span>Malen</span></button>
        ${state.mode === 'edit' ? `<button class="vbtn" data-v="delete" aria-label="Foto löschen">${ICON.trash}</button>` : ''}
        <button class="vbtn" data-v="close" aria-label="Schließen">${ICON.close}</button>
      </div>
    </div>
    <button class="vbtn v-nav prev" data-v="prev" aria-label="Vorheriges Foto">${ICON.back}</button>
    <button class="vbtn v-nav next" data-v="next" aria-label="Nächstes Foto">${ICON.next}</button>
    <div class="v-bottom">
      <button class="vbtn" data-v="zoomout" aria-label="Verkleinern">−</button>
      <button class="vbtn" data-v="reset">Ganz</button>
      <button class="vbtn" data-v="zoomin" aria-label="Vergrößern">+</button>
    </div>`;
  document.body.append(el);
  el.addEventListener('click', onViewerClick);
  const st = el.querySelector('#vStage');
  st.addEventListener('pointerdown', vDown);
  st.addEventListener('pointermove', vMove);
  st.addEventListener('pointerup', vUp);
  st.addEventListener('pointercancel', vUp);
  st.addEventListener('wheel', e => { e.preventDefault(); const p = vRel(e); vZoomAt(V.s * Math.exp(-e.deltaY * 0.0015), p.x, p.y); }, { passive: false });
  st.addEventListener('dblclick', e => { const p = vRel(e); vZoomAt(V.s > 1.05 ? 1 : 2.5, p.x, p.y); });
  vShow();
}

function closeViewer() {
  const el = document.getElementById('viewer');
  if (el) el.remove();
  V = null;
}

async function vShow() {
  if (!V) return;
  const img = document.getElementById('vImg');
  V.s = 1; V.tx = 0; V.ty = 0;
  const url = await photoURL(V.ids[V.idx]);
  img.onload = vLayout;
  img.src = url || '';
  document.getElementById('vCount').textContent = V.ids.length > 1 ? `${V.idx + 1} / ${V.ids.length}` : '';
  document.querySelectorAll('.v-nav').forEach(b => { b.hidden = V.ids.length < 2; });
}

function vLayout() {
  if (!V) return;
  const img = document.getElementById('vImg');
  const r = document.getElementById('vStage').getBoundingClientRect();
  if (!img.naturalWidth) return;
  const f = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  V.w = img.naturalWidth * f; V.h = img.naturalHeight * f; V.sw = r.width; V.sh = r.height;
  img.style.width = V.w + 'px';
  img.style.height = V.h + 'px';
  vApply();
}

function vApply() {
  const mx = Math.max(0, (V.w * V.s - V.sw) / 2), my = Math.max(0, (V.h * V.s - V.sh) / 2);
  V.tx = clamp(V.tx, -mx, mx);
  V.ty = clamp(V.ty, -my, my);
  document.getElementById('vImg').style.transform = `translate(-50%,-50%) translate(${V.tx}px,${V.ty}px) scale(${V.s})`;
}

function vZoomAt(ns, px, py) {
  ns = clamp(ns, 1, 8);
  const cx = (px - V.tx) / V.s, cy = (py - V.ty) / V.s;
  V.s = ns; V.tx = px - ns * cx; V.ty = py - ns * cy;
  vApply();
}

function vRel(e) {
  const r = document.getElementById('vStage').getBoundingClientRect();
  return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function vGesture() {
  const p = [...V.ptrs.values()];
  if (p.length >= 2) { V.g = { type: 'pinch', d: dist(p[0], p[1]) || 1, m: mid(p[0], p[1]), s: V.s, tx: V.tx, ty: V.ty }; V.down = null; }
  else if (p.length === 1) V.g = { type: 'pan', p: p[0], tx: V.tx, ty: V.ty };
  else V.g = null;
}
function vDown(e) {
  e.currentTarget.setPointerCapture(e.pointerId);
  const p = vRel(e);
  V.ptrs.set(e.pointerId, p);
  if (V.ptrs.size === 1) V.down = { ...p, t: Date.now() };
  vGesture();
}
function vMove(e) {
  if (!V || !V.ptrs.has(e.pointerId)) return;
  V.ptrs.set(e.pointerId, vRel(e));
  const g = V.g, p = [...V.ptrs.values()];
  if (!g) return;
  if (g.type === 'pinch' && p.length >= 2) {
    const ns = clamp(g.s * dist(p[0], p[1]) / g.d, 1, 8), m = mid(p[0], p[1]);
    const cx = (g.m.x - g.tx) / g.s, cy = (g.m.y - g.ty) / g.s;
    V.s = ns; V.tx = m.x - ns * cx; V.ty = m.y - ns * cy;
    vApply();
  } else if (g.type === 'pan' && V.s > 1.01) {
    V.tx = g.tx + (p[0].x - g.p.x); V.ty = g.ty + (p[0].y - g.p.y);
    vApply();
  }
}
function vUp(e) {
  if (!V || !V.ptrs.has(e.pointerId)) return;
  const single = V.ptrs.size === 1 && V.down;
  const p = vRel(e);
  V.ptrs.delete(e.pointerId);
  if (single) {
    const dx = p.x - V.down.x, dy = p.y - V.down.y, dt = Date.now() - V.down.t;
    if (V.s <= 1.01 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && V.ids.length > 1) {
      vNav(dx < 0 ? 1 : -1);
    } else if (e.pointerType !== 'mouse' && Math.hypot(dx, dy) < 12 && dt < 300) {
      if (Date.now() - V.lastTap < 320) { vZoomAt(V.s > 1.05 ? 1 : 2.5, p.x, p.y); V.lastTap = 0; }
      else V.lastTap = Date.now();
    }
  }
  if (!V.ptrs.size) V.down = null;
  vGesture();
}
function vNav(d) {
  V.idx = (V.idx + d + V.ids.length) % V.ids.length;
  vShow();
}

async function onViewerClick(e) {
  const b = e.target.closest('[data-v]');
  if (!b || !V) return;
  switch (b.dataset.v) {
    case 'close': return closeViewer();
    case 'prev': return vNav(-1);
    case 'next': return vNav(1);
    case 'zoomin': return vZoomAt(V.s * 1.6, 0, 0);
    case 'zoomout': return vZoomAt(V.s / 1.6, 0, 0);
    case 'reset': V.s = 1; V.tx = 0; V.ty = 0; return vApply();
    case 'draw': return openDraw();
    case 'delete': {
      if (!await confirmBox('Foto löschen?', 'Das Foto wird endgültig entfernt.', 'Löschen', true)) return;
      const id = V.ids[V.idx];
      await removePhoto(V.slot, id);
      V.ids.splice(V.idx, 1);
      if (!V.ids.length) return closeViewer();
      V.idx = Math.min(V.idx, V.ids.length - 1);
      vShow();
      toast('Foto gelöscht');
    }
  }
}

/* ---------- Auf Foto malen ---------- */
const PEN_COLORS = [['Rot', '#e53935'], ['Gelb', '#fdd835'], ['Weiß', '#ffffff'], ['Schwarz', '#111111'], ['Blau', '#1e88e5'], ['Grün', '#43a047']];
const PEN_SIZES = [['Dünn', 3], ['Mittel', 6], ['Dick', 12]];
let D = null;

async function openDraw() {
  const id = V.ids[V.idx];
  const rec = await DB.photo(id);
  if (!rec) return;
  const img = await loadImg(await photoURL(id));
  D = { id, rec, img, strokes: [], cur: null, color: PEN_COLORS[0][1], size: PEN_SIZES[1][1] };
  const el = document.createElement('div');
  el.className = 'draw';
  el.id = 'draw';
  el.innerHTML = `
    <div class="draw-bar top">
      <button class="vbtn" data-d="cancel">Abbrechen</button>
      <div class="v-btns">
        <button class="vbtn" data-d="undo" aria-label="Rückgängig">${ICON.undo}</button>
        <button class="vbtn save" data-d="save">Speichern</button>
      </div>
    </div>
    <div class="draw-stage" id="drawStage"><canvas id="drawCanvas"></canvas></div>
    <div class="draw-bar bottom">
      <div class="swatches">${PEN_COLORS.map(([n, c], i) => `<button class="swatch" style="--c:${c}" data-d="color" data-c="${c}" aria-label="${n}" aria-pressed="${i === 0}"></button>`).join('')}</div>
      <div class="sizes">${PEN_SIZES.map(([n, s], i) => `<button class="size" data-d="size" data-s="${s}" aria-label="${n}" aria-pressed="${i === 1}"><i style="--s:${s * 1.6}px"></i></button>`).join('')}</div>
    </div>`;
  document.body.append(el);
  const cv = document.getElementById('drawCanvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  drawLayout();
  drawRedraw();
  el.addEventListener('click', onDrawClick);
  cv.addEventListener('pointerdown', e => {
    if (D.cur) return;
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect();
    D.cur = { id: e.pointerId, color: D.color, width: D.size * (cv.width / r.width), pts: [drawPt(e)] };
    drawStroke(cv.getContext('2d'), D.cur);
  });
  cv.addEventListener('pointermove', e => {
    if (!D || !D.cur || D.cur.id !== e.pointerId) return;
    D.cur.pts.push(drawPt(e));
    const ctx = cv.getContext('2d');
    const n = D.cur.pts.length;
    drawStroke(ctx, { ...D.cur, pts: D.cur.pts.slice(n - 2) });
  });
  const end = e => {
    if (!D || !D.cur || D.cur.id !== e.pointerId) return;
    D.strokes.push(D.cur);
    D.cur = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function drawLayout() {
  const cv = document.getElementById('drawCanvas');
  if (!cv) return;
  const r = document.getElementById('drawStage').getBoundingClientRect();
  const f = Math.min((r.width - 16) / cv.width, (r.height - 16) / cv.height);
  cv.style.width = cv.width * f + 'px';
  cv.style.height = cv.height * f + 'px';
}
function drawPt(e) {
  const cv = document.getElementById('drawCanvas');
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
}
function drawStroke(ctx, s) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.pts.length === 1) {
    ctx.beginPath(); ctx.arc(s.pts[0].x, s.pts[0].y, s.width / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(s.pts[0].x, s.pts[0].y);
  for (const p of s.pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}
function drawRedraw() {
  const cv = document.getElementById('drawCanvas');
  const ctx = cv.getContext('2d');
  ctx.drawImage(D.img, 0, 0);
  D.strokes.forEach(s => drawStroke(ctx, s));
}
function closeDraw() { const el = document.getElementById('draw'); if (el) el.remove(); D = null; }

async function onDrawClick(e) {
  const b = e.target.closest('[data-d]');
  if (!b || !D) return;
  switch (b.dataset.d) {
    case 'color':
      D.color = b.dataset.c;
      document.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      return;
    case 'size':
      D.size = +b.dataset.s;
      document.querySelectorAll('.size').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      return;
    case 'undo':
      D.strokes.pop();
      return drawRedraw();
    case 'cancel':
      if (D.strokes.length && !await confirmBox('Zeichnung verwerfen?', 'Deine Markierungen gehen verloren.', 'Verwerfen', true)) return;
      return closeDraw();
    case 'save': {
      if (!D.strokes.length) return closeDraw();
      const cv = document.getElementById('drawCanvas');
      const blob = await canvasBlob(cv, 0.88);
      await DB.putPhoto({ ...D.rec, blob, w: cv.width, h: cv.height, edited: new Date().toISOString() });
      forgetURL(D.id);
      closeDraw();
      await vShow();
      const main = document.getElementById('holeMain');
      if (main) main.querySelectorAll(`img[data-photo]`).forEach(img => { img.removeAttribute('src'); });
      if (main) hydratePhotos(main);
      toast('Zeichnung gespeichert');
    }
  }
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
  const draft = normHole(d.draft);
  draft.photos = clone(c.tees[d.teeId].holes[d.hole].photos); // Fotos sind immer schon gespeichert
  openHoles(d.teeId, d.hole, { draft, mode: 'edit' });
  return true;
}

/* ---------- Export ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const slug = s => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'golfplatz';

function downloadFile(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/**
 * Liefert eine Datei aus. Am iPhone über das Teilen-Menü („In Dateien sichern“, Mail, WhatsApp …),
 * das nur direkt aus einem Tipp heraus geöffnet werden darf – daher der Zwischendialog.
 */
async function deliverFile(filename, text, mime, title = 'Datei ist bereit') {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], filename, { type: mime });
  const canShare = isIOS && navigator.canShare && navigator.canShare({ files: [file] });
  if (!canShare) { downloadFile(filename, blob); return; }
  await modal({
    title, text: `${filename} (${fmtMB(blob.size)})`,
    buttons: [
      { label: 'Abbrechen', value: 'cancel' },
      { label: 'Teilen / Sichern', value: 'ok', cls: 'primary', run: () => navigator.share({ files: [file], title: filename }).catch(() => {}) },
    ],
  });
}

async function exportJSON() {
  toast('Backup wird erstellt…');
  const courses = await DB.all();
  const photos = await photosForExport(courses.flatMap(coursePhotoIds));
  const data = { app: 'birdie-book', type: 'backup', version: 2, exported: new Date().toISOString(), courses, photos };
  await deliverFile(`birdie-book-backup-${today()}.json`, JSON.stringify(data), 'application/json', 'Backup ist bereit');
}

const CSV_HEAD = ['Platz', 'Tee', 'Loch', 'Par', 'Laenge_m', 'Abschlag', 'Schlag_2', 'Schlag_3', 'Gruen'];
function csvCell(v) {
  const s = String(v ?? '');
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function exportCSV() {
  const rows = [CSV_HEAD];
  for (const c of state.courses) for (const t of TEES) {
    const td = c.tees[t.id];
    if (!td) continue;
    td.holes.forEach((h, i) => rows.push([c.name, t.name, i + 1, h.par, h.length, h.shots[0], h.shots[1], h.shots[2], h.green]));
  }
  // Semikolon + BOM, damit Excel (deutsch) Umlaute und Spalten korrekt erkennt. Fotos sind nur im JSON-Backup.
  await deliverFile(`birdie-book-${today()}.csv`, '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n'), 'text/csv', 'Tabelle ist bereit');
}

async function shareCourse() {
  const c = state.course;
  const tees = TEES.filter(t => c.tees[t.id]);
  if (!tees.length) return;
  const nPhotos = coursePhotoIds(c).length;
  const r = await modal({
    title: 'Platz teilen', text: 'Was soll mitgeschickt werden?',
    html: `<div class="checks">
      ${tees.map(t => `<label class="check"><input type="checkbox" name="tee" value="${t.id}" checked>
        <span class="tee-dot" style="--tee:${t.color}"></span>Tee ${t.name}</label>`).join('')}
      <label class="check"><input type="checkbox" name="photos" ${nPhotos ? 'checked' : 'disabled'}>
        Fotos mitschicken${nPhotos ? ` (${nPhotos})` : ' (keine vorhanden)'}</label>
    </div>`,
    read: d => ({
      tees: [...d.querySelectorAll('input[name=tee]:checked')].map(i => i.value),
      photos: d.querySelector('input[name=photos]').checked,
    }),
    buttons: [{ label: 'Abbrechen', value: 'cancel' }, { label: 'Exportieren', value: 'ok', cls: 'primary' }],
  });
  if (r.action !== 'ok') return;
  if (!r.data.tees.length) { toast('Bitte mindestens ein Tee wählen'); return; }
  const out = { name: c.name, tees: {} };
  for (const t of r.data.tees) {
    out.tees[t] = { holes: clone(c.tees[t].holes) };
    if (!r.data.photos) out.tees[t].holes.forEach(h => { h.photos = emptyPhotos(); });
  }
  const photos = r.data.photos ? await photosForExport(Object.values(out.tees).flatMap(teePhotoIds)) : {};
  const data = { app: 'birdie-book', type: 'course', version: 2, exported: new Date().toISOString(), course: out, photos };
  await deliverFile(`${slug(c.name)}.birdiebook.json`, JSON.stringify(data), 'application/json', 'Platz ist bereit zum Teilen');
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
  const idx = Object.fromEntries(CSV_HEAD.map(h => [h, head.indexOf(h.toLowerCase())]));
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
    const old = c.tees[tee.id].holes[hole - 1];
    c.tees[tee.id].holes[hole - 1] = {
      ...normHole({ par: g('Par'), length: g('Laenge_m'), shots: [g('Abschlag'), g('Schlag_2'), g('Schlag_3')], green: g('Gruen') }),
      photos: old ? old.photos : emptyPhotos(), // vorhandene Fotos behalten
    };
    count++;
  }
  if (!count) throw new Error('Keine gültigen Zeilen gefunden.');
  const ok = await confirmBox('CSV importieren?',
    `${count} Löcher für ${touched.size} Platz/Plätze. Vorhandene Notizen derselben Plätze, Tees und Löcher werden überschrieben (Fotos bleiben erhalten).`, 'Importieren');
  if (!ok) return;
  await DB.putMany([...touched.values()]);
  toast(`${count} Löcher importiert`);
}

async function photoRecords(photos, idMap = null) {
  const recs = [];
  for (const [id, p] of Object.entries(photos || {})) {
    const data = typeof p === 'string' ? p : p && p.data;
    if (!data || !data.startsWith('data:')) continue;
    const nid = idMap ? (idMap[id] = uid()) : id;
    recs.push({ id: nid, blob: await dataURLToBlob(data), w: p.w, h: p.h, created: new Date().toISOString() });
  }
  return recs;
}

async function importBackup(data) {
  const list = Array.isArray(data) ? data : data.courses;
  if (!Array.isArray(list) || !list.length) throw new Error('Keine Golfplätze in der Datei gefunden.');
  const courses = list.filter(c => c && typeof c === 'object').map(normCourse);
  const existing = new Set((await DB.all()).map(c => c.id));
  const overlap = courses.filter(c => existing.has(c.id)).length;
  const nPhotos = Object.keys(data.photos || {}).length;
  const ok = await confirmBox('Backup importieren?',
    `${courses.length} Platz/Plätze${nPhotos ? ` und ${nPhotos} Fotos` : ''} gefunden.` +
    (overlap ? ` ${overlap} Platz/Plätze sind schon vorhanden und werden überschrieben.` : ''), 'Importieren');
  if (!ok) return;
  toast('Wird importiert…');
  await DB.putPhotos(await photoRecords(data.photos));
  await DB.putMany(courses);
  toast(`${courses.length} Platz/Plätze importiert`);
}

/** Geteilter Platz → wird immer als NEUER Platz angelegt (eigene IDs, auch für Fotos). */
async function importSharedCourse(data) {
  const src = data.course;
  if (!src || !src.tees) throw new Error('Die Datei enthält keinen Golfplatz.');
  const tees = TEES.filter(t => src.tees[t.id]);
  if (!tees.length) throw new Error('Die Datei enthält keine Tees.');
  const names = new Set((await DB.all()).map(c => c.name.toLowerCase()));
  let name = String(src.name || 'Geteilter Platz').trim();
  if (names.has(name.toLowerCase())) name += ' (geteilt)';
  const nPhotos = Object.keys(data.photos || {}).length;
  const r = await modal({
    title: 'Geteilten Platz übernehmen',
    text: `Tees: ${tees.map(t => t.name).join(', ')}${nPhotos ? ` · ${nPhotos} Fotos` : ''}. Der Platz wird neu angelegt – unter diesem Namen:`,
    input: { value: name },
    buttons: [{ label: 'Abbrechen', value: 'cancel' }, { label: 'Übernehmen', value: 'ok', cls: 'primary', primary: true }],
  });
  if (r.action !== 'ok' || !r.value) return;
  toast('Wird übernommen…');
  const idMap = {};
  const recs = await photoRecords(data.photos, idMap);
  const course = normCourse({ name: r.value, tees: src.tees });
  course.id = uid();
  for (const td of Object.values(course.tees)) for (const h of td.holes) for (const s of SLOTS) {
    h.photos[s] = h.photos[s].map(id => idMap[id]).filter(Boolean);
  }
  await DB.putPhotos(recs);
  await DB.put(course);
  toast('Platz übernommen ⛳');
  return course.id;
}

async function handleImportFile(file) {
  let openId = null;
  try {
    const text = await file.text();
    const t = text.trim();
    if (/\.csv$/i.test(file.name) || (!/\.json$/i.test(file.name) && !t.startsWith('{') && !t.startsWith('['))) {
      await importCSV(text);
    } else {
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('Die Datei ist kein gültiges JSON.'); }
      if (data && data.type === 'course') openId = await importSharedCourse(data);
      else await importBackup(data || {});
    }
  } catch (e) {
    await infoBox('Import fehlgeschlagen', e.message || String(e));
  }
  if (openId) showCourse(openId); else showHome();
}

/* ---------- Ereignisse ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  switch (el.dataset.act) {
    case 'home': return showHome();
    case 'new-course': return newCourse();
    case 'open-course': return showCourse(el.dataset.id);
    case 'rename-course': return renameCourse();
    case 'del-course': return deleteCourse();
    case 'share-course': return shareCourse();
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
    case 'mode': return setMode(el.dataset.mode);
    case 'edit-field': return setMode('edit', el.dataset.field);
    case 'set-par':
      state.draft.par = +el.dataset.par;
      renderHole(true);
      return;
    case 'toggle-photos':
      state.showPhotos = !state.showPhotos;
      try { localStorage.setItem(PHOTOS_KEY, state.showPhotos ? 'on' : 'off'); } catch (err) { /* ignorieren */ }
      renderPhotoToggle();
      renderHole(true);
      toast(state.showPhotos ? 'Fotos eingeblendet' : 'Fotos ausgeblendet');
      return;
    case 'photo-add':
      state.photoSlot = el.dataset.slot;
      return document.getElementById('photoFile').click();
    case 'photo-open':
      return openViewer(el.dataset.slot, +el.dataset.i);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('pnote')) { e.preventDefault(); e.target.click(); }
});

document.addEventListener('input', e => {
  const f = e.target.dataset && e.target.dataset.field;
  if (!f || !state.draft || e.target.closest('.pnote')) return;
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
document.getElementById('photoFile').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length && state.photoSlot) addPhotos(state.photoSlot, files);
});

document.addEventListener('keydown', e => {
  if (D && e.key === 'Escape') { e.preventDefault(); return; }
  if (V) {
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') vNav(1);
    else if (e.key === 'ArrowLeft') vNav(-1);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.draft && state.mode === 'edit') {
    e.preventDefault();
    saveHole();
  }
});

window.addEventListener('beforeunload', e => { if (state.dirty) { storeDraft(); e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') storeDraft(); });
window.addEventListener('resize', () => {
  document.querySelectorAll('.note textarea').forEach(autosize);
  if (V) vLayout();
  if (D) drawLayout();
});

/* Fehler sichtbar machen statt stiller Absturz */
let errorShown = false;
function showError(err) {
  if (errorShown) return;
  errorShown = true;
  const msg = (err && (err.message || err.reason && err.reason.message)) || String(err);
  infoBox('Da ist etwas schiefgelaufen', `${msg} (Version ${APP_VERSION})`).then(() => { errorShown = false; });
}
window.addEventListener('error', e => showError(e.error || e.message));
window.addEventListener('unhandledrejection', e => showError(e.reason));

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
    // Nach einem Update übernimmt der neue Service Worker → einmal neu laden, damit sofort der neue Code läuft
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading || state.dirty || V || D) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
  }
  await showHome();
  await restoreDraft();
})();
