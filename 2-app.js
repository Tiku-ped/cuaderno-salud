/* Cuaderno de salud - app sin servidor: todo se guarda en este dispositivo (IndexedDB). */
(function () {
'use strict';

var CATEGORIES = ['Receta', 'Examen', 'Vacuna', 'Informe', 'Control', 'Otro'];
var REMINDER_TYPES = ['Vacuna', 'Control', 'Hora médica', 'Otro'];
var CATEGORY_ICON = { 'Receta': '💊', 'Examen': '🔬', 'Vacuna': '💉', 'Informe': '📋', 'Control': '🩺', 'Otro': '📄' };
var REMINDER_ICON = { 'Vacuna': '💉', 'Control': '🩺', 'Hora médica': '📅', 'Otro': '🔔' };
var PIN_KEY = 'cuaderno-salud-pin-v1';
var NOTIFIED_KEY = 'cuaderno-salud-notified-v1';

// ---------- Utilidades ----------

function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

function todayISO() {
  var d = new Date();
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function parseISO(s) {
  var parts = s.split('-');
  return new Date(parseInt(parts[0], 10), (parseInt(parts[1], 10) || 1) - 1, parseInt(parts[2], 10) || 1);
}

function formatDate(s) {
  if (!s) return '';
  var parts = s.split('-');
  return parts[2] + '-' + parts[1] + '-' + parts[0];
}

function daysUntil(s) {
  return Math.round((parseISO(s).getTime() - parseISO(todayISO()).getTime()) / 86400000);
}

function ageText(birthdate) {
  if (!birthdate) return '';
  var b = parseISO(birthdate);
  var now = new Date();
  var years = now.getFullYear() - b.getFullYear();
  var months = now.getMonth() - b.getMonth();
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return '';
  if (years === 0 && months === 0) return 'Recién nacido';
  if (years === 0) return months === 1 ? '1 mes' : months + ' meses';
  if (months === 0) return years === 1 ? '1 año' : years + ' años';
  return years + (years === 1 ? ' año y ' : ' años y ') + months + (months === 1 ? ' mes' : ' meses');
}

function relDays(s) {
  var d = daysUntil(s);
  if (d < 0) return 'atrasado';
  if (d === 0) return 'hoy';
  if (d === 1) return 'mañana';
  return 'en ' + d + ' días';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- IndexedDB ----------

var DB_NAME = 'cuaderno-salud';
var db = null;

function openDb() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') { reject(new Error('sin IndexedDB')); return; }
    var req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains('children')) d.createObjectStore('children', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('documents')) d.createObjectStore('documents', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('reminders')) d.createObjectStore('reminders', { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('IndexedDB')); };
  });
}

function put(store, value) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function del(store, key) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function getAll(store) {
  return new Promise(function (resolve, reject) {
    var req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });
}

function getOne(store, key) {
  return new Promise(function (resolve, reject) {
    var req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(String(r.result)); };
    r.onerror = function () { reject(r.error); };
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  var parts = dataUrl.split(',');
  var mime = (parts[0].match(/data:(.*?);/) || [])[1] || 'application/octet-stream';
  var bin = atob(parts[1]);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function shrinkImage(file, maxSide) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1) { resolve(file); return; }
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      var ctx = canvas.getContext('2d');
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ---------- PIN ----------

function hashPin(pin, salt) {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.subtle.digest) {
    var h = 0, s = salt + pin;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return Promise.resolve('plain-' + h.toString(16));
  }
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)).then(function (digest) {
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  });
}

function loadPinRecord() {
  try {
    var raw = localStorage.getItem(PIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ---------- Estado ----------

var state = {
  children: [],
  documents: [],
  reminders: [],
  tab: 'hijos',
  screen: { name: 'home' },
  locked: !!loadPinRecord(),
  dbError: '',
  toast: ''
};

var appEl = document.getElementById('app');
var toastTimer = null;

function showToast(msg) {
  state.toast = msg;
  renderToast();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { state.toast = ''; renderToast(); }, 2600);
}

function renderToast() {
  var el = document.getElementById('cs-toast');
  if (state.toast) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'cs-toast';
      el.className = 'cs-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = state.toast;
  } else if (el) {
    el.remove();
  }
}

function reload() {
  return Promise.all([getAll('children'), getAll('documents'), getAll('reminders')]).then(function (r) {
    state.children = r[0];
    state.documents = r[1];
    state.reminders = r[2];
    render();
    notifyDue();
  });
}

function notifyDue() {
  try {
    if (state.locked || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    var shown = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]');
    var due = state.reminders.filter(function (r) { return !r.done && daysUntil(r.date) <= 1 && shown.indexOf(r.id) < 0; });
    if (due.length === 0) return;
    var first = due[0];
    var child = state.children.find(function (c) { return c.id === first.childId; });
    var body = due.length === 1
      ? first.title + (child ? ' · ' + child.name : '') + ' · ' + formatDate(first.date)
      : due.length + ' recordatorios pendientes, el primero: ' + first.title;
    new Notification('Cuaderno de salud', { body: body });
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(shown.concat(due.map(function (r) { return r.id; }))));
  } catch (e) { /* sin notificaciones */ }
}

