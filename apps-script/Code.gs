/**
 * Cuadro de mando familiar — Google Apps Script
 * Archivos del proyecto: Code.gs (este) + Index.html
 *
 * 1. Revisa CONFIG.
 * 2. Implementar → Nueva implementación → Aplicación web
 *    · Ejecutar como: Yo   · Quién tiene acceso: Solo yo (o «Cualquier persona» si el iPad no tiene tu cuenta de Google)
 * 3. Abre la URL /exec en el iPad y agrégala a la pantalla de inicio.
 * 4. (Opcional, secadora) Rellena ST_CLIENT_ID / ST_CLIENT_SECRET y ejecuta conectarSmartThings().
 */
var CONFIG = {
  CALENDAR_NAME: 'Nombre del calendario', // nombre exacto del calendario en Google Calendar
  LAT: -41.4693, LON: -72.9424,   // Puerto Montt
  METAR: 'SCPF,SCTE',             // Aeródromo La Paloma; respaldo El Tepual
  ALERT_REGION: '10b',            // Región para alertas DMC (10b = Los Lagos)
  GEMINI_MODEL: 'gemini-flash-latest', // modelo de Gemini para «Importar desde foto»
  KEY: '',                        // Clave secreta (OBLIGATORIA para el panel en GitHub Pages). Ej: 'casa-montt-7319'
  ST_CLIENT_ID: '',               // SmartThings OAuth (secadora Samsung)
  ST_CLIENT_SECRET: '',
  ST_DRYER_ID: ''                 // vacío = se busca automáticamente
};

