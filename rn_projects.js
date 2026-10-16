/* Proyectos de mano de obra. Almacenamiento independiente del cotizador original. */
(function () {
  'use strict';
  const root = document.getElementById('tab-proyectos');
  let data = null, timer, queue = Promise.resolve(), ready = false, busy = false, pendingAvanceFiles = [];
  let ownerSigEditing = false, ownerSigPendingUpload = null, ownerSigHasDrawn = false;
  const escape = escHtml;
  /* Solo se insertan en el HTML data: URL bien formadas. Cualquier otra cosa
     que llegue desde la nube (por ejemplo una "firma" manipulada por una
     cuenta de cliente) se descarta, para que no pueda inyectar codigo. */
  const DATA_URL_RE = /^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+\/]*={0,2}$/;
  const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+\/]+={0,2}$/;
  function safeDataUrl(v) { return (typeof v === 'string' && v.length <= 30000000 && DATA_URL_RE.test(v)) ? v : ''; }
  function safeSig(v) { return (typeof v === 'string' && v.length <= 400000 && SIG_RE.test(v)) ? v : ''; }
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
      })),
      documents: (p.documents || []).map(d => ({id: d.id, name: d.name, type: d.type, storagePath: d.storagePath || null}))
    }));
  }
  /* Los archivos viven en Firestore (rnFiles, definido en la pagina principal). Un archivo que aun
     tiene una ruta antigua de Cloud Storage y cuyos bytes ya estan en este equipo se migra solo. */
  function needsUpload(item) {
    return !!(item && item.data && !(window.rnFiles && rnFiles.isFs(item.storagePath)));
  }
  async function cloudUploadPhotos(project) {
    if (!window.firebase || !window.rnFiles) return;
    for (const ph of project.photos) {
      if (needsUpload(ph)) {
        try { ph.storagePath = await rnFiles.putDataUrl(ph.data, {projectId: project.id, name: ph.name}); }
        catch (e) { console.warn('No se pudo subir una fotografia a la nube', e); }
      }
    }
  }
  function deleteStoragePhoto(storagePath) {
    if (!window.firebase || !window.rnFiles) return;
    rnFiles.remove(storagePath).catch(e => console.warn('No se pudo borrar un archivo de la nube', e));
  }
  async function cloudUploadAvanceFiles(project) {
    if (!window.firebase || !window.rnFiles) return;
    for (const av of (project.avances || [])) {
      for (const a of (av.attachments || [])) {
        if (needsUpload(a)) {
          try { a.storagePath = await rnFiles.putDataUrl(a.data, {projectId: project.id, name: a.name}); }
          catch (e) { console.warn('No se pudo subir un adjunto de avance a la nube', e); }
        }
      }
    }
  }
  async function cloudUploadDocuments(project) {
    if (!window.firebase || !window.rnFiles) return;
    for (const d of (project.documents || [])) {
      if (needsUpload(d)) {
        try { d.storagePath = await rnFiles.putDataUrl(d.data, {projectId: project.id, name: d.name}); }
        catch (e) { console.warn('No se pudo subir un documento del proyecto a la nube', e); }
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
      documents: (p.documents || []).map(d => ({id: d.id, name: d.name, type: d.type, storagePath: d.storagePath || null})),
      tableroDone: !!p.tableroDone, planoDone: !!p.planoDone, noFixedProgress: !!p.noFixedProgress,
      ownerSignature: p.ownerSignature || '',
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
  /* Hasta que la primera fusion con la nube termina, este dispositivo no
     sube nada: una copia local vieja (sin conexion, app instalada sin abrir
     por dias) pisaria los datos ya corregidos desde otro dispositivo. */
  let firstMergeDone = false, firstMergeWaiters = [];
  function markFirstMerge() {
    if (firstMergeDone) return;
    firstMergeDone = true;
    firstMergeWaiters.splice(0).forEach(fn => fn());
    if (cloudPendingPush && cloudReady && cloudDoc) { cloudPendingPush = false; cloudPushProjects(); }
  }
  function whenFirstMerge(ms) {
    if (firstMergeDone || !cloudReady) return Promise.resolve();
    return new Promise(resolve => { firstMergeWaiters.push(resolve); setTimeout(resolve, ms || 15000); });
  }
  async function cloudPushProjects() {
    if (!cloudReady || !cloudDoc || !firstMergeDone) { cloudPendingPush = true; return; }
    try {
      for (const p of data.projects) { await cloudUploadPhotos(p); await cloudUploadAvanceFiles(p); await cloudUploadDocuments(p); }
      /* Fusion segura: nunca se pisa en la nube un proyecto que alli sea mas
         nuevo que la copia local, ni se pierden proyectos que solo existen
         en la nube y no fueron eliminados. */
      const snap = await cloudDoc.get();
      const remote = snap.exists && Array.isArray(snap.data().projects) ? snap.data().projects : [];
      const remoteDel = snap.exists && Array.isArray(snap.data().deleted) ? snap.data().deleted : [];
      const delAll = new Set(cloudDelGet().concat(remoteDel));
      const remoteById = {};
      remote.forEach(rp => { if (rp && rp.id) remoteById[rp.id] = rp; });
      const local = cloudStrip(data.projects), out = [], winners = [];
      local.forEach((lp, i) => {
        const rp = remoteById[lp.id];
        if (rp && (rp.updatedAt || 0) > (lp.updatedAt || 0)) out.push(rp);
        else { out.push(lp); winners.push(data.projects[i]); }
      });
      remote.forEach(rp => { if (rp && rp.id && !out.some(p => p.id === rp.id) && !delAll.has(rp.id)) out.push(rp); });
      for (const p of winners) await updateClientMirror(p);
      await cloudDoc.set({projects: out.filter(p => !delAll.has(p.id)), deleted: Array.from(delAll).slice(-500), updatedAt: firebase.firestore.FieldValue.serverTimestamp()});
    } catch (e) { console.warn('Sync proyectos: no se pudo guardar en la nube', e); }
  }
  async function cloudDownloadFile(storagePath) {
    if (window.rnFiles && rnFiles.isFs(storagePath)) {
      const du = await rnFiles.getDataUrl(storagePath);
      if (!safeDataUrl(du)) throw new Error('Tipo de archivo no permitido.');
      return du;
    }
    const url = await firebase.storage().ref(storagePath).getDownloadURL();
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => (safeDataUrl(reader.result) ? resolve(reader.result) : reject(new Error('Tipo de archivo no permitido.')));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  function cloudMergeAndApply(cloudList, cloudDeleted) {
    /* Se encadenan las fusiones para que nunca corran dos al mismo tiempo:
       si llega un segundo cambio remoto mientras se procesa el anterior
       (que puede tardar varios segundos bajando fotos), se espera su turno
       en vez de pisar el resultado del que ya estaba corriendo. */
    mergeChain = mergeChain.catch(() => {}).then(() => cloudMergeAndApplyImpl(cloudList, cloudDeleted)).then(
      () => { markFirstMerge(); }, e => { markFirstMerge(); throw e; });
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
    if (takeCloud.length) {
      const stEl = document.getElementById('pr-status');
      if (stEl) { stEl.textContent = 'Sincronizando con la nube… (puede tardar si hay archivos nuevos)'; stEl.style.color = '#b45309'; }
    }
    for (const id of takeCloud) {
      const p = cloudById[id], kept = [];
      /* Lo que este equipo ya tiene descargado (misma ruta en Storage) se reutiliza:
         solo se bajan los archivos nuevos, no todo el proyecto en cada cambio. */
      const have = {};
      const lpOld = localById[id];
      if (lpOld) {
        (lpOld.photos || []).forEach(x => { if (x && x.storagePath && x.data) have[x.storagePath] = x.data; });
        (lpOld.avances || []).forEach(av => (av.attachments || []).forEach(a => { if (a && a.storagePath && a.data) have[a.storagePath] = a.data; }));
        (lpOld.documents || []).forEach(x => { if (x && x.storagePath && x.data) have[x.storagePath] = x.data; });
      }
      /* Si una descarga falla (sin conexion, otro origen) el archivo NO se
         descarta: se conserva su referencia (storagePath) sin los bytes. Asi
         una falla pasajera nunca borra adjuntos de la nube al volver a subir
         el proyecto; se ven igual desde Storage. */
      for (const ph of (p.photos || [])) {
        if (!ph.data && ph.storagePath) {
          if (have[ph.storagePath]) ph.data = have[ph.storagePath];
          else {
            try { ph.data = await cloudDownloadFile(ph.storagePath); }
            catch (e) { console.warn('No se pudo bajar una fotografia de la nube, se conserva la referencia:', e); }
          }
          kept.push(ph);
        } else if (ph.data || ph.storagePath) kept.push(ph);
      }
      p.photos = kept;
      for (const av of (p.avances || [])) {
        const keptAtt = [];
        for (const a of (av.attachments || [])) {
          if (!a.data && a.storagePath) {
            if (have[a.storagePath]) a.data = have[a.storagePath];
            else {
              try { a.data = await cloudDownloadFile(a.storagePath); }
              catch (e) { console.warn('No se pudo bajar un adjunto de avance, se conserva la referencia:', e); }
            }
            keptAtt.push(a);
          } else if (a.data || a.storagePath) keptAtt.push(a);
        }
        av.attachments = keptAtt;
      }
      const keptDocs = [];
      for (const d of (p.documents || [])) {
        if (!d.data && d.storagePath) {
          if (have[d.storagePath]) d.data = have[d.storagePath];
          else {
            try { d.data = await cloudDownloadFile(d.storagePath); }
            catch (e) { console.warn('No se pudo bajar un documento del proyecto, se conserva la referencia:', e); }
          }
          keptDocs.push(d);
        } else if (d.data || d.storagePath) keptDocs.push(d);
      }
      p.documents = keptDocs;
    }
    const merged = order.map(id => takeCloud.includes(id) ? cloudById[id] : localById[id]);
    /* Si el borrador abierto es una copia sin cambios de un proyecto que la
       nube trae mas nuevo, el borrador quedo viejo: se refresca. Asi un
       dispositivo con copia antigua no vuelve a subir datos ya corregidos
       (monto, numero o avances eliminados) al tickear o agregar algo. Si el
       borrador tiene cambios sin guardar, no se toca. */
    let refreshDraft = null;
    if (data.draft && data.draft.id && takeCloud.includes(data.draft.id)) {
      const localSaved = localById[data.draft.id];
      if (localSaved && sameProjectContent(localSaved, data.draft)) refreshDraft = data.draft.id;
    }
    /* Tambien cuenta como cambio si un proyecto local quedo excluido solo por
       tombstone (borrado en otro dispositivo), aunque no venga nada nuevo. */
    if (takeCloud.length || merged.length !== (data.projects || []).length) {
      cloudApplyingRemote = true;
      data.projects = merged;
      if (refreshDraft && cloudById[refreshDraft]) data.draft = clone(cloudById[refreshDraft]);
      await persist();
      cloudApplyingRemote = false;
      if (takeCloud.length) status('Sincronizado con la nube.');
      if (S.tab === 'proyectos') {
        renderHistory();
        if (refreshDraft) { try { rProyectos(); } catch (e) {} }
      }
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
      else { console.warn('Sync proyectos:', err); if (window.setSyncStatus) setSyncStatus(false); markFirstMerge(); }
    });
  }
  /* Migra a Firestore los archivos que aun estan en Cloud Storage (ruta antigua): si los bytes ya
     estan en este equipo se suben tal cual; si no, se bajan de Storage una vez y se suben. */
  async function migrateLegacyFiles() {
    if (!window.rnFiles || !cloudReady) return false;
    let changed = false;
    for (const p of data.projects || []) {
      const items = [].concat(p.photos || [], p.documents || []);
      (p.avances || []).forEach(av => (av.attachments || []).forEach(a => items.push(a)));
      for (const it of items) {
        if (!it || !it.storagePath || rnFiles.isFs(it.storagePath)) continue;
        if (!it.data) {
          try { it.data = await cloudDownloadFile(it.storagePath); } catch (e) { continue; }
        }
        if (it.data) changed = true;
      }
    }
    return changed;
  }
  async function runMigration() {
    try {
      if (await migrateLegacyFiles()) {
        status('Pasando los archivos a la nube nueva…');
        await cloudPushProjects();
        await persist();
        status('Archivos migrados.');
      }
    } catch (e) { console.warn('Migracion de archivos:', e); }
  }
  /* === COPIAS FIRMADAS ===
     Cuando el cliente firma (aprueba un avance) en el portal, aqui se estampan su firma y la del dueño en el recuadro
     de firmas de cada PDF del avance, y se deja una copia "<nombre>_firmado.pdf" junto al original. El lugar de las
     firmas viene dentro del propio PDF (marca ET-SIG en sus metadatos). Los PDF sin esa marca se omiten. */
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
        s.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib no disponible')));
        s.onerror = () => { pdfLibPromise = null; reject(new Error('No se pudo cargar pdf-lib')); };
        document.head.appendChild(s);
      });
    }
    return pdfLibPromise;
  }
  function dataUrlBytes(du) {
    const b = atob(du.split(',')[1]), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function bytesDataUrl(u8, mime) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return 'data:' + mime + ';base64,' + btoa(s);
  }
  function fmtFecha(ms) {
    const d = new Date(ms), z = n => String(n).padStart(2, '0');
    return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }
  /* SHA-256 en JavaScript puro (respaldo cuando crypto.subtle no esta disponible, p. ej. en algunos contextos locales). */
  function sha256Bytes(u8) {
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const l = u8.length, nb = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(nb);
    m.set(u8); m[l] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(nb - 8, Math.floor(l / 0x20000000)); dv.setUint32(nb - 4, (l << 3) >>> 0);
    const w = new Int32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < nb; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        w[i] = (w[i - 16] + (rr(a, 7) ^ rr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rr(b, 17) ^ rr(b, 19) ^ (b >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  async function sha256Hex(u8) {
    try {
      if (window.crypto && crypto.subtle) {
        const d = await crypto.subtle.digest('SHA-256', u8);
        return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* se usa el calculo propio */ }
    return sha256Bytes(u8);
  }
  async function stampPdfCopy(pdfDataUrl, f) {
    const {PDFDocument, rgb, StandardFonts} = await loadPdfLib();
    const srcBytes = dataUrlBytes(pdfDataUrl);
    const huella = await sha256Hex(srcBytes);   /* huella digital del documento tal como estaba ANTES de firmar */
    const doc = await PDFDocument.load(srcBytes);
    const kw = doc.getKeywords() || '';
    const m = /ET-SIG:(\{\S*\})/.exec(kw);
    if (!m) return null;
    const info = JSON.parse(m[1]);
    const page = doc.getPage(info.page);
    const H = page.getHeight();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    async function fill(box, sig, at) {
      const [x, y, w, h] = box.sig;
      const img = await doc.embedPng(dataUrlBytes(sig));
      const sc = Math.min((w - 12) / img.width, h / img.height);
      page.drawImage(img, {x: x + 6, y: H - y - h + (h - img.height * sc) / 2, width: img.width * sc, height: img.height * sc});
      const [fx, fy, fw, fh] = box.fecha;
      page.drawRectangle({x: fx, y: H - fy - fh, width: fw, height: fh, color: rgb(1, 1, 1)});
      page.drawText(fmtFecha(at), {x: fx + 2, y: H - fy - fh + 4, size: 9.6, font, color: rgb(0, 0, 0)});
    }
    await fill(info.rep, f.ownerSig, f.ownerAt);
    await fill(info.cli, f.clientSig, f.clientAt);
    const mono = await doc.embedFont(StandardFonts.Courier);
    const hx = info.cli.fecha[0] - 138 + 2, hy = info.cli.fecha[1] + info.cli.fecha[3] + 20;   /* debajo del recuadro del cliente */
    page.drawText('Huella digital (SHA-256) del documento antes de firmar:', {x: hx, y: H - hy, size: 7.2, font, color: rgb(0.35, 0.35, 0.35)});
    page.drawText(huella, {x: hx, y: H - hy - 10, size: 7.2, font: mono, color: rgb(0.2, 0.2, 0.2)});
    doc.setKeywords([kw.replace(/ET-SIG:\{\S*\}/, '').trim(), 'ET-FIRMADO'].filter(Boolean));
    doc.setModificationDate(new Date());
    return bytesDataUrl(await doc.save(), 'application/pdf');
  }
  let stamping = false;
  async function runStamping() {
    if (stamping || !ready || !cloudReady || !window.firebase || !firebase.firestore) return;
    stamping = true;
    let total = 0;
    try {
      for (const p of data.projects || []) {
        const ownerSig = safeSig(p.ownerSignature);
        if (!ownerSig) continue;
        const hayPdf = (p.avances || []).some(av => (av.attachments || []).some(a => a.type === 'pdf' && !/_firmado\.pdf$/i.test(a.name || '')));
        if (!hayPdf) continue;
        let acc = null;
        try {
          const mir = await firebase.firestore().collection('clientView').doc(p.id).get();
          const mirror = mir.exists ? mir.data() : null;
          if (!mirror || !mirror.clientUid || !mirror.clientApproved) continue;
          const ad = await firebase.firestore().collection('clientAccounts').doc(mirror.clientUid).get();
          acc = ad.exists ? ad.data() : null;
        } catch (e) { continue; }
        const approvals = (acc && acc.avanceApprovals) || {};
        const before = clone(p);
        let changedP = false;
        for (const av of p.avances || []) {
          const ap = approvals[av.id];
          const clientSig = ap && ap.agreed ? safeSig(ap.signature) : '';
          if (!clientSig) continue;
          const names = new Set((av.attachments || []).map(x => x.name));
          for (const a of (av.attachments || []).slice()) {
            if (a.type !== 'pdf' || /_firmado\.pdf$/i.test(a.name || '')) continue;
            const outName = String(a.name || 'documento.pdf').replace(/\.pdf$/i, '') + '_firmado.pdf';
            if (names.has(outName)) continue;
            if (!a.data) { try { a.data = await cloudDownloadFile(a.storagePath); } catch (e) { continue; } }
            let out = null;
            try { out = await stampPdfCopy(a.data, {ownerSig, clientSig, ownerAt: Date.now(), clientAt: ap.signedAt || Date.now()}); }
            catch (e) { console.warn('No se pudo firmar', a.name, e); continue; }
            if (!out) continue;
            av.attachments.push({name: outName, type: 'pdf', data: out});
            names.add(outName); changedP = true; total++;
          }
        }
        if (changedP) {
          p.updatedAt = Date.now();
          if (data.draft && data.draft.id === p.id && sameProjectContent(before, data.draft)) data.draft = clone(p);
        }
      }
      if (total) {
        status('Generando copias firmadas…');
        await cloudPushProjects();
        await persist();
        status('Copias firmadas generadas: ' + total + '.');
        if (S.tab === 'proyectos') { try { rProyectos(); } catch (e) {} }
      }
    } catch (e) { console.warn('Copias firmadas:', e); }
    finally { stamping = false; }
  }
  window.rnRunStamping = runStamping;
  function cloudInit() {
    if (!window.firebase || !firebase.firestore) return;
    cloudDoc = firebase.firestore().collection('sync').doc('proyectos');
    const onUser = user => {
      if (!user || cloudReady) return;
      cloudReady = true;
      cloudSubscribe(0);
      whenFirstMerge(60000).then(() => { setTimeout(runMigration, 1500); setTimeout(runStamping, 8000); setInterval(runStamping, 300000); });
      /* Si la nube no responde en un tiempo razonable, se habilita igual el
         guardado (modo sin conexion) para no bloquear al dueño. */
      setTimeout(markFirstMerge, 25000);
      if (cloudPendingPush && firstMergeDone) { cloudPendingPush = false; cloudPushProjects(); }
    };
    if (firebase.auth().currentUser) onUser(firebase.auth().currentUser);
    firebase.auth().onAuthStateChanged(onUser);
  }

  function blank() {
    const now = new Date();
    return {id: uid(), number: 'ET-P-' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + now.getTime().toString().slice(-5), title: '', client: '', location: '', author: 'Cristhian Sandoval - Cristopher Solis', date: now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()), intro: '', diagnosis: '', corrections: '', references: '', scope: 'El presupuesto considera la ejecución de los trabajos detallados, incluyendo mano de obra y servicios técnicos. Los materiales nuevos se cotizarán por separado, previa confirmación de cantidades y aprobación del cliente.', conditions: 'Programación, plazo de ejecución y forma de pago: por acordar por escrito antes del inicio de los trabajos.', approval: 'Con su firma, el cliente acepta los trabajos, alcances, valores y condiciones indicados en este documento. Cualquier modificación o trabajo adicional deberá ser informado y aprobado por escrito antes de su ejecución.', representative: 'Cristhian Sandoval Parra', items: [], photos: [], avances: [], documents: [], tableroDone: false, planoDone: false, noFixedProgress: false, ownerSignature: '', clientSignatureCache: '', updatedAt: 0};
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
    return {net, tax, total: net + tax};
  }
  /* Presupuesto total: a diferencia de totals() (que solo suma la tabla de
     trabajos, para no alterar el resumen de "Presupuesto detallado"), esto
     tambien suma el "Monto adicional" opcional que puede llevar un avance
     (p.ej. un anexo tecnico cotizado aparte). */
  function grandTotals() {
    const base = totals();
    const extra = (data.draft.avances || []).reduce((sum, av) => sum + (av.amount || 0), 0);
    const net = base.net + extra;
    const tax = Number((BigInt(net) * 19n + 50n) / 100n);
    return {net, tax, total: net + tax};
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
    if (rowsEl) {
      const itemRows = data.draft.items.map((row, i) => `<tr><td>${i + 1}</td><td>${escape(row.name)}${row.origin ? `<div style="font-size:11px;color:var(--mut);margin-top:2px">Ref.: ${escape(row.origin)}</div>` : ''}</td><td>${escape(row.scope)}</td><td>${fm(row.price)}</td></tr>`);
      const extraRows = (data.draft.avances || []).filter(av => av.amount).map((av, i) => `<tr><td>${data.draft.items.length + i + 1}</td><td>Avance ${escape(av.date)}${av.note ? ` — ${escape(av.note.slice(0, 60))}` : ''}</td><td>Ver avance del ${escape(av.date)}</td><td>${fm(av.amount)}</td></tr>`);
      rowsEl.innerHTML = itemRows.concat(extraRows).join('');
    }
  }
  function renderRows() {
    document.getElementById('pr-rows').innerHTML = data.draft.items.map((row, i) => `<tr><td>${i + 1}</td><td><textarea aria-label="Trabajo ${i + 1}" data-row="${i}" data-key="name" rows="3">${escape(row.name)}</textarea><input aria-label="Referencia de origen ${i + 1}" type="text" data-row="${i}" data-key="origin" value="${escape(row.origin || '')}" placeholder="Ref. opcional si viene de un anexo/avance (ej: Anexo técnico N°1)" style="margin-top:6px;font-size:11px"></td><td><textarea aria-label="Alcance ${i + 1}" data-row="${i}" data-key="scope" rows="3">${escape(row.scope)}</textarea></td><td><input aria-label="Valor neto ${i + 1}" type="number" min="0" max="999999999999" step="1" data-row="${i}" data-key="price" value="${row.price}"></td><td><button class="btn bh xs" data-action="remove-row" data-index="${i}" aria-label="Quitar trabajo ${i + 1}">Quitar</button></td></tr>`).join('');
    updateTotals();
    renderProgress();
  }
  /* Barra de avance del proyecto: tablero (15%) y plano/AutoCAD (15%) son
     avances fijos; el 70% restante se reparte en partes iguales entre cada
     punto/trabajo del presupuesto, y cada punto se subdivide en canalizado
     (40%), cableado (40%) y en funcionamiento (20%, la etapa minima). */
  const PROGRESS_TABLERO_PCT = 15, PROGRESS_PLANO_PCT = 15;
  const PROGRESS_STAGE_WEIGHTS = {canalizado: 0.4, cableado: 0.4, funcionamiento: 0.2};
  function computeProgress(project) {
    const items = project.items || [];
    /* Proyectos sin tablero ni plano (noFixedProgress): el 100% se reparte
       entre los trabajos del presupuesto. */
    const fixedPct = project.noFixedProgress ? 0 : PROGRESS_TABLERO_PCT + PROGRESS_PLANO_PCT;
    const perItemPct = items.length ? (100 - fixedPct) / items.length : 0;
    let pct = 0;
    if (!project.noFixedProgress) {
      if (project.tableroDone) pct += PROGRESS_TABLERO_PCT;
      if (project.planoDone) pct += PROGRESS_PLANO_PCT;
    }
    items.forEach(it => {
      Object.keys(PROGRESS_STAGE_WEIGHTS).forEach(stage => { if (it[stage]) pct += perItemPct * PROGRESS_STAGE_WEIGHTS[stage]; });
    });
    return Math.round(pct);
  }
  function renderProgress() {
    const items = data.draft.items || [];
    const pct = computeProgress(data.draft);
    const bar = document.getElementById('pr-progress-bar'), pctEl = document.getElementById('pr-progress-pct');
    if (bar) bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    const tableroEl = document.getElementById('pr-progress-tablero'); if (tableroEl) tableroEl.checked = !!data.draft.tableroDone;
    const planoEl = document.getElementById('pr-progress-plano'); if (planoEl) planoEl.checked = !!data.draft.planoDone;
    const fixedBox = document.getElementById('pr-progress-fixed'); if (fixedBox) fixedBox.style.display = data.draft.noFixedProgress ? 'none' : '';
    const noFixedEl = document.getElementById('pr-progress-nofixed'); if (noFixedEl) noFixedEl.checked = !!data.draft.noFixedProgress;
    const itemsEl = document.getElementById('pr-progress-items');
    if (itemsEl) {
      itemsEl.innerHTML = items.length ? items.map((it, i) => `<div class="card" style="background:var(--c2);margin-bottom:8px;padding:10px 13px"><div style="font-weight:700;margin-bottom:8px">${escape(it.name || '(sin nombre)')}</div><label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;cursor:pointer;font-size:13px"><input type="checkbox" data-action="toggle-stage" data-row="${i}" data-stage="canalizado" ${it.canalizado ? 'checked' : ''}> Canalizado</label><label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;cursor:pointer;font-size:13px"><input type="checkbox" data-action="toggle-stage" data-row="${i}" data-stage="cableado" ${it.cableado ? 'checked' : ''}> Cableado</label><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" data-action="toggle-stage" data-row="${i}" data-stage="funcionamiento" ${it.funcionamiento ? 'checked' : ''}> En funcionamiento</label></div>`).join('') : '<p style="color:var(--mut)">Agrega trabajos en "Presupuesto detallado" para poder marcar su avance.</p>';
    }
  }
  function renderPhotos() {
    document.getElementById('pr-photos').innerHTML = data.draft.photos.map((photo, i) => `<div class="card pr-photo"><img ${safeDataUrl(photo.data) ? `src="${safeDataUrl(photo.data)}"` : ''} data-path="${escape(photo.storagePath || '')}" alt="Fotografía ${i + 1}"><div><label class="L">Fotografía ${i + 1} · Equipo / Lugar</label><input aria-label="Equipo fotografía ${i + 1}" data-photo="${i}" data-key="name" value="${escape(photo.name)}"><label class="L" style="margin-top:10px">Estado / Observación</label><textarea aria-label="Observación fotografía ${i + 1}" data-photo="${i}" data-key="caption" rows="4">${escape(photo.caption)}</textarea><button class="btn bh sm" data-action="remove-photo" data-index="${i}" style="margin-top:10px">Quitar fotografía</button></div></div>`).join('');
    document.getElementById('pr-photos').querySelectorAll('img[data-path]').forEach(img => {
      if (!img.getAttribute('src') && img.dataset.path && window.firebase && window.rnFiles) {
        rnFiles.url(img.dataset.path).then(url => { img.src = url; }).catch(() => {});
      }
    });
  }
  function renderDocuments() {
    const el = document.getElementById('pr-docs');
    if (!el) return;
    const docs = data.draft.documents || [];
    el.innerHTML = docs.length ? docs.map((d, i) => `<div class="hcard" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><span>${d.type === 'pdf' ? '📄' : '🖼️'} <strong>${escape(d.name)}</strong></span><span><button class="btn bh xs" data-action="ver-doc" data-index="${i}">Ver</button> <button class="btn bh xs" data-action="remove-doc" data-index="${i}">Quitar</button></span></div>`).join('') : '<p style="color:var(--mut)">Aún no hay documentos de respaldo en este proyecto.</p>';
  }
  function renderAvances() {
    const el = document.getElementById('av-list');
    if (!el) return;
    const list = data.draft.avances || [];
    /* Mas nuevos primero, y cada avance como acordeon plegable para que la
       lista no quede tediosa de leer cuando hay muchos registrados. */
    el.innerHTML = list.length ? list.slice().reverse().map(av => {
      const j = list.indexOf(av);
      const atts = (av.attachments || []).map((a, k) => {
        if (a.type === 'pdf') return `<span class="btn bh xs" data-action="ver-avance-adj" data-av="${j}" data-att="${k}" style="cursor:pointer;margin:4px 6px 0 0;display:inline-block">📄 ${escape(a.name)}</span>`;
        return `<img class="att-thumb" data-action="ver-avance-adj" data-av="${j}" data-att="${k}" data-path="${escape(a.storagePath || '')}" ${safeDataUrl(a.data) ? `src="${safeDataUrl(a.data)}"` : ''} alt="${escape(a.name)}" title="${escape(a.name)}">`;
      }).join('');
      const clientApprovalHtml = av.clientAgreed
        ? `<p style="font-weight:700;color:#166534">✅ Aprobado por el cliente${safeSig(av.clientSignature) ? '' : ' (sin firma)'}</p>${safeSig(av.clientSignature) ? `<img src="${safeSig(av.clientSignature)}" alt="Firma del cliente" style="max-width:200px;border:1px solid var(--bd);border-radius:8px;background:#fff;display:block;margin-bottom:8px">` : ''}`
        : `<p style="color:var(--mut)">El cliente aún no ha aprobado este avance.</p>`;
      return `<details class="acc avance-item"><summary><span>${escape(av.date)}</span>${av.amount ? `<span style="font-weight:700;color:var(--blue)">+${fm(av.amount)}</span>` : ''}</summary><div class="acc-body"><p class="avance-body-note">${escape(av.note)}</p>${av.amount ? `<p style="font-weight:700;color:var(--blue)">Monto adicional: ${fm(av.amount)}</p>` : ''}${atts ? `<div>${atts}</div>` : ''}${clientApprovalHtml}<button class="btn bh xs" data-action="remove-avance" data-av="${j}" style="margin-top:10px">Quitar</button></div></details>`;
    }).join('') : '<p style="color:var(--mut)">Aún no hay avances registrados para este proyecto.</p>';
    el.querySelectorAll('.att-thumb').forEach(img => {
      if (!img.getAttribute('src') && img.dataset.path && window.firebase && window.rnFiles) {
        rnFiles.url(img.dataset.path).then(url => { img.src = url; }).catch(() => {});
      }
    });
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
        const acc = accDoc.exists ? accDoc.data() : null;
        const email = acc ? acc.email : '(cuenta no encontrada)';
        const clientSigHtml = acc && safeSig(acc.signature)
          ? `<p style="margin-top:10px;font-weight:700">Firma del cliente:</p><img src="${safeSig(acc.signature)}" alt="Firma del cliente" style="max-width:260px;border:1px solid var(--bd);border-radius:8px;background:#fff">`
          : `<p style="margin-top:10px;color:var(--mut)">El cliente aún no ha firmado.</p>`;
        box.innerHTML = `<p>Cliente con acceso a este proyecto: <strong>${escape(email)}</strong></p>${clientSigHtml}${safeSig(acc && acc.signature) ? '<button class="btn bh sm" data-action="reset-client-sig" style="margin-top:10px;margin-right:8px">Permitir que el cliente firme de nuevo</button>' : ''}<button class="btn br sm" data-action="revoke-client" style="margin-top:10px">Revocar acceso</button>`;
        /* Se copia la firma del cliente al proyecto (aunque solo viva de
           verdad en su cuenta de Firestore) para que el generador de PDF,
           que no tiene acceso a la nube en ese momento, pueda incluirla. */
        const newClientSig = safeSig(acc && acc.signature);
        const approvals = (acc && acc.avanceApprovals) || {};
        let avancesChanged = false;
        if (data.draft.id === projectId) {
          (data.draft.avances || []).forEach(av => {
            const ap = approvals[av.id];
            const agreed = !!(ap && ap.agreed), sig = safeSig(ap && ap.signature);
            if (av.clientAgreed !== agreed || av.clientSignature !== sig) { av.clientAgreed = agreed; av.clientSignature = sig; avancesChanged = true; }
          });
        }
        if (data.draft.id === projectId && (data.draft.clientSignatureCache !== newClientSig || avancesChanged)) {
          data.draft.clientSignatureCache = newClientSig;
          renderAvances();
          changed();
          syncDraftToSavedProject();
        }
        setTimeout(runStamping, 800);
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
    <div class="card"><div class="ct">Avance de instalación</div><p style="margin-bottom:12px;color:var(--mut)">Marca aquí el avance real de la obra. El tablero y el plano/AutoCAD valen 15% cada uno (salvo que el proyecto no los lleve); el resto se reparte entre los trabajos del presupuesto. Esto es lo único de esta sección que el cliente puede ver (sin poder editarlo).</p><div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:var(--blue);margin-bottom:6px"><span>Progreso general</span><span id="pr-progress-pct">0%</span></div><div style="background:var(--c2);border-radius:999px;height:14px;overflow:hidden"><div id="pr-progress-bar" style="background:var(--blue);height:100%;width:0%;transition:width .2s"></div></div></div><div id="pr-progress-fixed"><label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="pr-progress-tablero" data-action="toggle-tablero"> <span>Tablero eléctrico instalado (15%)</span></label><label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer"><input type="checkbox" id="pr-progress-plano" data-action="toggle-plano"> <span>Plano eléctrico / AutoCAD entregado (15%)</span></label></div><label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer;font-size:13px;color:var(--mut)"><input type="checkbox" id="pr-progress-nofixed" data-action="toggle-nofixed"> <span>Este proyecto no lleva tablero ni plano: repartir el 100% entre los trabajos</span></label><div id="pr-progress-items"></div></div>
    <div class="card"><div class="ct">Datos del proyecto</div><div class="g2">${field('number', 'N° de informe / presupuesto')}${field('date', 'Fecha')}${field('title', 'Nombre del proyecto *')}${field('client', 'Titular / cliente *')}${field('location', 'Ubicación del proyecto')}${field('author', 'Elaborado por')}</div></div>
    <div class="card"><div class="ct">Informe técnico</div><p style="margin-bottom:12px;color:var(--mut)">Redacta las secciones que necesites. Las secciones vacías se omiten del PDF. Puedes separar los párrafos con una línea en blanco.</p><div class="pr-sections">${field('intro', 'Introducción', true)}${field('diagnosis', 'Observaciones y diagnóstico de la instalación', true, 'Describe los hallazgos y relaciona las fotografías por número.')}${field('corrections', 'Correcciones y verificaciones recomendadas', true)}${field('references', 'Referencias técnicas', true)}</div></div>
    <div class="card"><div class="ct">Registro fotográfico</div><p style="margin-bottom:12px">Agrega imágenes JPG, PNG o WebP (hasta 60). Se numeran en el orden de carga.</p><input id="pr-file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="pr-photos" style="margin-top:16px"></div></div>
    <div class="card"><div class="ct">Documentos de respaldo del proyecto</div><p style="margin-bottom:12px;color:var(--mut)">Adjunta aquí la cotización, informes, anexos u otros documentos de respaldo del proyecto (PDF o imágenes). No son avances: quedan como parte del proyecto, y el cliente los puede ver y descargar desde su portal.</p><div id="pr-docs" style="margin-bottom:12px"></div><label class="L" for="doc-file">Agregar documento (PDF o imagen)</label><input id="doc-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple></div>
    <div class="card"><div class="ct">Avances del proyecto</div><p style="margin-bottom:12px;color:var(--mut)">Registra aquí las novedades y el avance del trabajo a medida que ocurren. Si le das acceso al cliente de este proyecto, esto es lo que él va a poder ver y descargar.</p><div id="av-list" style="margin-bottom:14px"></div><div class="card" style="background:rgba(0,0,0,.03)"><label class="L" for="av-note">Nueva nota de avance</label><textarea id="av-note" rows="3" placeholder="Ej: Se realizó el levantamiento inicial del tablero..."></textarea><label class="L" style="margin-top:10px" for="av-amount">Monto adicional (opcional, si este avance incluye un anexo/presupuesto extra)</label><input id="av-amount" type="number" min="0" max="999999999999" step="1" placeholder="Ej: 108000"><label class="L" style="margin-top:10px" for="av-file">Adjuntar fotos o PDF (opcional)</label><input id="av-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple><div id="av-pending" style="margin-top:8px;color:var(--mut);font-size:12px"></div><button class="btn bg sm" data-action="add-avance" style="margin-top:12px">+ Agregar avance</button></div></div>
    <div class="card"><div class="ct">Presupuesto detallado · Solo trabajo</div>${field('scope', 'Alcance incluido', true)}<div style="overflow-x:auto;margin-top:16px"><table class="pr-table"><thead><tr><th>Ítem</th><th>Trabajo</th><th>Alcance incluido</th><th>Valor neto CLP</th><th></th></tr></thead><tbody id="pr-rows"></tbody></table></div><button class="btn bb sm" data-action="add-row" style="margin-top:12px">+ Agregar trabajo</button><div class="card-hi" style="max-width:480px;margin:18px 0 0 auto"><div class="row"><span>Total neto de los servicios</span><strong id="pr-net"></strong></div><div class="row"><span>IVA 19%</span><strong id="pr-tax"></strong></div><div class="row"><strong>Total del servicio con IVA</strong><strong id="pr-total"></strong></div><p style="margin-top:10px;color:var(--mut)">Materiales no incluidos. Cada valor corresponde al total neto del trabajo de esa fila.</p></div></div>
    <div class="card"><div class="ct">Condiciones y aprobación</div><div class="pr-sections">${field('conditions', 'Condiciones de ejecución, pago, plazo y garantía', true)}${field('approval', 'Texto de aprobación del presupuesto', true)}${field('representative', 'Representante ELECTROVOLT TEMPLE SPA. para la firma')}</div></div>
    <div class="card"><div class="ct">Firma digital · ELECTROVOLT TEMPLE SPA.</div><p style="margin-bottom:12px;color:var(--mut)">Dibuja tu firma o adjunta una imagen. Esta firma queda guardada en el proyecto y el cliente la puede ver (sin poder editarla).</p><div id="owner-sig-view"></div></div>
    <div class="card"><div class="ct">Acceso del cliente</div><div id="client-access-box"><p style="color:var(--mut)">Cargando…</p></div></div>
    <div class="card"><div class="ct">Proyectos guardados</div><div id="pr-history"></div></div>`;
    renderRows(); renderPhotos(); renderDocuments(); renderAvances(); renderHistory(); renderOwnerSignature();
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
  /* Si este borrador se cargo antes de que otra sesion/dispositivo agregara
     un avance nuevo, guardar aqui sin mas reemplazaria todo el proyecto con
     una version vieja y borraria ese avance ajeno. Se conserva (union por
     id) cualquier avance que ya estuviera guardado y que el borrador actual
     no tenga, para que agregar o tickear algo en un lugar nunca borre lo
     que se agrego en otro. */
  function mergeAvances(savedProject, draftEntry) {
    const saved = (savedProject && savedProject.avances) || [];
    const draftIds = new Set((draftEntry.avances || []).map(av => av.id));
    /* No revivir un avance que se borro a proposito (en esta sesion o en
       otra): reutiliza la misma lista de tombstones ya sincronizada con la
       nube que usan los proyectos eliminados. */
    const deleted = new Set(cloudDelGet());
    const missing = saved.filter(av => !draftIds.has(av.id) && !deleted.has(av.id));
    /* Un borrador viejo tampoco debe reponer un avance que ya se elimino en
       otro dispositivo (su id esta en los tombstones sincronizados). */
    return (draftEntry.avances || []).filter(av => !deleted.has(av.id)).concat(missing);
  }
  function mergeDocuments(savedProject, draftEntry) {
    const saved = (savedProject && savedProject.documents) || [];
    const draftIds = new Set((draftEntry.documents || []).map(d => d.id));
    const deleted = new Set(cloudDelGet());
    const missing = saved.filter(d => d.id && !draftIds.has(d.id) && !deleted.has(d.id));
    return (draftEntry.documents || []).filter(d => !deleted.has(d.id)).concat(missing);
  }
  /* Compara el borrador con el proyecto guardado ignorando la marca de
     tiempo: si son iguales, el borrador no tiene cambios sin guardar. */
  function sameProjectContent(a, b) {
    if (!a || !b) return false;
    /* Se ignoran campos derivados que la app recalcula sola al abrir
       (aprobaciones y firma del cliente copiadas desde su cuenta). */
    const strip = o => {
      const c = clone(o);
      delete c.updatedAt; delete c.clientSignatureCache;
      (c.avances || []).forEach(av => { delete av.clientAgreed; delete av.clientSignature; });
      return JSON.stringify(c);
    };
    return strip(a) === strip(b);
  }
  async function saveProject() {
    if (!valid()) return false;
    await whenFirstMerge(10000);
    /* Espera a que termine cualquier fusion de la nube en curso antes de
       tocar data.projects (una fusion puede tardar varios segundos bajando
       fotos; si se edita mientras tanto, la fusion podria sobreescribir
       el cambio al terminar). */
    await mergeChain.catch(() => {});
    const previous = clone(data.projects);
    const entry = clone(data.draft);
    entry.updatedAt = Date.now();
    const i = data.projects.findIndex(p => p.id === entry.id);
    if (i >= 0) { entry.avances = mergeAvances(data.projects[i], entry); data.draft.avances = entry.avances; entry.documents = mergeDocuments(data.projects[i], entry); data.draft.documents = entry.documents; }
    if (i < 0) data.projects.unshift(entry); else data.projects[i] = entry;
    if (!await persist()) { data.projects = previous; return false; }
    renderAvances();
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
    if (!data.projects.some(p => p.id === data.draft.id)) return;
    /* Espera la primera fusion con la nube: asi, un dispositivo con copia
       vieja primero se pone al dia y recien despues refleja cambios. */
    await whenFirstMerge(20000);
    await mergeChain.catch(() => {});
    const j = data.projects.findIndex(p => p.id === data.draft.id);
    if (j < 0) return;
    const previous = clone(data.projects);
    const entry = clone(data.draft);
    entry.updatedAt = Date.now();
    entry.avances = mergeAvances(data.projects[j], entry);
    data.draft.avances = entry.avances;
    entry.documents = mergeDocuments(data.projects[j], entry);
    data.draft.documents = entry.documents;
    data.projects[j] = entry;
    if (!await persist()) { data.projects = previous; return; }
    renderAvances();
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
        const note = noteEl ? noteEl.value.trim() : '';
        const amountEl = document.getElementById('av-amount');
        const amountN = amountEl ? Number(amountEl.value) : 0;
        if (amountEl && amountEl.value && (!Number.isSafeInteger(amountN) || amountN < 0 || amountN > 999999999999)) { alert('El monto adicional debe ser un valor en pesos entero, positivo o cero.'); return; }
        const amount = Number.isFinite(amountN) && amountN > 0 ? amountN : 0;
        if (!note && !pendingAvanceFiles.length && !amount) { alert('Escribe una nota, adjunta al menos un archivo o ingresa un monto adicional.'); return; }
        const now = new Date();
        data.draft.avances = data.draft.avances || [];
        data.draft.avances.push({
          id: uid(), date: now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()),
          note: note, amount: amount, attachments: pendingAvanceFiles
        });
        pendingAvanceFiles = [];
        if (noteEl) noteEl.value = '';
        if (amountEl) amountEl.value = '';
        const pend = document.getElementById('av-pending'); if (pend) pend.textContent = '';
        renderAvances(); changed();
        await syncDraftToSavedProject();
      }
      if (action === 'remove-avance' && confirm('¿Quitar este avance del proyecto?')) {
        const av = data.draft.avances[Number(button.dataset.av)];
        data.draft.avances.splice(Number(button.dataset.av), 1);
        if (av && av.id) { const d = cloudDelGet(); if (d.indexOf(av.id) < 0) { d.push(av.id); cloudDelSet(d); } }
        renderAvances(); changed();
        await syncDraftToSavedProject();
        if (av) (av.attachments || []).forEach(a => { if (a.storagePath) deleteStoragePhoto(a.storagePath); });
      }
      if (action === 'edit-owner-sig') { ownerSigEditing = true; renderOwnerSignature(); }
      if (action === 'cancel-owner-sig') { ownerSigEditing = false; renderOwnerSignature(); }
      if (action === 'clear-owner-sig') {
        ownerSigPendingUpload = null; ownerSigHasDrawn = false;
        const canvas = document.getElementById('owner-sig-canvas');
        if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        const prev = document.getElementById('owner-sig-preview'); if (prev) prev.innerHTML = '';
      }
      if (action === 'save-owner-sig') {
        const canvas = document.getElementById('owner-sig-canvas');
        if (!ownerSigPendingUpload && !ownerSigHasDrawn) { alert('Dibuja tu firma o adjunta una imagen antes de guardar.'); return; }
        data.draft.ownerSignature = ownerSigPendingUpload || canvas.toDataURL('image/png');
        ownerSigEditing = false;
        renderOwnerSignature(); changed();
        await syncDraftToSavedProject();
      }
      if (action === 'ver-doc') {
        const d = (data.draft.documents || [])[i];
        const isPdf = d && d.type === 'pdf';
        if (d && d.storagePath) openStorageViewer(d.name, d.storagePath, isPdf);
        else if (d && d.data && isPdf) {
          const parts = d.data.split(',');
          const bin = atob(parts[1] || '');
          const bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          window.open(URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'})), '_blank');
        } else if (d && d.data) {
          const ov = ensureDocViewer();
          document.getElementById('doc-viewer-title').textContent = d.name;
          document.getElementById('doc-viewer-frame').src = d.data;
          document.getElementById('doc-viewer-open').href = d.data;
          ov.style.display = 'block';
        }
      }
      if (action === 'remove-doc' && confirm('¿Quitar este documento del proyecto?')) {
        const d = (data.draft.documents || [])[i];
        data.draft.documents.splice(i, 1);
        if (d && d.id) { const del = cloudDelGet(); if (del.indexOf(d.id) < 0) { del.push(d.id); cloudDelSet(del); } }
        renderDocuments(); changed();
        await syncDraftToSavedProject();
        if (d && d.storagePath) deleteStoragePhoto(d.storagePath);
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
        const clientUid = button.dataset.uid;
        await firebase.firestore().collection('clientAccounts').doc(clientUid).update({status: 'approved', projectId: data.draft.id, approvedAt: Date.now()});
        await firebase.firestore().collection('clientView').doc(data.draft.id).set({clientUid: clientUid, clientApproved: true}, {merge: true});
        renderClientAccess();
      }
      if (action === 'reset-client-sig' && confirm('El cliente podrá dibujar su firma de nuevo. Las aprobaciones de avances ya firmadas se mantienen. ¿Continuar?')) {
        const mir = await firebase.firestore().collection('clientView').doc(data.draft.id).get();
        const uid = mir.exists ? mir.data().clientUid : null;
        if (uid) await firebase.firestore().collection('clientAccounts').doc(uid).update({signature: '', signedAt: 0});
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
        busy = true; button.disabled = true; status('Sincronizando firma y aprobaciones del cliente…');
        /* Espera a que la firma/aprobaciones mas recientes del cliente (que
           solo viven de verdad en su cuenta de Firestore) se copien al
           proyecto antes de generar el PDF, para no incluir una version
           vieja si el dueño genera el PDF justo al abrir el proyecto. */
        try { await renderClientAccess(); } catch (e) {}
        status('Generando PDF… Elige dónde guardarlo.');
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
  /* Firma digital: se puede dibujar a mano (mouse o dedo) o adjuntar una
     imagen; en ambos casos queda guardada como PNG en base64. */
  function initSignaturePad(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let drawing = false, last = null;
    const pos = e => {
      const r = canvas.getBoundingClientRect();
      const t = e.touches && e.touches[0];
      const cx = (t ? t.clientX : e.clientX) - r.left, cy = (t ? t.clientY : e.clientY) - r.top;
      return {x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height)};
    };
    const start = e => { drawing = true; last = pos(e); e.preventDefault(); };
    const move = e => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; ownerSigHasDrawn = true; e.preventDefault();
    };
    const end = () => { drawing = false; };
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, {passive: false});
    canvas.addEventListener('touchmove', move, {passive: false});
    canvas.addEventListener('touchend', end);
  }
  async function fileToPngDataUrl(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Usa una imagen JPG, PNG o WebP.');
    if (file.size > 3 * 1024 * 1024) throw new Error('La imagen es demasiado grande (máx. 3 MB).');
    const image = new Image(), url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('No se pudo leer la imagen.')); image.src = url; });
      const scale = Math.min(1, 500 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
  }
  function renderOwnerSignature() {
    const el = document.getElementById('owner-sig-view');
    if (!el) return;
    const saved = data.draft.ownerSignature;
    if (saved && !ownerSigEditing) {
      el.innerHTML = `<img src="${safeSig(saved)}" alt="Firma de ELECTROVOLT TEMPLE SPA." style="max-width:320px;display:block;margin-bottom:10px;border:1px solid var(--bd);border-radius:8px;background:#fff"><button class="btn bh sm" data-action="edit-owner-sig">Cambiar firma</button>`;
      return;
    }
    ownerSigPendingUpload = null; ownerSigHasDrawn = false;
    el.innerHTML = `<canvas id="owner-sig-canvas" width="400" height="150" style="border:1px solid var(--bd);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair;display:block;max-width:100%"></canvas><div id="owner-sig-preview" style="margin-top:8px"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn bh sm" data-action="clear-owner-sig">Limpiar</button><label class="btn bh sm" for="owner-sig-file" style="cursor:pointer">Adjuntar imagen<input id="owner-sig-file" type="file" accept="image/jpeg,image/png,image/webp" hidden></label><button class="btn bg sm" data-action="save-owner-sig">Guardar firma</button>${saved ? '<button class="btn bh sm" data-action="cancel-owner-sig">Cancelar</button>' : ''}</div>`;
    initSignaturePad('owner-sig-canvas');
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
    const progressAction = event.target.dataset.action;
    if (progressAction === 'toggle-tablero') { data.draft.tableroDone = event.target.checked; renderProgress(); changed(); await syncDraftToSavedProject(); return; }
    if (progressAction === 'toggle-nofixed') { data.draft.noFixedProgress = event.target.checked; renderProgress(); changed(); await syncDraftToSavedProject(); return; }
    if (progressAction === 'toggle-plano') { data.draft.planoDone = event.target.checked; renderProgress(); changed(); await syncDraftToSavedProject(); return; }
    if (progressAction === 'toggle-stage') {
      const row = data.draft.items[Number(event.target.dataset.row)];
      if (row) { row[event.target.dataset.stage] = event.target.checked; renderProgress(); changed(); await syncDraftToSavedProject(); }
      return;
    }
    if (!['pr-file', 'pr-import', 'av-file', 'doc-file', 'owner-sig-file'].includes(event.target.id)) return;
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
      } else if (event.target.id === 'owner-sig-file') {
        const file = event.target.files[0];
        if (file) {
          ownerSigPendingUpload = await fileToPngDataUrl(file);
          const prev = document.getElementById('owner-sig-preview');
          if (prev) prev.innerHTML = `<img src="${safeSig(ownerSigPendingUpload)}" alt="Vista previa" style="max-width:260px;border:1px solid var(--bd);border-radius:8px;background:#fff">`;
        }
      } else if (event.target.id === 'doc-file') {
        const files = Array.from(event.target.files);
        if ((data.draft.documents || []).length + files.length > 20) throw new Error('Máximo 20 documentos por proyecto.');
        status('Preparando documentos…');
        const added = [];
        for (const file of files) {
          const result = await avanceFileData(file);
          added.push({id: uid(), name: file.name, type: result.type, data: result.data});
        }
        data.draft.documents = (data.draft.documents || []).concat(added);
        renderDocuments(); changed();
        await syncDraftToSavedProject();
        status(added.length + ' documento(s) agregado(s) al proyecto.');
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
        if (imported.format !== 'rn-project-v1' || !imported.project || !Array.isArray(imported.project.items) || !Array.isArray(imported.project.photos)) throw new Error('El archivo no es un proyecto editable de ELECTROVOLT TEMPLE SPA.');
        if (!confirm('¿Importar este proyecto y reemplazar el borrador actual?')) return;
        // The Python validator checks every field before accepting imported data.
        if (!await persist()) throw new Error('No se pudo guardar el borrador actual antes de importar.');
        const previous = data.draft;
        const candidate = {...blank(), ...imported.project, id: uid()};
        data.draft = candidate;
        if (!await persist()) { data.draft = previous; throw new Error('No se pudo importar. Revisa que sea un proyecto válido de ELECTROVOLT TEMPLE SPA.'); }
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