// ---------- Render ----------

function render() {
  var html = '<header class="cs-appheader"><h1>Cuaderno de salud</h1><p>Tus datos se guardan solo en este teléfono</p></header>';
  html += '<div id="cs-body">' + bodyHtml() + '</div>';
  html += '<footer class="cs-appfooter">Los datos viven en este dispositivo: descarga un respaldo desde Ajustes para no perderlos.</footer>';
  if (showTabs()) {
    html += '<nav class="cs-tabs" aria-label="Secciones">' +
      tabButton('hijos', '🧸', 'Hijos') + tabButton('proximos', '🔔', 'Próximos') + tabButton('ajustes', '⚙️', 'Ajustes') +
      '</nav>';
  }
  appEl.innerHTML = html;
  bindEvents();
  renderToast();
}

function tabButton(tab, icon, label) {
  return '<button class="cs-tab' + (state.tab === tab ? ' is-active' : '') + '" data-tab="' + tab + '"><span aria-hidden="true">' + icon + '</span>' + label + '</button>';
}

function showTabs() {
  var n = state.screen.name;
  return !state.locked && !state.dbError && !!db && (n === 'home' || n === 'settings' || n === 'remForm');
}

function bodyHtml() {
  if (state.locked) return lockHtml();
  if (state.dbError) return '<div class="cs-center"><div class="cs-callout cs-callout-warning"><span class="cs-callout-title">No se pudo abrir el cuaderno</span><p>' + esc(state.dbError) + '</p></div></div>';
  if (!db) return '<div class="cs-center"><p class="cs-muted">Cargando…</p></div>';
  var s = state.screen;
  switch (s.name) {
    case 'childForm': return childFormHtml(s.child);
    case 'child': return childDetailHtml(s.childId);
    case 'docForm': return docFormHtml();
    case 'docView': return docViewHtml(s.docId);
    case 'remForm': return remFormHtml(s.childId);
    default:
      if (state.tab === 'proximos') return remindersHtml();
      if (state.tab === 'ajustes') return settingsHtml();
      return homeHtml();
  }
}

function lockHtml() {
  return '<div class="cs-lock">' +
    '<div class="cs-lock-icon" aria-hidden="true">🔒</div>' +
    '<p class="cs-lock-title">Ingresa tu PIN</p>' +
    '<input id="cs-pin" class="cs-pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" aria-label="PIN" autocomplete="off">' +
    '<p id="cs-pin-error" class="cs-error cs-hidden">PIN incorrecto, inténtalo de nuevo.</p>' +
    '<p class="cs-muted cs-small">Si olvidaste tu PIN, tendrás que borrar los datos del sitio en el navegador y restaurar desde un respaldo.</p>' +
    '</div>';
}

function homeHtml() {
  if (state.children.length === 0) {
    return '<div class="cs-center">' +
      '<div class="cs-hero" aria-hidden="true">🧸</div>' +
      '<p class="cs-welcome">Bienvenida a tu cuaderno de salud digital.</p>' +
      '<p class="cs-muted">Aquí puedes guardar recetas, exámenes e informes de tus hijos, y llevar cuenta de vacunas y controles. Todo queda guardado únicamente en este teléfono.</p>' +
      '<button class="cs-btn cs-btn-primary" data-action="add-child">Agregar a mi primer hijo</button>' +
      '</div>';
  }
  var pending = state.reminders.filter(function (r) { return !r.done && daysUntil(r.date) <= 7; }).length;
  var html = '<div class="cs-list">';
  state.children.forEach(function (c) {
    var docCount = state.documents.filter(function (d) { return d.childId === c.id; }).length;
    html += '<button class="cs-child-card" data-open-child="' + c.id + '">' +
      '<span class="cs-avatar" aria-hidden="true">' + esc((c.name.trim().charAt(0) || '👶').toUpperCase()) + '</span>' +
      '<span class="cs-child-info"><span class="cs-child-name">' + esc(c.name) + '</span>' +
      '<span class="cs-child-sub">' + esc(ageText(c.birthdate)) + (docCount > 0 ? ' · ' + docCount + (docCount === 1 ? ' documento' : ' documentos') : '') + '</span></span>' +
      '<span class="cs-chevron" aria-hidden="true">›</span></button>';
  });
  html += '</div>';
  if (pending > 0) html += '<p class="cs-muted cs-small cs-center-text">Tienes ' + pending + (pending === 1 ? ' recordatorio' : ' recordatorios') + ' en los próximos 7 días. Revisa la pestaña Próximos.</p>';
  html += '<button class="cs-btn cs-btn-primary" data-action="add-child">Agregar hijo</button>';
  return html;
}