/* ===================== WEB ===================== */
function doGet(e) {
  if (e && e.parameter && e.parameter.code) return stCallback_(e.parameter.code);
  if (e && e.parameter && e.parameter.fn) return jsonp_(e.parameter);
  if (CONFIG.KEY && (!e || !e.parameter || e.parameter.k !== CONFIG.KEY)) return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Acceso no autorizado.</p>');
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Cuadro de mando familiar')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Una sola llamada al cargar: calendario + clima + secadora + datos familiares */
function getAll(startMs, endMs) {
  var out = { errors: {} };
  try { out.events = getCalendar(startMs, endMs); } catch (err) { out.errors.cal = String(err.message || err); }
  try { out.wx = getWeather(); } catch (err) { out.errors.wx = String(err.message || err); }
  try { out.dryer = getDryer(); } catch (err) { out.errors.dryer = String(err.message || err); }
  try { out.data = getData(); } catch (err) { out.errors.data = String(err.message || err); }
  try { out.holidays = getHolidays(); } catch (err) { out.errors.hol = String(err.message || err); }
  try { out.alerts = getAlerts(); } catch (err) { out.errors.alerts = String(err.message || err); }
  try { out.photos = listPhotos(); } catch (err) { out.errors.photos = String(err.message || err); }
  out.gemini = hasGemini();
  return out;
}

/* ===================== API PARA EL PANEL EN GITHUB PAGES =====================
 * El panel alojado fuera de Google llama aquí por POST: {k:CLAVE, fn:'getAll', args:[...]}
 * Solo se permiten las funciones de esta lista y siempre con la clave correcta. */
function apiFns_() {
  return { getAll: getAll, getData: getData, saveData: saveData, getDryer: getDryer, getCalendar: getCalendar, saveEvent: saveEvent, deleteEvent: deleteEvent,
    listPhotos: listPhotos, getPhoto: getPhoto, savePhoto: savePhoto, importFromImage: importFromImage, suggestIngredients: suggestIngredients, setGeminiKey: setGeminiKey, ping: ping };
}
function ping() { return { ok: true, calendar: CONFIG.CALENDAR_NAME, time: new Date().toISOString() }; }
function dispatch_(req) {
  if (!CONFIG.KEY) throw new Error('Falta definir KEY en Code.gs');
  if (req.k !== CONFIG.KEY) throw new Error('Clave incorrecta');
  var f = apiFns_()[req.fn];
  if (typeof f !== 'function') throw new Error('Función no permitida');
  return f.apply(null, req.args || []);
}
function run_(req) {
  try { return { ok: true, result: dispatch_(req) }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}
/* Vía 1: POST con JSON. Si el navegador no puede leer la respuesta (Safari a veces la bloquea),
   el resultado queda guardado unos minutos con el identificador «rid» para pedirlo por la vía 2. */
function doPost(e) {
  var req = {};
  try { req = JSON.parse(e && e.postData && e.postData.contents || '{}'); } catch (err) {}
  var out = run_(req);
  if (req.rid && /^[\w-]{6,40}$/.test(req.rid) && req.k === CONFIG.KEY) {
    var s = JSON.stringify(out);
    try { CacheService.getScriptCache().put('r_' + req.rid, s.length < 95000 ? s : JSON.stringify({ ok: true, result: null, big: true }), 600); } catch (err) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
/* Vía 2: GET con respuesta en JavaScript (JSONP). Funciona en cualquier navegador, incluso iOS antiguos. */
function jsonp_(p) {
  var cb = /^[A-Za-z_$][\w$]{0,60}$/.test(p.cb || '') ? p.cb : 'callback', out;
  if (p.fn === 'result') {
    if (p.k !== CONFIG.KEY) out = { ok: false, error: 'Clave incorrecta' };
    else { var s = CacheService.getScriptCache().get('r_' + p.rid); out = s ? JSON.parse(s) : { pending: true }; }
  } else {
    var args = [];
    try { args = JSON.parse(p.a || '[]'); } catch (err) {}
    out = run_({ k: p.k, fn: p.fn, args: args });
  }
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(out) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/* ===================== CALENDARIO ===================== */
var GCOLORS = { '1':'#7986CB','2':'#33B679','3':'#8E24AA','4':'#E67C73','5':'#F6BF26','6':'#F4511E','7':'#039BE5','8':'#616161','9':'#3F51B5','10':'#0B8043','11':'#D50000' };
function getCalendar(startMs, endMs) {
  var cals = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (!cals.length) throw new Error('No encuentro el calendario "' + CONFIG.CALENDAR_NAME + '"');
  var cal = cals[0], tz = cal.getTimeZone();
  return cal.getEvents(new Date(startMs), new Date(endMs)).map(function (ev) {
    var ad = ev.isAllDayEvent();
    return {
      title: ev.getTitle(), ad: ad,
      s: ad ? Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd') : ev.getStartTime().getTime(),
      e: ad ? Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd') : ev.getEndTime().getTime(),
      desc: ev.getDescription() || '', loc: ev.getLocation() || '',
      color: GCOLORS[ev.getColor()] || '', id: ev.getId(), rec: ev.isRecurringEvent()
    };
  });
}

/* ===== Editar el calendario desde el panel ===== */
function calObj_() {
  var c = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (!c.length) throw new Error('No encuentro el calendario "' + CONFIG.CALENDAR_NAME + '"');
  return c[0];
}
function ymdDate_(s, hhmm) {
  var p = String(s).split('-'), t = String(hhmm || '00:00').split(':');
  return new Date(+p[0], +p[1] - 1, +p[2], +t[0] || 0, +t[1] || 0);
}
/* Busca la ocurrencia exacta (sirve también para eventos que se repiten) */
function findEvent_(cal, id, orig) {
  var t = typeof orig === 'number' ? new Date(orig) : ymdDate_(orig);
  var list = cal.getEvents(new Date(t.getTime() - 864e5), new Date(t.getTime() + 2 * 864e5)), first = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].getId() !== id) continue;
    var st = list[i].isAllDayEvent() ? list[i].getAllDayStartDate() : list[i].getStartTime();
    if (Math.abs(st.getTime() - t.getTime()) < 6e4 || (typeof orig !== 'number' && list[i].isAllDayEvent())) return list[i];
    if (!first) first = list[i];
  }
  return first || cal.getEventById(id);
}
/** o = {id, orig, title, allDay, date:'yyyy-MM-dd', start:'HH:mm', end:'HH:mm', loc, desc} */
/** o = {id, orig, title, allDay, date, start, end, loc, desc, repeat:''|'weekly'|'biweekly', series:true|false} */
function saveEvent(o) {
  var cal = calObj_(), title = String(o.title || '').trim();
  if (!title) throw new Error('Falta el título');
  var opts = { location: o.loc || '', description: o.desc || '' }, s = ymdDate_(o.date, o.start), e = ymdDate_(o.date, o.end);
  if (!o.allDay && e <= s) throw new Error('La hora de término debe ser posterior a la de inicio');
  if (o.id) {
    var ev = findEvent_(cal, o.id, o.orig);
    if (!ev) throw new Error('No encontré el evento; puede que lo hayan borrado');
    if (o.series && ev.isRecurringEvent()) {           // cambiar toda la serie (título, lugar, notas/ingredientes)
      var ser = ev.getEventSeries();
      ser.setTitle(title); ser.setLocation(opts.location); ser.setDescription(opts.description);
      return true;
    }
    ev.setTitle(title); ev.setLocation(opts.location); ev.setDescription(opts.description);
    if (o.allDay) ev.setAllDayDate(ymdDate_(o.date)); else ev.setTime(s, e);
    return true;
  }
  if (o.repeat === 'weekly' || o.repeat === 'biweekly') {
    var rule = CalendarApp.newRecurrence().addWeeklyRule().interval(o.repeat === 'biweekly' ? 2 : 1);
    if (o.allDay) cal.createAllDayEventSeries(title, ymdDate_(o.date), rule, opts);
    else cal.createEventSeries(title, s, e, rule, opts);
    return true;
  }
  if (o.allDay) cal.createAllDayEvent(title, ymdDate_(o.date), opts);
  else cal.createEvent(title, s, e, opts);
  return true;
}
/** series=true borra todas las repeticiones */
function deleteEvent(id, orig, series) {
  var ev = findEvent_(calObj_(), id, orig);
  if (!ev) throw new Error('No encontré el evento');
  if (series && ev.isRecurringEvent()) ev.getEventSeries().deleteEventSeries();
  else ev.deleteEvent();
  return true;
}

/* ===================== GEMINI: importar desde foto y sugerir ingredientes =====================
 * Clave gratuita en https://aistudio.google.com/apikey · se guarda solo en este proyecto (no se envía al iPad). */
function setGeminiKey(k) { PropertiesService.getScriptProperties().setProperty('gemini_key', String(k || '').trim()); return hasGemini(); }
function hasGemini() { return !!PropertiesService.getScriptProperties().getProperty('gemini_key'); }
function gemini_(parts) {
  var key = PropertiesService.getScriptProperties().getProperty('gemini_key');
  if (!key) throw new Error('Falta la clave de Gemini (Ajustes)');
  var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent', {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
  });
  if (r.getResponseCode() !== 200) throw new Error('Gemini ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 180));
  var j = JSON.parse(r.getContentText()), txt = ((j.candidates || [])[0] || {}).content;
  txt = txt ? txt.parts.map(function (p) { return p.text || ''; }).join('') : '{}';
  return JSON.parse(txt.replace(/^\s*```(json)?/, '').replace(/```\s*$/, ''));
}
function importFromImage(dataUrl) {
  var m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error('Imagen inválida');
  var today = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd');
  var prompt = 'Hoy es ' + today + ' (zona horaria de Chile). Analiza la imagen (puede ser una circular del colegio, un menú, una invitación o una lista) y responde SOLO JSON con esta forma: ' +
    '{"events":[{"title":"","date":"YYYY-MM-DD","start":"HH:MM o vacío","end":"HH:MM o vacío","allDay":true,"location":"","notes":""}],' +
    '"meals":[{"date":"YYYY-MM-DD","dish":"","ingredients":[""]}],"shopping":[""]}. ' +
    'Escribe en español. Si falta el año, usa la fecha futura más cercana a hoy. Si un evento no tiene hora, allDay=true. No inventes nada: deja listas vacías si no hay datos.';
  return gemini_([{ text: prompt }, { inlineData: { mimeType: m[1], data: m[2] } }]);
}
function suggestIngredients(dish) {
  var j = gemini_([{ text: 'Lista los ingredientes principales para preparar "' + dish + '" para una familia en Chile. Responde SOLO JSON {"ingredients":["..."]} con nombres cortos en español, máximo 12, sin cantidades.' }]);
  return j.ingredients || [];
}

/* ===================== CLIMA ===================== */
function getWeather() {
  var cache = CacheService.getScriptCache(), hit = cache.get('wx3');
  if (hit) return JSON.parse(hit);
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + CONFIG.LAT + '&longitude=' + CONFIG.LON +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,is_day,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,uv_index_max' +
    '&timezone=America%2FSantiago&past_days=7&forecast_days=16';
  var wx = JSON.parse(UrlFetchApp.fetch(url).getContentText());
  try {
    var r = UrlFetchApp.fetch('https://aviationweather.gov/api/data/metar?ids=' + CONFIG.METAR + '&format=json', { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      var list = JSON.parse(r.getContentText() || '[]'), ids = CONFIG.METAR.split(',');
      for (var i = 0; i < ids.length && !wx.metar; i++)
        for (var k = 0; k < list.length; k++)
          if (list[k].icaoId === ids[i] && list[k].temp != null) { wx.metar = { id: list[k].icaoId, temp: list[k].temp, dewp: list[k].dewp, wspd: list[k].wspd, obs: list[k].obsTime }; break; }
    }
  } catch (err) {}
  try { cache.put('wx3', JSON.stringify(wx), 600); } catch (err) {}
  return wx;
}

/* ===================== FERIADOS DE CHILE ===================== */
function getHolidays() {
  var cache = CacheService.getScriptCache(), hit = cache.get('hol');
  if (hit) return JSON.parse(hit);
  var y = new Date().getFullYear(), out = {};
  [y, y + 1].forEach(function (yr) {
    try {
      var r = UrlFetchApp.fetch('https://date.nager.at/api/v3/PublicHolidays/' + yr + '/CL', { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) JSON.parse(r.getContentText()).forEach(function (h) { if (h.global !== false) out[h.date] = h.localName || h.name; });
    } catch (err) {}
  });
  if (!Object.keys(out).length) { // respaldo: calendario de feriados de Google
    var cal = CalendarApp.getCalendarById('es.cl#holiday@group.v.calendar.google.com');
    if (cal) cal.getEvents(new Date(y, 0, 1), new Date(y + 1, 11, 31)).forEach(function (ev) {
      out[Utilities.formatDate(ev.getAllDayStartDate(), 'America/Santiago', 'yyyy-MM-dd')] = ev.getTitle();
    });
  }
  if (Object.keys(out).length) cache.put('hol', JSON.stringify(out), 21600);
  return out;
}

/* ===================== ALERTAS METEOROLÓGICAS DMC (avisos, alertas, alarmas) ===================== */
var AAA_ORDER = { Alarma: 3, Alerta: 2, Aviso: 1 };
function getAlerts() {
  var cache = CacheService.getScriptCache(), hit = cache.get('aaa');
  if (hit) return JSON.parse(hit);
  var out = [];
  try {
    var r = UrlFetchApp.fetch('https://archivos.meteochile.gob.cl/portaldmc/AAA/datos_AAA.json', { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('DMC ' + r.getResponseCode());
    (JSON.parse(r.getContentText()).AAA || []).forEach(function (ev) {
      var modo = String(ev.tipoZonaAfecta || 'zonas').toLowerCase(), zonas = [];
      if (modo === 'zonas') {
        String(ev.dataZonaAfecta || '').split(',').forEach(function (z) { z = z.trim(); if (z.indexOf(CONFIG.ALERT_REGION + '_') === 0) zonas.push(prettyZone_(z)); });
        if (!zonas.length) return;
      } else {
        var pts = String(ev.dataZonaAfecta || '').split(',').map(function (p) { var c = p.split('|'); return [+c[0], +c[1]]; });
        if (!inPoly_([CONFIG.LON, CONFIG.LAT], pts)) return;
        zonas.push('Área que incluye Puerto Montt');
      }
      out.push(alertObj_(ev, zonas));
    });
  } catch (err) { // respaldo: copia pública de los mismos datos DMC
    var g = JSON.parse(UrlFetchApp.fetch('https://raw.githubusercontent.com/FranSENAPRED/dmc-alertas-geojson/main/data/eventos_AAA.geojson').getContentText()), byId = {};
    g.features.forEach(function (f) {
      var p = f.properties; if (String(p.region_zona || '').indexOf(CONFIG.ALERT_REGION + '_') !== 0) return;
      if (!byId[p.id]) { byId[p.id] = alertObj_(p, []); out.push(byId[p.id]); }
      byId[p.id].zonas.push(prettyZone_(p.region_zona));
    });
  }
  out.sort(function (a, b) { return (AAA_ORDER[b.tipo] || 0) - (AAA_ORDER[a.tipo] || 0); });
  cache.put('aaa', JSON.stringify(out), 900);
  return out;
}
function alertObj_(ev, zonas) {
  return { id: ev.id, cod: ev.codigoMeteo, tipo: dec_(ev.tipo), fen: dec_(ev.fenomeno), titulo: dec_(ev.titulo), desde: dec_(ev.desde), hasta: dec_(ev.hasta), emision: dec_(ev.emision), zonas: zonas };
}
function prettyZone_(z) { return String(z).replace(/^[^_]+_/, '').replace(/_/g, ' ').replace('Chiloe', 'Chiloé'); }
function inPoly_(pt, ring) {
  var x = pt[0], y = pt[1], inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function dec_(s) {
  var map = { aacute:'á', eacute:'é', iacute:'í', oacute:'ó', uacute:'ú', ntilde:'ñ', Aacute:'Á', Eacute:'É', Iacute:'Í', Oacute:'Ó', Uacute:'Ú', Ntilde:'Ñ', uuml:'ü', deg:'°', quot:'"', amp:'&', lt:'<', gt:'>', nbsp:' ', ordm:'º', ordf:'ª', iexcl:'¡', iquest:'¿' };
  return String(s == null ? '' : s).replace(/&([a-zA-Z]+);/g, function (m, n) { return map[n] || m; }).replace(/&#(\d+);/g, function (m, c) { return String.fromCharCode(+c); });
}

/* ===================== DATOS FAMILIARES (tareas, estrellas, compras) ===================== */
function getData() {
  var s = readBig_('data'), d = s ? JSON.parse(s) : null;
  if (!d) return null;
  d.tasksOff = (typeof Tasks === 'undefined');
  if (!d.tasksOff) {
    try { if (importShopFromTasks_(d)) saveData(d); delete d.tasksError; }
    catch (err) { d.tasksError = String(err.message || err); }
  }
  return d;
}

/* ===================== «OK GOOGLE, RECUÉRDAME COMPRAR LECHE» → LISTA DE COMPRAS =====================
 * Los recordatorios del Asistente se guardan en Google Tasks. Las tareas que empiezan con «comprar»
 * se pasan a la lista de compras y se marcan como completadas en Tasks.
 * Requiere activar el servicio «Google Tasks API» (identificador: Tasks) en el editor → Servicios. */
var SHOP_RE = /^\s*(comprar|compra|añadir a la compra|agregar a la compra)\s*:?\s+/i;
function importShopFromTasks_(d) {
  var added = false, lists = Tasks.Tasklists.list({ maxResults: 20 }).items || [];
  d.shop = d.shop || [];
  lists.forEach(function (l) {
    var items = Tasks.Tasks.list(l.id, { showCompleted: false, showHidden: false, maxResults: 100 }).items || [];
    items.forEach(function (t) {
      var title = String(t.title || '');
      if (!SHOP_RE.test(title)) return;
      splitItems_(title.replace(SHOP_RE, '')).forEach(function (n) {
        var dup = d.shop.some(function (x) { return !x.ok && String(x.n).toLowerCase() === n.toLowerCase(); });
        if (!dup) d.shop.push({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), n: n, ok: false, v: 1 });
      });
      Tasks.Tasks.patch({ status: 'completed' }, l.id, t.id);
      added = true;
    });
  });
  return added;
}
function splitItems_(s) {
  return String(s).split(/\s*(?:,|;|\s+y\s+|\s+e\s+)\s*/i).map(function (x) {
    x = x.replace(/^\s+|[\s.]+$/g, ''); return x ? x.charAt(0).toUpperCase() + x.slice(1) : '';
  }).filter(function (x) { return x; });
}
function saveData(d) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    // Las estrellas de días antiguos pasan a un «banco» para que el historial no crezca sin límite
    var cutoff = Utilities.formatDate(new Date(Date.now() - 35 * 864e5), 'America/Santiago', 'yyyy-MM-dd');
    d.bank = d.bank || 0;
    for (var day in d.done) if (day < cutoff) { for (var t in d.done[day]) d.bank += d.done[day][t].s || 0; delete d.done[day]; }
    while (d.redeemed && d.redeemed.length > 20) d.bank -= d.redeemed.shift().c;
    // No perder productos llegados por voz mientras el iPad guardaba otra cosa
    var prev = readBig_('data'), del = d.del || [];
    if (prev) (JSON.parse(prev).shop || []).forEach(function (x) {
      if (String(x.id).charAt(0) === 'g' && del.indexOf(x.id) < 0 && !d.shop.some(function (y) { return y.id === x.id; })) d.shop.push(x);
    });
    if (d.del && d.del.length > 60) d.del = d.del.slice(-60);
    writeBig_('data', JSON.stringify(d));
    return true;
  } finally { lock.releaseLock(); }
}
function readBig_(key) {
  var p = PropertiesService.getScriptProperties(), n = +p.getProperty(key + '_n') || 0, s = '';
  for (var i = 0; i < n; i++) s += p.getProperty(key + '_' + i) || '';
  return s;
}
function writeBig_(key, str) {
  var p = PropertiesService.getScriptProperties(), parts = {}, n = Math.ceil(str.length / 8000) || 1;
  for (var i = 0; i < n; i++) parts[key + '_' + i] = str.substr(i * 8000, 8000);
  parts[key + '_n'] = String(n);
  p.setProperties(parts);
}

/* ===================== SMARTTHINGS · SECADORA ===================== */
function getDryer() {
  if (!stToken_()) return { configured: false };
  var cache = CacheService.getScriptCache(), hit = cache.get('dryer');
  var now = hit ? JSON.parse(hit) : stDryerNow_();
  if (!hit) cache.put('dryer', JSON.stringify(now), 60);
  var log = readBig_('dryerlog');
  return { configured: true, now: now, log: log ? JSON.parse(log) : [] };
}
function stDryerNow_() {
  var p = PropertiesService.getScriptProperties(), id = CONFIG.ST_DRYER_ID || p.getProperty('st_dryer');
  if (!id) {
    var list = stApi_('/devices?capability=dryerOperatingState');
    if (!list.items || !list.items.length) throw new Error('No encuentro una secadora en SmartThings');
    id = list.items[0].deviceId; p.setProperty('st_dryer', id);
  }
  var m = stApi_('/devices/' + id + '/status').components.main, out = { t: Date.now() };
  var pc = m.powerConsumptionReport && m.powerConsumptionReport.powerConsumption && m.powerConsumptionReport.powerConsumption.value;
  if (pc) { out.wh = pc.energy; out.w = pc.power; }
  if (m.powerMeter && m.powerMeter.power) out.w = m.powerMeter.power.value;
  if (m.energyMeter && m.energyMeter.energy && out.wh == null) out.wh = m.energyMeter.energy.value * 1000;
  var op = m.dryerOperatingState || {};
  out.state = op.machineState ? op.machineState.value : (m['switch'] ? m['switch']['switch'].value : null);
  out.job = op.dryerJobState ? op.dryerJobState.value : null;
  out.end = op.completionTime ? op.completionTime.value : null;
  return out;
}
/** Activador cada 30 min: guarda el contador de energía para el gráfico (8 días) */
function logDryer() {
  var d = stDryerNow_(); if (d.wh == null) return;
  var log = JSON.parse(readBig_('dryerlog') || '[]');
  log.push([Math.round(d.t / 60000), Math.round(d.wh)]);
  var min = Math.round((Date.now() - 8 * 864e5) / 60000);
  log = log.filter(function (x) { return x[0] >= min; });
  writeBig_('dryerlog', JSON.stringify(log));
}
function stApi_(path) {
  var r = UrlFetchApp.fetch('https://api.smartthings.com/v1' + path, { headers: { Authorization: 'Bearer ' + stToken_() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('SmartThings ' + r.getResponseCode());
  return JSON.parse(r.getContentText());
}
function stToken_() {
  var p = PropertiesService.getScriptProperties(), tok = p.getProperty('st_access'), exp = +p.getProperty('st_exp') || 0;
  if (tok && Date.now() < exp - 60000) return tok;
  var rt = p.getProperty('st_refresh');
  if (!rt || !CONFIG.ST_CLIENT_ID) return null;
  return stTokenRequest_({ grant_type: 'refresh_token', client_id: CONFIG.ST_CLIENT_ID, refresh_token: rt });
}
function stTokenRequest_(payload) {
  var r = UrlFetchApp.fetch('https://auth-global.api.smartthings.com/oauth/token', {
    method: 'post', payload: payload, muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(CONFIG.ST_CLIENT_ID + ':' + CONFIG.ST_CLIENT_SECRET) }
  });
  if (r.getResponseCode() !== 200) throw new Error('SmartThings token ' + r.getResponseCode() + ': ' + r.getContentText());
  var j = JSON.parse(r.getContentText()), p = PropertiesService.getScriptProperties();
  p.setProperties({ st_access: j.access_token, st_refresh: j.refresh_token, st_exp: String(Date.now() + j.expires_in * 1000) });
  return j.access_token;
}
function stCallback_(code) {
  stTokenRequest_({ grant_type: 'authorization_code', client_id: CONFIG.ST_CLIENT_ID, code: code, redirect_uri: ScriptApp.getService().getUrl() });
  return HtmlService.createHtmlOutput('<h2 style="font-family:sans-serif">SmartThings conectado ✓</h2><p style="font-family:sans-serif">Ya puedes cerrar esta pestaña.</p>');
}
/** Ejecuta esta función UNA vez desde el editor: muestra el enlace para autorizar SmartThings y crea el activador */
function conectarSmartThings() {
  var url = 'https://api.smartthings.com/oauth/authorize?client_id=' + encodeURIComponent(CONFIG.ST_CLIENT_ID) +
    '&response_type=code&scope=' + encodeURIComponent('r:devices:*') +
    '&redirect_uri=' + encodeURIComponent(ScriptApp.getService().getUrl());
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'logDryer') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('logDryer').timeBased().everyMinutes(30).create();
  Logger.log('1) URL de redirección para tu app SmartThings:\n' + ScriptApp.getService().getUrl());
  Logger.log('2) Abre este enlace y autoriza:\n' + url);
}
