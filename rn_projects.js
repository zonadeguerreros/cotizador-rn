/* Proyectos de mano de obra. Almacenamiento independiente del cotizador original. */
(function () {
  'use strict';
  const root = document.getElementById('tab-proyectos');
  let data = null, timer, queue = Promise.resolve(), ready = false, busy = false, pendingAvanceFiles = [];
  const escape = escHtml;
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => 'PR-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  /* === SINCRONIZACION EN LA NUBE DE PROYECTOS (Firestore + Storage) ===
     Guarda el texto de los proyectos en Firestore y las fotos en Storage,
     para verlos desde cualquier dispositivo. Si no hay internet o el plan
     de Firebase no tiene Storage activo, los proyectos siguen guardandose
     100% en este equipo como siempre. */
  const CLOUD_DELK = 'rn_proj_del';
  let cloudReady = false, cloudApplyingRemote = false, cloudPendingPush = false, cloudDoc = null, mergeChain = Promise.resolve();
  function cloudDelGet() { try { return JSON.parse(localStorage.getItem(CLOUD_DELK)) || []; } catch (e) { return []; } }
  function cloudDelSet(arr) { try { localStorage.setItem(CLOUD_DELK, JSON.stringify(arr.slice(-500))); } catch (e) {} }
  function cloudStrip(list) {
    return (list || []).map(p => Object.assign({}, p, {
      photos: (p.photos || []).map(ph => ({name: ph.name, caption: ph.caption, storagePath: ph.storagePath || null})),
      avances: (p.avances || []).map(av => ({
        id: av.id, date: av.date, note: av.note, amount: av.amount || 0,
        attachments: (av.attachments || []).map(a => ({name: a.name, type: a.type, storagePath: a.storagePath || null}))
      }))
    }));
  }
  async function cloudUploadPhotos(project) {
    if (!window.firebase || !firebase.storage) return;
    for (const ph of project.photos) {
      if (ph.data && !ph.storagePath) {
        try {
          const path = 'photos/' + project.id + '/' + uid() + '.jpg';
          await firebase.storage().ref(path).putString(ph.data, 'data_url');
          ph.storagePath = path;
        } catch (e) { console.warn('No se pudo subir una fotografia a la nube', e); }
      }
    }
  }
  function deleteStoragePhoto(storagePath) {
    if (!window.firebase || !firebase.storage) return;
    firebase.storage().ref(storagePath).delete().catch(e => console.warn('No se pudo borrar una fotografia de la nube', e));
  }
  async function cloudUploadAvanceFiles(project) {
    if (!window.firebase || !firebase.storage) return;
    for (const av of (project.avances || [])) {
      for (const a of (av.attachments || [])) {
        if (a.data && !a.storagePath) {
          try {
            const ext = a.type === 'pdf' ? '.pdf' : '.jpg';
            const path = 'avances/' + project.id + '/' + av.id + '/' + uid() + ext;
            await firebase.storage().ref(path).putString(a.data, 'data_url');
            a.storagePath = path;
          } catch (e) { console.warn('No se pudo subir un adjunto de avance a la nube', e); }
        }
      }
    }
  }
  function buildClientView(p) {
    return {
      title: p.title || '', client: p.client || '', location: p.location || '', date: p.date || '', author: p.author || '',
      number: p.number || '', intro: p.intro || '', diagnosis: p.diagnosis || '', corrections: p.corrections || '',
      references: p.references || '', scope: p.scope || '', conditions: p.conditions || '', approval: p.approval || '',
      representative: p.representative || '', items: p.items || [],
      photos: (p.photos || []).map(ph => ({name: ph.name, caption: ph.caption, storagePath: ph.storagePath || null})),
      avances: (p.avances || []).map(av => ({
        id: av.id, date: av.date, note: av.note, amount: av.amount || 0,
        attachments: (av.attachments || []).map(a => ({name: a.name, type: a.type, storagePath: a.storagePath || null}))
      })),
      updatedAt: Date.now()
    };
  }
  async function updateClientMirror(project) {
    if (!window.firebase || !firebase.firestore) return;
    try {
      /* set(...,{merge:true}) para no borrar clientUid/clientApproved, que
         se escriben por separado cuando el dueño aprueba un acceso. */
      await firebase.firestore().collection('clientView').doc(project.id).set(buildClientView(project), {merge: true});
    } catch (e) { console.warn('No se pudo actualizar la vista del cliente', e); }
  }
  async function cloudPushProjects() {
    if (!cloudReady || !cloudDoc) { cloudPendingPush = true; return; }
    try {
      for (const p of data.projects) { await cloudUploadPhotos(p); await cloudUploadAvanceFiles(p); await updateClientMirror(p); }
      await cloudDoc.set({projects: cloudStrip(data.projects), deleted: cloudDelGet(), updatedAt: firebase.firestore.FieldValue.serverTimestamp()});
    } catch (e) { console.warn('Sync proyectos: no se pudo guardar en la nube', e); }
  }
  async function cloudDownloadFile(storagePath) {
    const url = await firebase.storage().ref(storagePath).getDownloadURL();
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  function cloudMergeAndApply(cloudList, cloudDeleted) {
    /* Se encadenan las fusiones para que nunca corran dos al mismo tiempo:
       si llega un segundo cambio remoto mientras se procesa el anterior
       (que puede tardar varios segundos bajando fotos), se espera su turno
       en vez de pisar el resultado del que ya estaba corriendo. */
    mergeChain = mergeChain.catch(() => {}).then(() => cloudMergeAndApplyImpl(cloudList, cloudDeleted));
    return mergeChain;
  }
  async function cloudMergeAndApplyImpl(cloudList, cloudDeleted) {
    if (!ready) return;
    const delAll = {};
    cloudDelGet().concat(cloudDeleted || []).forEach(id => { delAll[id] = 1; });
    const unionDel = Object.keys(delAll);
    /* Se guarda localmente la union de borrados para que este dispositivo
       nunca "olvide" un borrado que ya conocia la nube. */
    if (unionDel.length !== cloudDelGet().length) cloudDelSet(unionDel);
    const localById = {}, order = [];
    (data.projects || []).forEach(p => { if (p && p.id && !delAll[p.id]) { localById[p.id] = p; order.push(p.id); } });
    const cloudById = {};
    (cloudList || []).forEach(p => { if (p && p.id && !delAll[p.id]) cloudById[p.id] = p; });
    Object.keys(cloudById).forEach(id => { if (!localById[id]) order.push(id); });
    const takeCloud = [];
    order.forEach(id => {
      const lp = localById[id], cp = cloudById[id];
      if (cp && (!lp || (cp.updatedAt || 0) > (lp.updatedAt || 0))) takeCloud.push(id);
    });
    for (const id of takeCloud) {
      const p = cloudById[id], kept = [];
      for (const ph of (p.photos || [])) {
        if (!ph.data && ph.storagePath) {
          try { ph.data = await cloudDownloadFile(ph.storagePath); kept.push(ph); }
          catch (e) { console.warn('No se pudo bajar una fotografia de la nube, se omite:', e); }
        } else if (ph.data) kept.push(ph);
      }
      p.photos = kept;
      for (const av of (p.avances || [])) {
        const keptAtt = [];
        for (const a of (av.attachments || [])) {
          if (!a.data && a.storagePath) {
            try { a.data = await cloudDownloadFile(a.storagePath); keptAtt.push(a); }
            catch (e) { console.warn('No se pudo bajar un adjunto de avance, se omite:', e); }
          } else if (a.data) keptAtt.push(a);
        }
        av.attachments = keptAtt;
      }
    }
    const merged = order.map(id => takeCloud.includes(id) ? cloudById[id] : localById[id]);
    /* Tambien cuenta como cambio si un proyecto local quedo excluido solo por
       tombstone (borrado en otro dispositivo), aunque no venga nada nuevo. */
    if (takeCloud.length || merged.length !== (data.projects || []).length) {
      cloudApplyingRemote = true;
      data.projects = merged;
      await persist();
      cloudApplyingRemote = false;
      if (S.tab === 'proyectos') renderHistory();
    }
    /* Si algun proyecto local quedo mas nuevo o presente solo aqui, se sube. */
    const needPush = order.some(id => (localById[id] && !takeCloud.includes(id)) &&
      (!cloudById[id] || (localById[id].updatedAt || 0) > (cloudById[id].updatedAt || 0)));
    if (needPush || (cloudDeleted || []).length !== unionDel.length) cloudPushProjects();
  }
  function cloudSubscribe(attempt) {
    cloudDoc.onSnapshot(doc => {
      if (window.setSyncStatus) setSyncStatus(true);
      const d = doc.exists ? doc.data() : {};
      cloudMergeAndApply(Array.isArray(d.projects) ? d.projects : [], Array.isArray(d.deleted) ? d.deleted : []);
    }, err => {
      if (err && err.code === 'permission-denied' && attempt < 5) setTimeout(() => cloudSubscribe(attempt + 1), 1000 * (attempt + 1));
      else { console.warn('Sync proyectos:', err); if (window.setSyncStatus) setSyncStatus(false); }
    });
  }
  function cloudInit() {
    if (!window.firebase || !firebase.firestore) return;
    cloudDoc = firebase.firestore().collection('sync').doc('proyectos');
    const onUser = user => {
      if (!user || cloudReady) return;
      cloudReady = true;
      cloudSubscribe(0);
      if (cloudPendingPush) { cloudPendingPush = false; cloudPushProjects(); }
    };
    if (firebase.auth().currentUser) onUser(firebase.auth().currentUser);
    firebase.auth().onAuthStateChanged(onUser);
  }

  function blank() {
    const now = new Date();
    return {id: uid(), number: 'RN-P-' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + now.getTime().toString().slice(-5), title: '', client: '', location: '', author: 'Cristhian Sandoval - Cristopher Solis', date: now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()), intro: '', diagnosis: '', corrections: '', references: '', scope: 'El presupuesto considera la ejecución de los trabajos detallados, incluyendo mano de obra y servicios técnicos. Los materiales nuevos se cotizarán por separado, previa confirmación de cantidades y aprobación del cliente.', conditions: 'Programación, plazo de ejecución y forma de pago: por acordar por escrito antes del inicio de los trabajos.', approval: 'Con su firma, el cliente acepta los trabajos, alcances, valores y condiciones indicados en este documento. Cualquier modificación o trabajo adicional deberá ser informado y aprobado por escrito antes de su ejecución.', representative: 'Cristhian Sandoval Parra', items: [], photos: [], avances: [], updatedAt: 0};
  }
  function status(message, error) {
    const el = document.getElementById('pr-status');
    if (el) { el.textContent = message; el.style.color = error ? '#b91c1c' : '#166534'; }
  }
  function persist() {
    clearTimeout(timer);
    status('Guardando…');
    const snapshot = clone(data);
    queue = queue.catch(() => {}).then(async () => {
      const result = await window.pywebview.api.save_projects(snapshot);
      if (!result.ok) throw new Error(result.error);
      status('Borrador guardado en este equipo.');
      if (!cloudApplyingRemote) cloudPushProjects();
      return true;
    });
    return queue.catch(error => { status(error.message, true); return false; });
  }
  function changed() { persist(); }
  function field(key, label, multiline = false, placeholder = '') {
    const value = escape(data.draft[key]);
    return `<div><label class="L" for="pr-${key}">${label}</label>${multiline ? `<textarea id="pr-${key}" data-field="${key}" rows="5" placeholder="${escape(placeholder)}">${value}</textarea>` : `<input id="pr-${key}" data-field="${key}" type="${key === 'date' ? 'date' : 'text'}" value="${value}">`}</div>`;
  }
  function totals() {
    const net = data.draft.items.reduce((sum, row) => sum + row.price, 0);
    const tax = Number((BigInt(net) * 19n + 50n) / 100n);
    return {net, tax, total: net + tax}; } function grandTotals() { const base = totals(); const extra = (data.draft.avances || []).reduce((sum, av) => sum + (av.amount || 0), 0); const net = base.net + extra; const tax = Number((BigInt(net) * 19n + 50n) / 100n); return {net, tax, total: net + tax};
  }
  function updateTotals() {
    const values = totals();
    ['net', 'tax', 'total'].forEach(key => { const el = document.getElementById('pr-' + key); if (el) el.textContent = fm(values[key]); });
    renderBudgetTotal();
  }
  function renderBudgetTotal() {
    const t = grandTotals();
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('pr-budget-total-price', fm(t.total));
    set('pr-budget-total-net', fm(t.net));
    set('pr-budget-total-iva', fm(t.tax));
    set('pr-budget-total-total', fm(t.total));
    const rowsEl = document.getElementById('pr-budget-total-rows');
    if (rowsEl) { const itemRows = data.draft.items.map((row, i) => `<tr><td>${i + 1}</td><td>${escape(row.name)}${row.origin ? `<div style="font-size:11px;color:var(--mut);margin-top:2px">Ref.: ${escape(row.origin)}</div>` : ''}</td><td>${escape(row.scope)}</td><td>${fm(row.price)}</td></tr>`); const extraRows = (data.draft.avances || []).filter(av => av.amount).map((av, i) => `<tr><td>${data.draft.items.length + i + 1}</td><td>Avance ${escape(av.date)}${av.note ? ` — ${escape(av.note.slice(0, 60))}` : ''}</td><td>Ver avance del ${escape(av.date)}</td><td>${fm(av.amount)}</td></tr>`); rowsEl.innerHTML = itemRows.concat(extraRows).join(''); }
  }
  function renderRows() {
    document.getElementById('pr-rows').innerHTML = data.draft.items.map((row, i) => `<tr><td>${i + 1}</td><td><textarea aria-label="Trabajo ${i + 1}" data-row="${i}" data-key="name" rows="3">${escape(row.name)}</textarea><input aria-label="Referencia de origen ${i + 1}" type="text" data-row="${i}" data-key="origin" value="${escape(row.origin || '')}" placeholder="Ref. opcional si viene de un anexo/avance (ej: Anexo técnico N°1)" style="margin-top:6px;font-size:11px"></td><td><textarea aria-label="Alcance ${i + 1}" data-row="${i}" data-key="scope" rows="3">${escape(row.scope)}</textarea></td><td><input aria-label="Valor neto ${i + 1}" type="number" min="0" max="999999999999" step="1" data-row="${i}" data-key="price" value="${row.price}"></td><td><button class="btn bh xs" data-action="remove-row" data-index="${i}" aria-label="Quitar trabajo ${i + 1}">Quitar</button></td></tr>`).join('');
    updateTotals();
  }
  function renderPhotos() {
    document.getElementById('pr-photos').innerHTML = data.draft.photos.map((photo, i) => `<div class="card pr-photo"><img src="${photo.data}" alt="Fotografía ${i + 1}"><div><label class="L">Fotografía ${i + 1} · Equipo / Lugar</label><input aria-label="Equipo fotografía ${i + 1}" data-photo="${i}" data-key="name" value="${escape(photo.name)}"><label class="L" style="margin-top:10px">Estado / Observación</label><textarea aria-label="Observación fotografía ${i + 1}" data-photo="${i}" data-key="caption" rows="4">${escape(photo.caption)}</textarea><button class="btn bh sm" data-action="remove-photo" data-index="${i}" style="margin-top:10px">Quitar fotografía</button></div></div>`).join('');
  }
  function renderAvances() {
    const el = document.getElementById('av-list');
    if (!el) return;
    const list = data.draft.avances || [];
    /* Mas nuevos primero, y cada avance como acordeon plegable para que la
       lista no quede tediosa de leer cuando hay muchos registrados. */
    el.innerHTML = list.length ? list.slice().reverse().map(av => {
      const j = list.indexOf(av);
      const atts = (av.attachments || []).map((a, k) => { if (a.type === 'pdf') return `<span class="btn bh xs" data-action="ver-avance-adj" data-av="${j}" data-att="${k}" style="cursor:pointer;margin:4px 6px 0 0;display:inline-block">📄 ${escape(a.name)}</span>`; return `<img class="att-thumb" data-action="ver-avance-adj" data-av="${j}" data-att="${k}" data-path="${escape(a.storagePath || '')}" ${a.data ? `src="${a.data}"` : ''} alt="${escape(a.name)}" title="${escape(a.name)}">`; }).join('');
      return `<details class="acc avance-item"><summary><span>${escape(av.date)}</span>${av.amount ? `<span style="font-weight:700;color:var(--blue)">+${fm(av.amount)}</span>` : ''}</summary><div class="acc-body"><p class="avance-body-note">${escape(av.note)}</p>${av.amount ? `<p style="font-weight:700;color:var(--blue)">Monto adicional: ${fm(av.amount)}</p>` : ''}${atts ? `<div>${atts}</div>` : ''}<button class="btn bh xs" data-action="remove-avance" data-av="${j}" style="margin-top:10px">Quitar</button></div></details>`;
    }).join('') : '<p style="color:var(--mut)">Aún no hay avances registrados para este proyecto.</p>'; el.querySelectorAll('.att-thumb').forEach(img => { if (!img.getAttribute('src') && img.dataset.path && window.firebase && firebase.storage) { firebase.storage().ref(img.dataset.path).getDownloadURL().then(url => { img.src = url; }).catch(() => {}); } });
  }
  function renderHistory() {
    const el = document.getElementById('pr-history');
    el.innerHTML = data.projects.length ? data.projects.map((p, i) => `<div class="hcard"><strong>${escape(p.number)} · ${escape(p.client)}</strong><p style="margin:6px 0">${escape(p.title)}</p><button class="btn bb sm" data-action="load" data-index="${i}">Abrir y editar</button> <button class="btn bh sm" data-action="duplicate" data-index="${i}">Duplicar</button> <button class="btn bh sm" data-action="delete" data-index="${i}">Eliminar</button></div>`).join('') : '<p>Aún no hay proyectos guardados.</p>';
  }
  async function renderClientAccess() {
    const box = document.getElementById('client-access-box');
    if (!box) return;
    if (!window.firebase || !firebase.firestore) { box.innerHTML = '<p style="color:var(--mut)">Disponible solo con conexión a internet.</p>'; return; }
    if (!data.projects.some(p => p.id === data.draft.id)) {
      box.innerHTML = '<p style="color:var(--mut)">Guarda el proyecto primero para poder dar acceso a un cliente.</p>';
      return;
    }
    const projectId = data.draft.id, projectNumber = data.draft.number;
    box.innerHTML = '<p style="color:var(--mut)">Cargando…</p>';
    try {
      const mirrorDoc = await firebase.firestore().collection('clientView').doc(projectId).get();
      const mirror = mirrorDoc.exists ? mirrorDoc.data() : null;
      if (mirror && mirror.clientUid && mirror.clientApproved) {
        const accDoc = await firebase.firestore().collection('clientAccounts').doc(mirror.clientUid).get();
        const email = accDoc.exists ? accDoc.data().email : '(cuenta no encontrada)';
        box.innerHTML = `<p>Cliente con acceso a este proyecto: <strong>${escape(email)}</strong></p><button class="btn br sm" data-action="revoke-client">Revocar acceso</button>`;
        return;
      }
      const pending = await firebase.firestore().collection('clientAccounts').where('projectNumber', '==', projectNumber).where('status', '==', 'pending').get();
      if (pending.empty) {
        box.innerHTML = `<p style="color:var(--mut)">Nadie ha solicitado acceso a este proyecto todavía. Comparte con tu cliente el número de proyecto <strong>${escape(projectNumber)}</strong> y el link de acceso de clientes para que cree su cuenta.</p>`;
        return;
      }
      box.innerHTML = pending.docs.map(d => {
        const req = d.data();
        return `<div class="card" style="margin-bottom:8px;background:rgba(0,0,0,.03)"><p style="margin:0 0 8px"><strong>${escape(req.displayName || '')}</strong> (${escape(req.email)}) solicitó acceso a este proyecto.</p><button class="btn bg sm" data-action="approve-client" data-uid="${d.id}">Aprobar</button> <button class="btn bh sm" data-action="reject-client" data-uid="${d.id}">Rechazar</button></div>`;
      }).join('');
    } catch (e) { box.innerHTML = '<p style="color:#b91c1c">No se pudo cargar: ' + escape((e && e.message) || String(e)) + '</p>'; }
  }
  window.rProyectos = function () {
    if (!ready) { root.innerHTML = '<div class="card">Conectando con el archivo de proyectos…</div>'; return; }
    root.innerHTML = `<div class="card-hi"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h2>Proyectos · Mano de obra</h2><p style="margin:8px 0;color:var(--mut)">Informe técnico y presupuesto de trabajos. Valores netos en pesos chilenos; materiales excluidos.</p></div><button class="btn bh" data-action="new">Nuevo proyecto</button></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn bg" data-action="save">Guardar proyecto</button><button class="btn bb" data-action="pdf">Generar informe PDF</button><button class="btn bb" data-action="budget">Solo presupuesto PDF</button><button class="btn bh" data-action="backup">Exportar proyecto editable</button><label class="btn bh" for="pr-import">Importar proyecto<input id="pr-import" type="file" accept=".json" hidden></label></div><p id="pr-status" role="status" style="margin-top:10px">Borrador guardado automáticamente en este equipo.</p></div>
    <details class="acc total"><summary><span>💰 Presupuesto total</span><span id="pr-budget-total-price"></span></summary><div class="acc-body"><table class="pr-table" style="min-width:0"><thead><tr><th>Ítem</th><th>Trabajo</th><th>Alcance</th><th>Valor neto</th></tr></thead><tbody id="pr-budget-total-rows"></tbody></table><div style="max-width:340px;margin:14px 0 0 auto"><div class="row"><span>Neto</span><span id="pr-budget-total-net"></span></div><div class="row"><span>IVA 19%</span><span id="pr-budget-total-iva"></span></div><div class="row"><strong>Total</strong><strong id="pr-budget-total-total"></strong></div></div></div></details>
    <div class="card"><div class="ct">Datos del proyecto</div><div class="g2">${field('number', 'N° de informe / presupuesto')}${field('date', 'Fecha')}${field('title', 'Nombre del proyecto *')}${field('client', 'Titular / cliente *')}${field('location', 'Ubicación del proyecto')}${field('author', 'Elaborado por')}</div></div>
    <div class="card"><div class="ct">Informe técnico</div><p style="margin-bottom:12px;color:var(--mut)">Redacta las secciones que necesites. Las secciones vacías se omiten del PDF. Puedes separar los párrafos con una línea en blanco.</p><div class="pr-sections">${field('intro', 'Introducción', true)}${field('diagnosis', 'Observaciones y diagnóstico de la instalación', true, 'Describe los hallazgos y relaciona las fotografías por número.')}${field('corrections', 'Correcciones y verificaciones recomendadas', true)}${field('references', 'Referencias técnicas', true)}</div></div>
    <div class="card"><div class="ct">Registro fotográfico</div><p style="margin-bottom:12px">Agrega imágenes JPG, PNG o WebP (hasta 60). Se numeran en el orden de carga.</p><input id="pr-file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="pr-photos" style="margin-top:16px"></div></div>
    <div class="card"><div class="ct">Avances del proyecto</div><p style="margin-bottom:12px;color:var(--mut)">Registra aquí las novedades y el avance del trabajo a medida que ocurren. Si le das acceso al cliente de este proyecto, esto es lo que él va a poder ver y descargar.</p><div id="av-list" style="margin-bottom:14px"></div><div class="card" style="background:rgba(0,0,0,.03)"><label class="L" for="av-note">Nueva nota de avance</label><textarea id="av-note" rows="3" placeholder="Ej: Se realizó el levantamiento inicial del tablero..."></textarea><label class="L" style="margin-top:10px" for="av-amount">Monto adicional (opcional, si este avance incluye un anexo/presupuesto extra)</label><input id="av-amount" type="number" min="0" max="999999999999" step="1" placeholder="Ej: 108000"><label class="L" style="margin-top:10px" for="av-file">Adjuntar fotos o PDF (opcional)</label><input id="av-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple><div id="av-pending" style="margin-top:8px;color:var(--mut);font-size:12px"></div><button class="btn bg sm" data-action="add-avance" style="margin-top:12px">+ Agregar avance</button></div></div>
    <div class="card"><div class="ct">Presupuesto detallado · Solo trabajo</div>${field('scope', 'Alcance incluido', true)}<div style="overflow-x:auto;margin-top:16px"><table class="pr-table"><thead><tr><th>Ítem</th><th>Trabajo</th><th>Alcance incluido</th><th>Valor neto CLP</th><th></th></tr></thead><tbody id="pr-rows"></tbody></table></div><button class="btn bb sm" data-action="add-row" style="margin-top:12px">+ Agregar trabajo</button><div class="card-hi" style="max-width:480px;margin:18px 0 0 auto"><div class="row"><span>Total neto de los servicios</span><strong id="pr-net"></strong></div><div class="row"><span>IVA 19%</span><strong id="pr-tax"></strong></div><div class="row"><strong>Total del servicio con IVA</strong><strong id="pr-total"></strong></div><p style="margin-top:10px;color:var(--mut)">Materiales no incluidos. Cada valor corresponde al total neto del trabajo de esa fila.</p></div></div>
    <div class="card"><div class="ct">Condiciones y aprobación</div><div class="pr-sections">${field('conditions', 'Condiciones de ejecución, pago, plazo y garantía', true)}${field('approval', 'Texto de aprobación del presupuesto', true)}${field('representative', 'Representante R & N para la firma')}</div></div>
    <div class="card"><div class="ct">Acceso del cliente</div><div id="client-access-box"><p style="color:var(--mut)">Cargando…</p></div></div>
    <div class="card"><div class="ct">Proyectos guardados</div><div id="pr-history"></div></div>`;
    renderRows(); renderPhotos(); renderAvances(); renderHistory();
    try { renderClientAccess(); } catch (e) { console.warn('Acceso de cliente no disponible:', e); }
  };
  root.addEventListener('input', event => {
    const el = event.target;
    if (el.dataset.field) data.draft[el.dataset.field] = el.value;
    else if (el.dataset.row !== undefined) {
      if (el.dataset.key === 'price') {
        const n = Number(el.value);
        if (!Number.isSafeInteger(n) || n < 0 || n > 999999999999) { el.setCustomValidity('Ingresa un valor en pesos enteros, positivo o cero.'); el.reportValidity(); return; }
        el.setCustomValidity('');
        data.draft.items[Number(el.dataset.row)].price = n;
      } else data.draft.items[Number(el.dataset.row)][el.dataset.key] = el.value;
      updateTotals();
    } else if (el.dataset.photo !== undefined) data.draft.photos[Number(el.dataset.photo)][el.dataset.key] = el.value;
    else return;
    changed();
  });
  function valid() {
    const invalid = root.querySelector('input:invalid');
    if (invalid) { invalid.reportValidity(); return false; }
    if (!data.draft.title.trim() || !data.draft.client.trim()) { alert('Completa el nombre del proyecto y el cliente.'); return false; }
    if (!data.draft.items.length || data.draft.items.some(row => !row.name.trim())) { alert('Agrega al menos un trabajo y completa el nombre de cada uno.'); return false; }
    return true;
  }
  async function saveProject() {
    if (!valid()) return false;
    /* Espera a que termine cualquier fusion de la nube en curso antes de
       tocar data.projects (una fusion puede tardar varios segundos bajando
       fotos; si se edita mientras tanto, la fusion podria sobreescribir
       el cambio al terminar). */
    await mergeChain.catch(() => {});
    const previous = clone(data.projects);
    const entry = clone(data.draft);
    entry.updatedAt = Date.now();
    const i = data.projects.findIndex(p => p.id === entry.id);
    if (i < 0) data.projects.unshift(entry); else data.projects[i] = entry;
    if (!await persist()) { data.projects = previous; return false; }
    renderHistory(); status('Proyecto guardado. Puedes volver a abrirlo en la lista inferior.');
    try { renderClientAccess(); } catch (e) {}
    return true;
  }
  /* Los avances (y sus adjuntos) deben quedar visibles para el cliente y a
     salvo de perderse apenas se agregan o quitan, sin depender de que el
     dueño se acuerde de apretar "Guardar proyecto" aparte. Si el proyecto ya
     estaba guardado, esta funcion refleja el borrador actual en data.projects
     (y por lo tanto en la nube y en la vista del cliente) de inmediato, sin
     exigir los mismos requisitos de "Guardar proyecto" (titulo, cliente,
     trabajos). Si el proyecto todavia no se ha guardado nunca, no hace nada:
     el cambio queda en el borrador hasta que el dueño lo guarde por primera
     vez, igual que antes. */
  async function syncDraftToSavedProject() {
    const i = data.projects.findIndex(p => p.id === data.draft.id);
    if (i < 0) return;
    await mergeChain.catch(() => {});
    const previous = clone(data.projects);
    const entry = clone(data.draft);
    entry.updatedAt = Date.now();
    data.projects[i] = entry;
    if (!await persist()) { data.projects = previous; return; }
    renderHistory();
    try { renderClientAccess(); } catch (e) {}
  }
  function editableFile() {
    const blob = new Blob([JSON.stringify({format: 'rn-project-v1', project: data.draft}, null, 2)], {type: 'application/json'});
    dlink(URL.createObjectURL(blob), 'Proyecto_' + data.draft.number.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || !ready) return;
    if (busy) { status('Espera a que terminen de procesar los archivos antes de continuar…', true); return; }
    const action = button.dataset.action, i = Number(button.dataset.index);
    try {
      if (action === 'add-row') { data.draft.items.push({name: '', scope: '', price: 0}); renderRows(); changed(); await syncDraftToSavedProject(); }
      if (action === 'remove-row' && confirm('¿Quitar este trabajo del borrador?')) { data.draft.items.splice(i, 1); renderRows(); changed(); await syncDraftToSavedProject(); }
      if (action === 'remove-photo' && confirm('¿Quitar esta fotografía del borrador?')) {
        const removedPhoto = data.draft.photos[i];
        data.draft.photos.splice(i, 1); renderPhotos(); changed();
        if (removedPhoto && removedPhoto.storagePath) deleteStoragePhoto(removedPhoto.storagePath);
      }
      if (action === 'add-avance') {
        const noteEl = document.getElementById('av-note');
        const note = noteEl ? noteEl.value.trim() : ''; const amountEl = document.getElementById('av-amount'); const amountN = amountEl ? Number(amountEl.value) : 0; if (amountEl && amountEl.value && (!Number.isSafeInteger(amountN) || amountN < 0 || amountN > 999999999999)) { alert('El monto adicional debe ser un valor en pesos entero, positivo o cero.'); return; } const amount = Number.isFinite(amountN) && amountN > 0 ? amountN : 0;
        if (!note && !pendingAvanceFiles.length && !amount) { alert('Escribe una nota, adjunta al menos un archivo o ingresa un monto adicional.'); return; }
        const now = new Date();
        data.draft.avances = data.draft.avances || [];
        data.draft.avances.push({
          id: uid(), date: now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()),
          note: note, amount: amount, attachments: pendingAvanceFiles
        });
        pendingAvanceFiles = [];
        if (noteEl) noteEl.value = '';
        const pend = document.getElementById('av-pending'); if (pend) pend.textContent = '';
        renderAvances(); changed();
        await syncDraftToSavedProject();
      }
      if (action === 'remove-avance' && confirm('¿Quitar este avance del proyecto?')) {
        const av = data.draft.avances[Number(button.dataset.av)];
        data.draft.avances.splice(Number(button.dataset.av), 1);
        renderAvances(); changed();
        await syncDraftToSavedProject();
        if (av) (av.attachments || []).forEach(a => { if (a.storagePath) deleteStoragePhoto(a.storagePath); });
      }
      if (action === 'ver-avance-adj') {
        const av = data.draft.avances[Number(button.dataset.av)];
        const att = av && av.attachments[Number(button.dataset.att)];
        const isPdf = att && att.type === 'pdf';
        if (att && att.storagePath) openStorageViewer(att.name, att.storagePath, isPdf);
        else if (att && att.data && isPdf) {
          /* Adjunto todavia no subido a la nube (sin storagePath): el iframe
             no renderiza PDF, y los navegadores bloquean window.open con una
             data: URL directa, asi que se convierte a blob: URL primero. */
          const parts = att.data.split(',');
          const bin = atob(parts[1] || '');
          const bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          const blobUrl = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
          window.open(blobUrl, '_blank');
        } else if (att && att.data) {
          const ov = ensureDocViewer();
          document.getElementById('doc-viewer-title').textContent = att.name;
          document.getElementById('doc-viewer-frame').src = att.data;
          document.getElementById('doc-viewer-open').href = att.data;
          ov.style.display = 'block';
        }
      }
      if (action === 'save') await saveProject();
      if (action === 'new' && confirm('¿Crear un proyecto nuevo? Guarda el actual en la lista o expórtalo antes de reemplazar el borrador.')) { data.draft = blank(); rProyectos(); await persist(); }
      if (action === 'load' || action === 'duplicate') {
        if (!confirm('Se reemplazará el borrador actual. ¿Continuar?')) return;
        data.draft = clone(data.projects[i]);
        if (action === 'duplicate') { const fresh = blank(); data.draft.id = fresh.id; data.draft.number = fresh.number; }
        rProyectos(); await persist(); window.scrollTo(0, 0);
      }
      if (action === 'delete' && confirm('¿Eliminar este proyecto de la lista de guardados?')) {
        await mergeChain.catch(() => {});
        const previous = clone(data.projects), previousDel = cloudDelGet(), removedProject = data.projects[i], removedId = removedProject && removedProject.id;
        data.projects.splice(i, 1);
        /* El tombstone se registra ANTES de persist() para que quede incluido
           en el mismo envio a la nube (evita que el proyecto reaparezca). */
        if (removedId) { const d = cloudDelGet(); if (d.indexOf(removedId) < 0) { d.push(removedId); cloudDelSet(d); } }
        if (!await persist()) { data.projects = previous; cloudDelSet(previousDel); }
        else if (removedProject) {
          (removedProject.photos || []).forEach(ph => { if (ph.storagePath) deleteStoragePhoto(ph.storagePath); });
          (removedProject.avances || []).forEach(av => (av.attachments || []).forEach(a => { if (a.storagePath) deleteStoragePhoto(a.storagePath); }));
          if (window.firebase && firebase.firestore) {
            firebase.firestore().collection('clientView').doc(removedProject.id).delete().catch(() => {});
          }
        }
        renderHistory();
      }
      if (action === 'approve-client') {
        const uid = button.dataset.uid;
        await firebase.firestore().collection('clientAccounts').doc(uid).update({status: 'approved', projectId: data.draft.id, approvedAt: Date.now()});
        await firebase.firestore().collection('clientView').doc(data.draft.id).set({clientUid: uid, clientApproved: true}, {merge: true});
        renderClientAccess();
      }
      if (action === 'reject-client') {
        await firebase.firestore().collection('clientAccounts').doc(button.dataset.uid).update({status: 'rejected'});
        renderClientAccess();
      }
      if (action === 'revoke-client' && confirm('¿Revocar el acceso del cliente a este proyecto?')) {
        await firebase.firestore().collection('clientView').doc(data.draft.id).set({clientApproved: false}, {merge: true});
        renderClientAccess();
      }
      if (action === 'backup') { if (root.querySelector('input:invalid')) { valid(); return; } editableFile(); }
      if (action === 'pdf' || action === 'budget') {
        if (!valid()) return;
        busy = true; button.disabled = true; status('Generando PDF… Elige dónde guardarlo.');
        const result = await window.pywebview.api.export_project_pdf(clone(data.draft), action === 'budget');
        if (!result.ok) throw new Error(result.error);
        status(result.cancelled ? 'Exportación cancelada.' : 'PDF guardado en: ' + result.path);
      }
    } catch (error) { status(error.message, true); alert(error.message); }
    finally { busy = false; button.disabled = false; }
  });
  async function photoData(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Usa imágenes JPG, PNG o WebP.');
    if (file.size > 30 * 1024 * 1024) throw new Error('La fotografía supera los 30 MB: ' + file.name);
    const image = new Image(), url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('No se pudo leer: ' + file.name)); image.src = url; });
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', .84);
    } finally { URL.revokeObjectURL(url); }
  }
  async function avanceFileData(file) {
    if (file.type === 'application/pdf') {
      if (file.size > 20 * 1024 * 1024) throw new Error('El PDF supera 20 MB: ' + file.name);
      const fileData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('No se pudo leer: ' + file.name));
        reader.readAsDataURL(file);
      });
      return {data: fileData, type: 'pdf'};
    }
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return {data: await photoData(file), type: 'image'};
    throw new Error('Usa imágenes JPG/PNG/WebP o PDF: ' + file.name);
  }
  root.addEventListener('change', async event => {
    if (!['pr-file', 'pr-import', 'av-file'].includes(event.target.id)) return;
    if (busy) { event.target.value = ''; return; }
    busy = true;
    try {
      if (event.target.id === 'pr-file') {
        const files = Array.from(event.target.files);
        if (files.length + data.draft.photos.length > 60) throw new Error('El máximo es de 60 fotografías por proyecto.');
        status('Preparando fotografías…');
        const additions = [];
        for (const file of files) additions.push({data: await photoData(file), name: file.name.replace(/\.[^.]+$/, ''), caption: ''});
        data.draft.photos.push(...additions); renderPhotos(); await persist();
      } else if (event.target.id === 'av-file') {
        const files = Array.from(event.target.files);
        if (pendingAvanceFiles.length + files.length > 20) throw new Error('Máximo 20 adjuntos por avance.');
        const pend = document.getElementById('av-pending');
        if (pend) pend.textContent = 'Preparando adjuntos…';
        for (const file of files) {
          const result = await avanceFileData(file);
          pendingAvanceFiles.push({name: file.name, type: result.type, data: result.data});
        }
        if (pend) pend.textContent = pendingAvanceFiles.length ? pendingAvanceFiles.length + ' archivo(s) listos — se agregan al hacer clic en "Agregar avance".' : '';
      } else if (event.target.files[0]) {
        const file = event.target.files[0];
        if (file.size > 180000000) throw new Error('El archivo es demasiado grande.');
        const imported = JSON.parse(await file.text());
        if (imported.format !== 'rn-project-v1' || !imported.project || !Array.isArray(imported.project.items) || !Array.isArray(imported.project.photos)) throw new Error('El archivo no es un proyecto editable de R & N.');
        if (!confirm('¿Importar este proyecto y reemplazar el borrador actual?')) return;
        // The Python validator checks every field before accepting imported data.
        if (!await persist()) throw new Error('No se pudo guardar el borrador actual antes de importar.');
        const previous = data.draft;
        const candidate = {...blank(), ...imported.project, id: uid()};
        data.draft = candidate;
        if (!await persist()) { data.draft = previous; throw new Error('No se pudo importar. Revisa que sea un proyecto válido de R & N.'); }
        rProyectos(); status('Proyecto importado. Guarda una copia en la lista de proyectos.');
      }
    } catch (error) { status(error.message, true); alert(error.message); }
    finally { event.target.value = ''; busy = false; }
  });
  async function init() {
    if (ready) return;
    try {
      const result = await window.pywebview.api.load_projects();
      if (!result.ok) throw new Error(result.error);
      data = result.data || {version: 1, draft: blank(), projects: []};
      ready = true;
      if (S.tab === 'proyectos') rProyectos();
      try { cloudInit(); } catch (e) { console.warn('Sincronizacion de proyectos no disponible:', e); }
    } catch (error) { root.innerHTML = '<div class="card" style="color:#b91c1c">' + escape(error.message) + '<p>Cierra y vuelve a abrir el programa. No se reemplazó el archivo de proyectos.</p></div>'; }
  }
  window.addEventListener('pywebviewready', init);
  window.rnProjectSnapshot = () => ready ? JSON.stringify(data) : null;
  if (window.pywebview && window.pywebview.api) init();
})();