function childFormHtml(child) {
  child = child || null;
  return '<div class="cs-form">' +
    '<p class="cs-form-title">' + (child ? 'Editar datos' : 'Agregar hijo') + '</p>' +
    '<label class="cs-label">Nombre<input id="cf-name" class="cs-input" type="text" placeholder="Nombre y apellido" value="' + esc(child ? child.name : '') + '"></label>' +
    '<label class="cs-label">Fecha de nacimiento<input id="cf-birth" class="cs-input" type="date" max="' + todayISO() + '" value="' + esc(child ? child.birthdate : '') + '"></label>' +
    '<label class="cs-label">Notas (alergias, diagnósticos, lo que quieras tener a mano)<textarea id="cf-notes" class="cs-input cs-textarea" placeholder="Opcional" rows="3">' + esc(child ? child.notes : '') + '</textarea></label>' +
    '<div class="cs-row"><button class="cs-btn cs-btn-primary" data-action="save-child" data-child-id="' + esc(child ? child.id : '') + '">Guardar</button>' +
    '<button class="cs-btn cs-btn-ghost" data-action="cancel">Cancelar</button></div></div>';
}

function childDetailHtml(childId) {
  var child = state.children.find(function (c) { return c.id === childId; });
  if (!child) return '<div class="cs-center"><p class="cs-muted">No encontramos a este niño.</p><button class="cs-btn cs-btn-secondary" data-action="go-home">Volver</button></div>';
  var docs = state.documents.filter(function (d) { return d.childId === childId; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  var rems = state.reminders.filter(function (r) { return r.childId === childId && !r.done; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }).slice(0, 3);
  var filter = state.screen.filter || 'Todos';
  var shown = filter === 'Todos' ? docs : docs.filter(function (d) { return d.category === filter; });
  var used = ['Todos'].concat(CATEGORIES.filter(function (c) { return docs.some(function (d) { return d.category === c; }); }));

  var html = '<button class="cs-back" data-action="go-home">‹ Volver</button>' +
    '<div class="cs-child-head"><span class="cs-avatar cs-avatar-lg" aria-hidden="true">' + esc((child.name.trim().charAt(0) || '👶').toUpperCase()) + '</span>' +
    '<div><p class="cs-child-name-lg">' + esc(child.name) + '</p>' +
    '<p class="cs-muted">' + esc(ageText(child.birthdate)) + (child.birthdate ? ' · Nació el ' + formatDate(child.birthdate) : '') + '</p></div></div>';
  if (child.notes) html += '<div class="cs-notes"><span class="cs-notes-label">Notas</span>' + esc(child.notes) + '</div>';

  html += '<div class="cs-actions">' +
    '<button class="cs-action" data-action="take-photo"><span aria-hidden="true">📷</span>Tomar foto</button>' +
    '<button class="cs-action" data-action="upload-file"><span aria-hidden="true">📎</span>Subir archivo</button>' +
    '<button class="cs-action" data-action="add-reminder" data-child-id="' + child.id + '"><span aria-hidden="true">🔔</span>Recordatorio</button></div>' +
    '<input id="cs-camera" class="cs-hidden" type="file" accept="image/*" capture="environment">' +
    '<input id="cs-upload" class="cs-hidden" type="file" accept="image/*,application/pdf">';

  if (rems.length > 0) {
    html += '<div class="cs-section"><p class="cs-section-title">Próximos recordatorios</p>';
    rems.forEach(function (r) { html += remRowHtml(r); });
    html += '</div>';
  }

  html += '<div class="cs-section"><p class="cs-section-title">Documentos</p>';
  if (docs.length === 0) {
    html += '<p class="cs-muted">Aún no hay documentos. Toma una foto de una receta o sube un PDF para empezar.</p>';
  } else {
    html += '<div class="cs-chips">';
    used.forEach(function (c) { html += '<button class="cs-chip' + (filter === c ? ' is-active' : '') + '" data-filter="' + esc(c) + '">' + esc(c) + '</button>'; });
    html += '</div><div class="cs-list">';
    shown.forEach(function (d) {
      html += '<button class="cs-doc" data-open-doc="' + d.id + '">' +
        '<span class="cs-doc-icon" aria-hidden="true">' + (CATEGORY_ICON[d.category] || '📄') + '</span>' +
        '<span class="cs-doc-body"><span class="cs-doc-title">' + esc(d.title) + '</span>' +
        '<span class="cs-doc-sub">' + esc(d.category) + ' · ' + formatDate(d.date) + (d.mime === 'application/pdf' ? ' · PDF' : '') + '</span></span>' +
        '<span class="cs-chevron" aria-hidden="true">›</span></button>';
    });
    html += '</div>';
  }
  html += '</div>';
  html += '<div class="cs-row cs-row-end"><button class="cs-link" data-action="edit-child" data-child-id="' + child.id + '">Editar datos</button>' +
    '<button class="cs-link cs-link-danger" data-action="delete-child" data-child-id="' + child.id + '">Eliminar</button></div>';
  return html;
}

function docFormHtml() {
  var s = state.screen;
  var isImage = s.mime && s.mime.indexOf('image/') === 0;
  var preview = isImage
    ? '<img id="df-preview" class="cs-preview" alt="Vista previa del documento">'
    : '<div class="cs-preview cs-preview-pdf"><span aria-hidden="true">📄</span><span>' + esc(s.fileName || 'Documento PDF') + '</span></div>';
  var chips = CATEGORIES.map(function (c, i) {
    return '<button class="cs-chip' + (i === 0 ? ' is-active' : '') + '" data-category="' + esc(c) + '">' + CATEGORY_ICON[c] + ' ' + esc(c) + '</button>';
  }).join('');
  return '<div class="cs-form">' +
    '<p class="cs-form-title">Guardar documento</p>' + preview +
    '<label class="cs-label">Título<input id="df-title" class="cs-input" type="text" placeholder="Ej: Receta bronquitis"></label>' +
    '<label class="cs-label">Fecha del documento<input id="df-date" class="cs-input" type="date" value="' + todayISO() + '"></label>' +
    '<p class="cs-label-text">Categoría</p><div class="cs-chips" id="df-cats">' + chips + '</div>' +
    '<label class="cs-label">Nota (opcional)<input id="df-note" class="cs-input" type="text" placeholder="Ej: Dr. Pérez, repetir en 1 mes"></label>' +
    '<div class="cs-row"><button class="cs-btn cs-btn-primary" data-action="save-doc">Guardar</button>' +
    '<button class="cs-btn cs-btn-ghost" data-action="cancel-doc">Descartar</button></div></div>';
}

function docViewHtml(docId) {
  var doc = state.documents.find(function (d) { return d.id === docId; });
  if (!doc) return '<div class="cs-center"><p class="cs-muted">No encontramos este documento.</p><button class="cs-btn cs-btn-secondary" data-action="go-home">Volver</button></div>';
  var child = state.children.find(function (c) { return c.id === doc.childId; });
  var html = '<div class="cs-viewer">' +
    '<div class="cs-viewer-bar"><button class="cs-back" data-action="back-child" data-child-id="' + doc.childId + '">‹ Volver</button>' +
    '<button class="cs-link cs-link-danger" data-action="delete-doc" data-doc-id="' + doc.id + '">Eliminar</button></div>' +
    '<p class="cs-doc-title-lg">' + esc(doc.title) + '</p>' +
    '<p class="cs-muted">' + (CATEGORY_ICON[doc.category] || '📄') + ' ' + esc(doc.category) + ' · ' + formatDate(doc.date) + (child ? ' · ' + esc(child.name) : '') + '</p>';
  if (doc.note) html += '<p class="cs-notes">' + esc(doc.note) + '</p>';
  html += '<div id="dv-content"><p class="cs-muted">Cargando…</p></div></div>';
  return html;
}

function remRowHtml(r) {
  var child = state.children.find(function (c) { return c.id === r.childId; });
  var late = !r.done && daysUntil(r.date) < 0;
  return '<div class="cs-rem' + (r.done ? ' is-done' : '') + '">' +
    '<button class="cs-check" data-toggle-rem="' + r.id + '" aria-label="' + (r.done ? 'Marcar pendiente' : 'Marcar lista') + '">' + (r.done ? '✓' : '') + '</button>' +
    '<span class="cs-rem-icon" aria-hidden="true">' + (REMINDER_ICON[r.type] || '🔔') + '</span>' +
    '<span class="cs-rem-body"><span class="cs-rem-title">' + esc(r.title) + '</span>' +
    '<span class="cs-rem-date' + (late ? ' is-late' : '') + '">' + formatDate(r.date) + (child ? ' · ' + esc(child.name) : '') + (r.done ? '' : ' · ' + relDays(r.date)) + '</span></span>' +
    '<button class="cs-link cs-link-danger" data-delete-rem="' + r.id + '">Eliminar</button></div>';
}

function remindersHtml() {
  var html = '';
  var perm = 'unsupported';
  try { perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; } catch (e) { }
  if (perm === 'default') {
    html += '<div class="cs-callout cs-callout-note"><span class="cs-callout-title">Avisos en tu teléfono</span>' +
      '<p>Activa las notificaciones para que el cuaderno te avise de vacunas y controles al abrirlo.</p>' +
      '<button class="cs-btn cs-btn-secondary" data-action="enable-notif">Activar notificaciones</button></div>';
  } else if (perm === 'denied') {
    html += '<div class="cs-callout cs-callout-warning"><span class="cs-callout-title">Notificaciones bloqueadas</span>El navegador tiene las notificaciones bloqueadas para esta app. Puedes activarlas en la configuración del navegador; mientras tanto, esta lista siempre estará al día al abrir el cuaderno.</div>';
  }
  var pending = state.reminders.filter(function (r) { return !r.done; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  var done = state.reminders.filter(function (r) { return r.done; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  if (pending.length === 0 && done.length === 0) {
    html += '<div class="cs-center"><div class="cs-hero" aria-hidden="true">🔔</div>' +
      '<p class="cs-muted">Aún no hay recordatorios. Agrega la próxima vacuna o control para no olvidarlo.</p></div>';
  }
  if (pending.length > 0) {
    html += '<div class="cs-section"><p class="cs-section-title">Pendientes</p>';
    pending.forEach(function (r) { html += remRowHtml(r); });
    html += '</div>';
  }
  if (done.length > 0) {
    html += '<div class="cs-section"><p class="cs-section-title">Listos</p>';
    done.forEach(function (r) { html += remRowHtml(r); });
    html += '</div>';
  }
  html += '<button class="cs-btn cs-btn-primary" data-action="add-reminder">Agregar recordatorio</button>' +
    '<p class="cs-muted cs-small">Las notificaciones del navegador solo funcionan con la app abierta o recién usada. La lista de pendientes siempre está disponible aquí.</p>';
  return html;
}

function remFormHtml(initialChildId) {
  if (state.children.length === 0) {
    return '<div class="cs-center"><p class="cs-muted">Primero agrega a un hijo en la pestaña Hijos.</p><button class="cs-btn cs-btn-secondary" data-action="go-proximos">Volver</button></div>';
  }
  var selected = initialChildId || state.children[0].id;
  var chips = state.children.map(function (c) {
    return '<button class="cs-chip' + (selected === c.id ? ' is-active' : '') + '" data-rem-child="' + c.id + '">' + esc(c.name) + '</button>';
  }).join('');
  var typeChips = REMINDER_TYPES.map(function (t, i) {
    return '<button class="cs-chip' + (i === 0 ? ' is-active' : '') + '" data-rem-type="' + esc(t) + '">' + REMINDER_ICON[t] + ' ' + esc(t) + '</button>';
  }).join('');
  return '<div class="cs-form">' +
    '<p class="cs-form-title">Nuevo recordatorio</p>' +
    '<p class="cs-label-text">¿Para quién?</p><div class="cs-chips" id="rf-children">' + chips + '</div>' +
    '<label class="cs-label">¿Qué hay que recordar?<input id="rf-title" class="cs-input" type="text" placeholder="Ej: Vacuna influenza"></label>' +
    '<p class="cs-label-text">Tipo</p><div class="cs-chips" id="rf-types">' + typeChips + '</div>' +
    '<label class="cs-label">Fecha<input id="rf-date" class="cs-input" type="date"></label>' +
    '<div class="cs-row"><button class="cs-btn cs-btn-primary" data-action="save-rem">Guardar</button>' +
    '<button class="cs-btn cs-btn-ghost" data-action="go-proximos">Cancelar</button></div></div>';
}

function settingsHtml() {
  var hasPin = !!loadPinRecord();
  var html = '<div class="cs-section"><p class="cs-section-title">Respaldo</p>' +
    '<p class="cs-muted">Todo se guarda solo en este teléfono: si borras la app o los datos del navegador, la información se pierde. Descarga un respaldo de vez en cuando y guárdalo en un lugar seguro.</p>' +
    '<div class="cs-row"><button class="cs-btn cs-btn-secondary" data-action="export">Descargar respaldo</button>' +
    '<button class="cs-btn cs-btn-secondary" data-action="import">Restaurar respaldo</button></div>' +
    '<input id="cs-import" class="cs-hidden" type="file" accept="application/json,.json"></div>';

  html += '<div class="cs-section"><p class="cs-section-title">PIN de acceso</p>' +
    '<p class="cs-muted">Un PIN evita que otras personas (o los mismos niños) abran el cuaderno en este teléfono.</p>' +
    '<div class="cs-row">';
  if (!hasPin) {
    html += '<button class="cs-btn cs-btn-secondary" data-action="pin-set">Activar PIN</button>';
  } else {
    html += '<button class="cs-btn cs-btn-secondary" data-action="pin-set">Cambiar PIN</button>' +
      '<button class="cs-btn cs-btn-ghost" data-action="pin-remove">Quitar PIN</button>' +
      '<button class="cs-btn cs-btn-ghost" data-action="pin-lock">Bloquear ahora</button>';
  }
  html += '</div><div id="cs-pin-form"></div></div>';

  html += '<div class="cs-section"><p class="cs-section-title">Privacidad</p>' +
    '<p class="cs-muted">Este cuaderno no envía información a internet: los datos y los documentos quedan almacenados únicamente en este teléfono, bajo tu control.</p></div>';
  return html;
}

// ---------- Eventos ----------

function bindEvents() {
  appEl.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.tab = btn.getAttribute('data-tab');
      state.screen = btn.getAttribute('data-tab') === 'ajustes' ? { name: 'settings' } : { name: 'home' };
      render();
    });
  });
  appEl.querySelectorAll('[data-action]').forEach(function (el) {
    el.addEventListener('click', function () { onAction(el.getAttribute('data-action'), el); });
  });
  appEl.querySelectorAll('[data-open-child]').forEach(function (el) {
    el.addEventListener('click', function () { state.screen = { name: 'child', childId: el.getAttribute('data-open-child') }; render(); });
  });
  appEl.querySelectorAll('[data-open-doc]').forEach(function (el) {
    el.addEventListener('click', function () { openDoc(el.getAttribute('data-open-doc')); });
  });
  appEl.querySelectorAll('[data-filter]').forEach(function (el) {
    el.addEventListener('click', function () { state.screen.filter = el.getAttribute('data-filter'); render(); });
  });
  appEl.querySelectorAll('[data-toggle-rem]').forEach(function (el) {
    el.addEventListener('click', function () {
      var rem = state.reminders.find(function (r) { return r.id === el.getAttribute('data-toggle-rem'); });
      if (rem) put('reminders', Object.assign({}, rem, { done: !rem.done })).then(reload);
    });
  });
  appEl.querySelectorAll('[data-delete-rem]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (!window.confirm('¿Eliminar este recordatorio?')) return;
      del('reminders', el.getAttribute('data-delete-rem')).then(reload);
    });
  });

  var cam = document.getElementById('cs-camera');
  if (cam) cam.addEventListener('change', function () { onFilePicked(cam.files); cam.value = ''; });
  var up = document.getElementById('cs-upload');
  if (up) up.addEventListener('change', function () { onFilePicked(up.files); up.value = ''; });
  var imp = document.getElementById('cs-import');
  if (imp) imp.addEventListener('change', function () { if (imp.files && imp.files[0]) importBackup(imp.files[0]); imp.value = ''; });

  var pin = document.getElementById('cs-pin');
  if (pin) {
    pin.focus();
    pin.addEventListener('input', function () {
      pin.value = pin.value.replace(/\D/g, '');
      pin.classList.remove('is-error');
      var err = document.getElementById('cs-pin-error');
      if (err) err.classList.add('cs-hidden');
      if (pin.value.length >= 4) tryUnlock(pin.value);
    });
  }

  bindChipGroup('df-cats', 'data-category');
  bindChipGroup('rf-children', 'data-rem-child');
  bindChipGroup('rf-types', 'data-rem-type');

  var preview = document.getElementById('df-preview');
  if (preview && state.screen.file) preview.src = URL.createObjectURL(state.screen.file);
}

function bindChipGroup(id, attr) {
  var group = document.getElementById(id);
  if (!group) return;
  group.querySelectorAll('[' + attr + ']').forEach(function (chip) {
    chip.addEventListener('click', function () {
      group.querySelectorAll('.cs-chip').forEach(function (c) { c.classList.remove('is-active'); });
      chip.classList.add('is-active');
    });
  });
}

function chipValue(id, attr) {
  var group = document.getElementById(id);
  if (!group) return '';
  var active = group.querySelector('.cs-chip.is-active');
  return active ? active.getAttribute(attr) : '';
}

function onAction(action, el) {
  switch (action) {
    case 'add-child':
      state.screen = { name: 'childForm', child: null };
      render();
      focusFirst('cf-name');
      break;
    case 'cancel':
    case 'go-home':
      state.screen = { name: 'home' };
      state.tab = 'hijos';
      render();
      break;
    case 'go-proximos':
      state.screen = { name: 'home' };
      state.tab = 'proximos';
      render();
      break;
    case 'save-child': {
      var name = document.getElementById('cf-name').value.trim();
      if (!name) return;
      var id = el.getAttribute('data-child-id') || uid();
      var existing = state.children.find(function (c) { return c.id === id; });
      put('children', {
        id: id,
        name: name,
        birthdate: document.getElementById('cf-birth').value,
        notes: document.getElementById('cf-notes').value.trim(),
        createdAt: existing ? existing.createdAt : Date.now()
      }).then(function () { return reload(); }).then(function () {
        showToast('Guardado');
        state.screen = { name: 'home' };
        state.tab = 'hijos';
        render();
      });
      break;
    }
    case 'edit-child': {
      var child = state.children.find(function (c) { return c.id === el.getAttribute('data-child-id'); });
      if (child) { state.screen = { name: 'childForm', child: child }; render(); }
      break;
    }
    case 'delete-child': {
      var c2 = state.children.find(function (c) { return c.id === el.getAttribute('data-child-id'); });
      if (!c2) return;
      if (!window.confirm('¿Eliminar a ' + c2.name + ' con todos sus documentos y recordatorios? Esta acción no se puede deshacer.')) return;
      var docs = state.documents.filter(function (d) { return d.childId === c2.id; });
      var rems = state.reminders.filter(function (r) { return r.childId === c2.id; });
      var chain = Promise.resolve();
      docs.forEach(function (d) { chain = chain.then(function () { return del('files', d.id); }).then(function () { return del('documents', d.id); }); });
      rems.forEach(function (r) { chain = chain.then(function () { return del('reminders', r.id); }); });
      chain.then(function () { return del('children', c2.id); }).then(reload).then(function () {
        showToast('Eliminado');
        state.screen = { name: 'home' };
        state.tab = 'hijos';
        render();
      });
      break;
    }
    case 'take-photo':
      document.getElementById('cs-camera').click();
      break;
    case 'upload-file':
      document.getElementById('cs-upload').click();
      break;
    case 'add-reminder':
      state.screen = { name: 'remForm', childId: el.getAttribute('data-child-id') || undefined };
      render();
      focusFirst('rf-title');
      break;
    case 'save-doc': {
      var title = document.getElementById('df-title').value.trim();
      var date = document.getElementById('df-date').value;
      if (!title || !date) return;
      var s = state.screen;
      var meta = {
        id: uid(), childId: s.childId, title: title, date: date,
        category: chipValue('df-cats', 'data-category') || 'Otro',
        note: document.getElementById('df-note').value.trim(),
        mime: s.mime, fileName: s.fileName, createdAt: Date.now()
      };
      put('documents', meta).then(function () { return put('files', { id: meta.id, blob: s.file }); }).then(reload).then(function () {
        showToast('Documento guardado');
        state.screen = { name: 'child', childId: meta.childId };
        render();
      });
      break;
    }
    case 'cancel-doc': {
      var cid = state.screen.childId;
      state.screen = { name: 'child', childId: cid };
      render();
      break;
    }
    case 'back-child':
      state.screen = { name: 'child', childId: el.getAttribute('data-child-id') };
      render();
      break;
    case 'delete-doc': {
      var docId = el.getAttribute('data-doc-id');
      var doc = state.documents.find(function (d) { return d.id === docId; });
      if (!doc || !window.confirm('¿Eliminar este documento?')) return;
      del('files', docId).then(function () { return del('documents', docId); }).then(reload).then(function () {
        showToast('Documento eliminado');
        state.screen = { name: 'child', childId: doc.childId };
        render();
      });
      break;
    }
    case 'save-rem': {
      var rTitle = document.getElementById('rf-title').value.trim();
      var rDate = document.getElementById('rf-date').value;
      var rChild = chipValue('rf-children', 'data-rem-child');
      if (!rTitle || !rDate || !rChild) return;
      put('reminders', {
        id: uid(), childId: rChild, title: rTitle,
        type: chipValue('rf-types', 'data-rem-type') || 'Otro',
        date: rDate, done: false, createdAt: Date.now()
      }).then(reload).then(function () {
        showToast('Recordatorio guardado');
        state.screen = { name: 'home' };
        state.tab = 'proximos';
        render();
      });
      break;
    }
    case 'enable-notif':
      try {
        Notification.requestPermission().then(function () { render(); });
      } catch (e) { render(); }
      break;
    case 'export':
      exportBackup();
      break;
    case 'import':
      document.getElementById('cs-import').click();
      break;
    case 'pin-set':
      pinFormHtml('set');
      break;
    case 'pin-remove':
      pinFormHtml('remove');
      break;
    case 'pin-lock':
      state.locked = true;
      render();
      break;
  }
}

function focusFirst(id) {
  var el = document.getElementById(id);
  if (el) el.focus();
}

function onFilePicked(files) {
  var f = files && files[0];
  if (!f) return;
  var mime = f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  var childId = state.screen.childId;
  var done = function (blob) {
    state.screen = { name: 'docForm', childId: childId, file: blob, mime: blob.type || mime, fileName: f.name };
    render();
    focusFirst('df-title');
  };
  if (mime.indexOf('image/') === 0) shrinkImage(f, 1600).then(done);
  else done(f);
}

function openDoc(docId) {
  state.screen = { name: 'docView', docId: docId };
  render();
  getOne('files', docId).then(function (rec) {
    var container = document.getElementById('dv-content');
    if (!container) return;
    if (!rec) { container.innerHTML = '<p class="cs-muted">No se encontró el archivo.</p>'; return; }
    var url = URL.createObjectURL(rec.blob);
    var doc = state.documents.find(function (d) { return d.id === docId; });
    if (doc && doc.mime === 'application/pdf') {
      container.innerHTML = '<iframe class="cs-doc-pdf" src="' + url + '" title="' + esc(doc.title) + '"></iframe>' +
        '<a class="cs-btn cs-btn-secondary" href="' + url + '" target="_blank" rel="noreferrer">Abrir PDF en pantalla completa</a>';
    } else {
      container.innerHTML = '<a href="' + url + '" target="_blank" rel="noreferrer"><img class="cs-doc-img" src="' + url + '" alt="' + esc(doc ? doc.title : '') + '"></a>' +
        '<p class="cs-muted cs-small cs-center-text">Toca la imagen para verla en grande.</p>';
    }
  });
}

// ---------- PIN ----------

function tryUnlock(value) {
  var rec = loadPinRecord();
  if (!rec) { state.locked = false; render(); return; }
  hashPin(value, rec.salt).then(function (hash) {
    if (hash === rec.hash) {
      state.locked = false;
      render();
      notifyDue();
    } else {
      var pin = document.getElementById('cs-pin');
      var err = document.getElementById('cs-pin-error');
      if (pin) { pin.value = ''; pin.classList.add('is-error'); pin.focus(); }
      if (err) err.classList.remove('cs-hidden');
    }
  });
}

function pinFormHtml(mode) {
  var holder = document.getElementById('cs-pin-form');
  if (!holder) return;
  holder.innerHTML = '<div class="cs-form" style="margin-top:10px">' +
    '<label class="cs-label">' + (mode === 'set' ? 'Elige un PIN de 4 a 6 dígitos' : 'Ingresa tu PIN actual') +
    '<input id="ps-pin" class="cs-pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"></label>' +
    '<div class="cs-row"><button class="cs-btn cs-btn-primary" id="ps-save">' + (mode === 'set' ? 'Guardar PIN' : 'Confirmar') + '</button>' +
    '<button class="cs-btn cs-btn-ghost" id="ps-cancel">Cancelar</button></div>' +
    '<p id="ps-msg" class="cs-muted cs-small"></p></div>';
  var input = document.getElementById('ps-pin');
  input.focus();
  input.addEventListener('input', function () { input.value = input.value.replace(/\D/g, ''); });
  document.getElementById('ps-cancel').addEventListener('click', function () { holder.innerHTML = ''; });
  document.getElementById('ps-save').addEventListener('click', function () {
    var value = input.value;
    if (value.length < 4) return;
    if (mode === 'set') {
      var salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
      hashPin(value, salt).then(function (hash) {
        try {
          localStorage.setItem(PIN_KEY, JSON.stringify({ salt: salt, hash: hash }));
          render();
          setTimeout(function () { showToast('PIN activado. Se pedirá cada vez que abras el cuaderno.'); }, 50);
        } catch (e) {
          document.getElementById('ps-msg').textContent = 'Este navegador no permite guardar el PIN. El cuaderno seguirá funcionando sin bloqueo.';
        }
      });
    } else {
      var rec = loadPinRecord();
      hashPin(value, rec ? rec.salt : '').then(function (hash) {
        if (rec && hash === rec.hash) {
          try { localStorage.removeItem(PIN_KEY); } catch (e) { }
          render();
          setTimeout(function () { showToast('PIN eliminado.'); }, 50);
        } else {
          document.getElementById('ps-msg').textContent = 'PIN incorrecto.';
          input.value = '';
        }
      });
    }
  });
}

// ---------- Respaldo ----------

function exportBackup() {
  showToast('Preparando respaldo…');
  Promise.all([getAll('children'), getAll('documents'), getAll('reminders'), getAll('files')]).then(function (r) {
    var fileMap = {};
    var chain = Promise.resolve();
    r[3].forEach(function (f) {
      chain = chain.then(function () { return blobToDataUrl(f.blob); }).then(function (url) { fileMap[f.id] = url; });
    });
    return chain.then(function () {
      return { version: 1, exportedAt: new Date().toISOString(), children: r[0], documents: r[1], reminders: r[2], files: fileMap };
    });
  }).then(function (payload) {
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cuaderno-salud-respaldo-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    showToast('Respaldo descargado');
  });
}

function importBackup(file) {
  file.text().then(function (text) {
    var data = JSON.parse(text);
    if (!data || !Array.isArray(data.children) || !Array.isArray(data.documents)) {
      window.alert('Este archivo no parece un respaldo del cuaderno.');
      return;
    }
    var chain = Promise.resolve();
    data.children.forEach(function (c) { chain = chain.then(function () { return put('children', c); }); });
    data.documents.forEach(function (d) {
      chain = chain.then(function () { return put('documents', d); }).then(function () {
        var dataUrl = (data.files || {})[d.id];
        if (dataUrl) return put('files', { id: d.id, blob: dataUrlToBlob(dataUrl) });
      });
    });
    (data.reminders || []).forEach(function (r) { chain = chain.then(function () { return put('reminders', r); }); });
    chain.then(reload).then(function () {
      showToast('Respaldo restaurado');
      state.screen = { name: 'home' };
      state.tab = 'hijos';
      render();
    });
  }).catch(function () {
    window.alert('No se pudo leer el respaldo.');
  });
}

// ---------- Datos de demostración (#demo) ----------

function seedDemo() {
  if (location.hash !== '#demo') return Promise.resolve(false);
  var childId = 'demo-child-1';
  var docId = 'demo-doc-1';
  var canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 800;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 600, 800);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 4; ctx.strokeRect(20, 20, 560, 760);
  ctx.fillStyle = '#251f21'; ctx.font = '28px sans-serif';
  ctx.fillText('RECETA MÉDICA', 60, 100);
  ctx.font = '22px sans-serif';
  ctx.fillText('Salbutamol inhalador 100 mcg', 60, 170);
  ctx.fillText('2 puff cada 6 horas por 5 días', 60, 210);
  ctx.fillText('Control en 2 semanas', 60, 260);
  return new Promise(function (resolve) {
    canvas.toBlob(function (blob) {
      var chain = put('children', { id: childId, name: 'Emilia', birthdate: '2021-03-15', notes: 'Alérgica a la amoxicilina', createdAt: Date.now() });
      chain = chain.then(function () {
        return put('documents', { id: docId, childId: childId, title: 'Receta bronquitis', date: todayISO(), category: 'Receta', note: 'Dra. Helly', mime: 'image/jpeg', fileName: 'receta.jpg', createdAt: Date.now() });
      });
      chain = chain.then(function () { return put('files', { id: docId, blob: blob }); });
      var soon = new Date(); soon.setDate(soon.getDate() + 5);
      function p(n) { return String(n).padStart(2, '0'); }
      var soonISO = soon.getFullYear() + '-' + p(soon.getMonth() + 1) + '-' + p(soon.getDate());
      chain = chain.then(function () { return put('reminders', { id: 'demo-rem-1', childId: childId, title: 'Control broncopulmonar', type: 'Control', date: soonISO, done: false, createdAt: Date.now() }); });
      chain.then(function () { resolve(true); });
    }, 'image/jpeg', 0.85);
  });
}

// ---------- Inicio ----------

openDb().then(function (d) {
  db = d;
  return seedDemo();
}).then(function () {
  return reload();
}).catch(function () {
  state.dbError = 'Este navegador no permite guardar datos localmente. Prueba abrir el cuaderno en Safari o Chrome.';
  render();
});

if (!state.locked) render();
else render();

if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  });
}

})();
