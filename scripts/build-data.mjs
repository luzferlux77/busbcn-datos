// Genera los datos estáticos de la app a partir de los GTFS de TMB y AMB.
//   node scripts/build-data.mjs
// Variables opcionales: TMB_APP_ID / TMB_APP_KEY (descarga el GTFS oficial de TMB
// en lugar del espejo público de Mobility Database).
import { unzipSync, strFromU8 } from 'fflate';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// rutas configurables para poder ejecutarlo también en GitHub Actions (repositorio de datos)
const OUT = process.env.OUT_DIR || join(import.meta.dirname, '..', 'public', 'data');
const CACHE = process.env.CACHE_DIR || join(import.meta.dirname, '..', '.cache');

const AMB_GTFS = 'https://www.ambmobilitat.cat/OpenData/google_transit.zip';
// Trambaix y Trambesòs (si la web del TRAM falla, espejo de Mobility Database)
const TRAM_GTFS = [
  ['https://opendata.tram.cat/GTFS/zip/TBX.zip', 'https://files.mobilitydatabase.org/mdb-1003/latest.zip'],
  ['https://opendata.tram.cat/GTFS/zip/TBS.zip', 'https://files.mobilitydatabase.org/mdb-1004/latest.zip'],
];
// Rodalies (núcleo 51 del GTFS de Cercanías de Renfe) y FGC; si la web oficial falla, espejo de Mobility Database
const RENFE_GTFS = ['https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip', 'https://files.mobilitydatabase.org/mdb-2653/latest.zip'];
const FGC_GTFS = ['https://www.fgc.cat/google/google_transit.zip', 'https://files.mobilitydatabase.org/mdb-1856/latest.zip'];
// área metropolitana (de Garraf a Mataró, de Martorell/Terrassa/Sabadell/Granollers al mar)
const METRO_AREA = [41.24, 1.86, 41.66, 2.47];
const TMB_GTFS = process.env.TMB_APP_ID
  ? `https://api.tmb.cat/v1/static/datasets/gtfs.zip?app_id=${process.env.TMB_APP_ID}&app_key=${process.env.TMB_APP_KEY}`
  : 'https://files.mobilitydatabase.org/mdb-2359/latest.zip';

/**
 * Descarga un GTFS. `check(buf)` comprueba que trae lo que necesitamos: a veces una fuente oficial responde bien
 * pero con el fichero incompleto (p. ej. el 05/10/2026 Renfe publicó Cercanías sin ningún tren de Rodalies).
 * Un fichero que no pasa la comprobación cuenta como fallo: se prueba el espejo y, si no, la última copia buena.
 */
async function download(url, name, check = () => true) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file) && !process.argv.includes('--fresh') && check(readFileSync(file))) return readFileSync(file);
  const urls = Array.isArray(url) ? url : [url];
  let err;
  // cada fuente, hasta 3 intentos (los servidores oficiales a veces dan errores pasajeros, p. ej. 502)
  for (const u of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log('Descargando', u.replace(/app_key=[^&]+/, 'app_key=***'), attempt > 1 ? `(intento ${attempt})` : '');
      try {
        const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (BusMet; datos abiertos)' }, signal: AbortSignal.timeout(180000) });
        if (!res.ok) throw new Error(`${u.replace(/app_key=[^&]+/, 'app_key=***')} -> ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`${u} -> no es un zip`);
        if (!check(buf)) {
          err = new Error(`${u} -> fichero incompleto`);
          console.warn('  ', err.message);
          break; // reintentar la misma fuente no sirve: siguiente fuente
        }
        writeFileSync(file, buf);
        return buf;
      } catch (e) {
        err = e;
        console.warn('  ', e.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 10000));
      }
    }
  }
  // todas fallan: mejor la copia de la última vez que dejar a todo el mundo sin datos nuevos
  if (existsSync(file) && check(readFileSync(file))) {
    console.warn(`   ⚠️ Se usa la copia guardada de ${name} (la fuente no responde o viene incompleta)`);
    return readFileSync(file);
  }
  throw err;
}

/** ¿el GTFS de Cercanías trae trenes de Rodalies de Catalunya (núcleo 51)? */
function hasRodalies(buf) {
  try {
    const z = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === 'trips.txt' });
    const t = z['trips.txt'];
    if (!t) return false;
    let n = 0;
    const s = strFromU8(t);
    for (let i = s.indexOf('\n51T'); i >= 0 && n < 100; i = s.indexOf('\n51T', i + 1)) n++;
    return n >= 100;
  } catch {
    return false;
  }
}

// CSV con comillas (RFC 4180 simplificado, sin saltos de línea dentro de campos)
function parseLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** filas de un fichero del GTFS; `pre` descarta líneas sin analizarlas (ficheros enormes como el de Renfe) */
function* rows(zip, name, pre) {
  const raw = zip[name];
  if (!raw) return;
  const text = strFromU8(raw).replace(/^﻿/, '');
  let start = 0, header = null;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (!line) continue;
    if (header && pre && !pre(line)) continue;
    const cols = parseLine(line);
    if (!header) { header = cols.map((h) => h.trim()); continue; }
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = (cols[i] ?? '').trim();
    yield o;
  }
}

// Douglas-Peucker sobre lat/lon
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ay, ax] = pts[a], [by, bx] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = pts[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Google encoded polyline (precisión 5)
function encodePolyline(pts) {
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of pts) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out += enc(la - pLat) + enc(lo - pLon);
    pLat = la; pLon = lo;
  }
  return out;
}

// ---------- ajuste de recorridos a las calles reales ----------
// Algunos recorridos oficiales (sobre todo de AMB) tienen tramos rectos de cientos de metros que
// cruzan manzanas. Se ajustan a la red viaria de OpenStreetMap con Valhalla (perfil «bus»: respeta
// carriles y calles solo bus). El resultado se guarda en .cache/matched para no repetir consultas.
const VALHALLA = 'https://valhalla1.openstreetmap.de/trace_route';
const MATCH_DIR = join(CACHE, 'matched');
const matchStats = { ok: 0, kept: 0, queried: 0, partial: 0 };
let lastQuery = 0;

function needsMatching(pts) {
  for (let i = 1; i < pts.length; i++) if (dist(pts[i - 1], pts[i]) > 120) return true;
  return false;
}

function decodePolyline6(str) {
  const out = [];
  let i = 0, la = 0, lo = 0;
  while (i < str.length) {
    for (const w of [0, 1]) {
      let sh = 0, r = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (w === 0) la += d; else lo += d;
    }
    out.push([la / 1e6, lo / 1e6]);
  }
  return out;
}

/** distancia (m) de un punto a una polilínea, aproximación plana local */
function distToLine(p, line) {
  const kx = 111320 * Math.cos((p[0] * Math.PI) / 180), ky = 110540;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][1] - p[1]) * kx, ay = (line[i - 1][0] - p[0]) * ky;
    const bx = (line[i][1] - p[1]) * kx, by = (line[i][0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const lineLen = (pts) => pts.slice(1).reduce((s, q, i) => s + dist(pts[i], q), 0);

function hashPts(pts) {
  const src = pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(';');
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

/** consulta (con caché) de un trazado a Valhalla; null si hay error de red */
async function valhallaMatch(cacheKey, pts) {
  mkdirSync(MATCH_DIR, { recursive: true });
  const file = join(MATCH_DIR, cacheKey.replace(/[^\w.-]/g, '_') + '.json');
  // huella del recorrido oficial: si la compañía lo cambia (línea alargada, desvío permanente…) se vuelve a ajustar
  const hash = hashPts(pts);
  let res = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (res && !res.src) { res.src = hash; writeFileSync(file, JSON.stringify(res)); } // caché antigua sin huella
  if (res && res.src === hash) return res;
  if (process.argv.includes('--no-match')) return null;
  const wait = 1100 - (Date.now() - lastQuery); // máximo 1 consulta por segundo
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastQuery = Date.now();
  matchStats.queried++;
  try {
    const r = await fetch(VALHALLA, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'BusBCN-build/1.0 (app personal; ajuste puntual de recorridos de bus)' },
      body: JSON.stringify({ shape: pts.map(([lat, lon]) => ({ lat, lon })), costing: 'bus', shape_match: 'map_snap', directions_type: 'none' }),
    });
    const j = await r.json();
    res = r.ok && j.trip ? { src: hash, pts: j.trip.legs.flatMap((l) => decodePolyline6(l.shape)) } : { src: hash, fail: j.error || r.status };
  } catch {
    return null; // error de red: no se guarda, se reintentará en la próxima generación
  }
  writeFileSync(file, JSON.stringify(res));
  if (matchStats.queried % 25 === 0) console.log(`  …${matchStats.queried} consultas de ajuste`);
  return res;
}

/** ¿el trazado ajustado es fiable? misma longitud aproximada y pegado a los puntos (y paradas) oficiales */
function validMatch(m, pts, stopPts, loose = false) {
  if (!m || m.length < 2) return false;
  const ratio = lineLen(m) / Math.max(1, lineLen(pts));
  if (ratio < (loose ? 0.8 : 0.85) || ratio > (loose ? 1.6 : 1.35)) return false;
  const far = (arr, max) => arr.filter((p) => distToLine(p, m) > max).length / Math.max(1, arr.length);
  if (far(pts, 60) > (loose ? 0.1 : 0.05)) return false;
  if (stopPts.length && far(stopPts, 70) > 0.1) return false;
  return true;
}

async function matchToStreets(key, pts, stopPts) {
  const whole = await valhallaMatch(key, pts);
  if (whole && validMatch(whole.pts, pts, stopPts)) return whole.pts;
  if (!whole) return null;
  // el recorrido completo no se pudo ajustar (p. ej. un tramo en obras que no coincide con el callejero):
  // se ajusta por trozos y solo se conserva el trazado oficial en los trozos que fallan
  const CH = 30;
  const out = [];
  let fixed = 0;
  for (let i = 0; i < pts.length - 1; i += CH) {
    const chunk = pts.slice(i, Math.min(pts.length, i + CH + 1));
    const near = stopPts.filter((sp) => distToLine(sp, chunk) < 80);
    const r = await valhallaMatch(`${key}_c${i}`, chunk);
    const ok = r && validMatch(r.pts, chunk, near, true);
    if (ok) fixed++;
    const seg = ok ? r.pts : chunk;
    out.push(...(out.length ? seg.slice(1) : seg));
  }
  if (!fixed) return null;
  matchStats.partial++;
  return out;
}

/** "25:10:00" → segundos desde la medianoche del día de servicio */
function gtfsSecs(t) {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec((t || '').trim());
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : -1;
}

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * Ventana del calendario de horarios: desde el lunes de esta semana, 9 semanas.
 * (Empieza en lunes para que los ficheros solo cambien una vez por semana y la app descargue menos.)
 */
function calendarWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  base.setDate(base.getDate() - ((base.getDay() + 6) % 7));
  const days = [];
  for (let i = 0; i < 63; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    days.push(d);
  }
  return { base: ymd(base), days };
}

/** días activos de cada servicio dentro de la ventana, como cadena de 0/1 */
function serviceMasks(zip, win) {
  const cal = new Map();
  for (const c of rows(zip, 'calendar.txt')) cal.set(c.service_id, c);
  const exc = new Map();
  for (const c of rows(zip, 'calendar_dates.txt')) {
    if (!exc.has(c.service_id)) exc.set(c.service_id, new Map());
    exc.get(c.service_id).set(c.date, c.exception_type);
  }
  const ids = new Set([...cal.keys(), ...exc.keys()]);
  const wd = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const out = new Map();
  for (const id of ids) {
    const c = cal.get(id), e = exc.get(id);
    let mask = '';
    for (const d of win.days) {
      const k = ymd(d);
      let on = !!c && c[wd[d.getDay()]] === '1' && k >= c.start_date && k <= c.end_date;
      const x = e?.get(k);
      if (x === '1') on = true;
      if (x === '2') on = false;
      mask += on ? '1' : '0';
    }
    if (mask.includes('1')) out.set(id, mask);
  }
  return out;
}

/** huella corta de un texto (para saber qué ficheros han cambiado) */
function shortHash(text) {
  let h1 = 2166136261, h2 = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) ^ c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function dist(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const r5 = (n) => Math.round(n * 1e5) / 1e5;

const BUS_TYPES = new Set(['3', '700']);

/**
 * Procesa un GTFS y devuelve líneas, paradas y patrones de un modo de transporte.
 * - bus: paradas por código público (se fusionan TMB y AMB);
 * - metro / tranvía: los andenes se agrupan en su estación (clave con prefijo para no chocar con el bus).
 */
/**
 * Opciones de trenes (Rodalies, FGC):
 * - groupShort: una línea por nombre corto (Renfe publica una ruta por sentido y variante);
 * - bbox: solo las estaciones del área metropolitana (los recorridos se recortan);
 * - sig: un patrón por secuencia de estaciones (semidirectos, trenes cortos…), con su cabecera real;
 * - pre: filtros rápidos de líneas de trips.txt / stop_times.txt (el GTFS de Renfe es de toda España).
 */
function processFeed(zip, op, opt = {}) {
  const { mode = 'bus', P = op === 'tmb' ? 't:' : 'a:', types = BUS_TYPES, keyPrefix = '', bit = op === 'tmb' ? 1 : 2, match = mode === 'bus', defColor = op === 'tmb' ? 'D7282F' : 'FFAA00' } = opt;
  const { routeFilter, groupShort = false, codeOf = (id) => id.replace(/^\D+/, ''), bbox, sig = false, pre = {}, tripIds = false } = opt;
  const inArea = (lat, lon) => !bbox || (lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]);
  const routes = new Map();
  const canon = new Map(); // route_id -> id de la línea
  for (const r of rows(zip, 'routes.txt')) {
    if (!types.has(r.route_type)) continue;
    if (routeFilter && !routeFilter(r)) continue;
    const rid = groupShort ? r.route_short_name || r.route_id : r.route_id;
    canon.set(r.route_id, rid);
    if (routes.has(rid)) continue;
    routes.set(rid, {
      id: P + rid,
      op,
      short: r.route_short_name || r.route_id,
      long: (r.route_long_name || '').replace(/\s*-\s*/g, ' - ').replace(/\s{2,}/g, ' '),
      color: (r.route_color || defColor).toUpperCase(),
      mode: r.route_type === '7' ? 'funi' : mode,
      text: (r.route_text_color || 'FFFFFF').toUpperCase(),
      url: (r.route_url || '').trim(),
    });
  }

  const stopsById = new Map();
  const stations = [];
  const parents = new Map();
  const allStops = [...rows(zip, 'stops.txt')];
  for (const s of allStops) if (s.location_type === '1') parents.set(s.stop_id, s);
  for (const s of allStops) {
    if (s.location_type === '1') stations.push([s.stop_name, r5(+s.stop_lat), r5(+s.stop_lon)]);
    if (s.location_type && s.location_type !== '0') continue;
    if (mode === 'bus') {
      const code = (s.stop_code || s.stop_id).replace(/^0+(?=\d)/, '');
      stopsById.set(s.stop_id, { code, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon });
    } else {
      // andén → estación: «M» + código (metro), «T» (tranvía), «R» (Rodalies), «F» (FGC)
      const par = parents.get(s.parent_station) || s;
      const code = keyPrefix + codeOf(par.stop_code || par.stop_id);
      const lat = +par.stop_lat, lon = +par.stop_lon;
      stopsById.set(s.stop_id, { code, name: par.stop_name, lat, lon, platform: s.stop_code || '', out: !inArea(lat, lon) });
    }
  }

  // viajes: patrón = (ruta, sentido, shape, cabecera)
  const trips = new Map();
  const tripSvc = new Map(); // trip_id -> service_id
  const tripStart = new Map(); // trip_id -> [secuencia, segundos] de la primera parada
  const patternCount = new Map();
  for (const t of rows(zip, 'trips.txt', pre.trips)) {
    const rid = canon.get(t.route_id);
    if (rid === undefined) continue;
    if (trips.has(t.trip_id)) continue; // AMB duplica algunos trip_id con route_id compuestos
    const key = `${rid}|${t.direction_id || '0'}|${t.shape_id}|${t.trip_headsign}`;
    trips.set(t.trip_id, key);
    tripSvc.set(t.trip_id, t.service_id);
    const pc = patternCount.get(key) || { n: 0, trip: t.trip_id, route: rid, dir: +(t.direction_id || 0), shape: t.shape_id, head: t.trip_headsign };
    pc.n++;
    patternCount.set(key, pc);
  }

  // Patrón principal por (ruta, sentido) + guardamos el resto para mapear tiempo real
  const repTrips = new Map(); // trip_id -> pattern key
  for (const [key, pc] of patternCount) repTrips.set(pc.trip, key);

  const stopRoutes = new Map(); // stop_id -> Set(route_id)
  const patternStops = new Map(); // key -> [stop_id...]
  const tripAll = sig ? new Map() : null; // trip_id -> todas sus paradas (también fuera del área)
  for (const st of rows(zip, 'stop_times.txt', pre.stop_times)) {
    const key = trips.get(st.trip_id);
    if (!key) continue;
    const seq = +st.stop_sequence;
    const secs = gtfsSecs(st.departure_time || st.arrival_time);
    if (tripAll) {
      let a = tripAll.get(st.trip_id);
      if (!a) tripAll.set(st.trip_id, (a = []));
      a.push([seq, st.stop_id, secs]);
    }
    if (stopsById.get(st.stop_id)?.out) continue; // fuera del área metropolitana
    const route = key.slice(0, key.indexOf('|'));
    let set = stopRoutes.get(st.stop_id);
    if (!set) stopRoutes.set(st.stop_id, (set = new Set()));
    set.add(route);
    const first = tripStart.get(st.trip_id);
    if (secs >= 0 && (!first || seq < first[0])) tripStart.set(st.trip_id, [seq, secs]);
    if (!tripAll && repTrips.get(st.trip_id) === key) {
      let arr = patternStops.get(key);
      if (!arr) patternStops.set(key, (arr = []));
      arr.push([seq, st.stop_id, secs]);
    }
  }

  // trenes: un patrón por secuencia de estaciones dentro del área; cabecera = destino real del tren
  if (tripAll) {
    patternCount.clear();
    patternStops.clear();
    stopRoutes.clear();
    for (const [tid, base] of [...trips]) {
      const arr = (tripAll.get(tid) || []).sort((a, b) => a[0] - b[0]);
      const inb = arr.filter(([, id]) => stopsById.has(id) && !stopsById.get(id).out);
      if (inb.length < 2) {
        trips.delete(tid);
        continue;
      }
      const key = `${base}|${inb.map(([, id]) => stopsById.get(id).code).join(',')}`;
      trips.set(tid, key);
      let pc = patternCount.get(key);
      if (!pc) {
        const [route, dir, shape, head] = base.split('|');
        pc = { n: 0, trip: tid, route, dir: +dir, shape, head: head || stopsById.get(arr.at(-1)[1])?.name || '' };
        patternCount.set(key, pc);
        patternStops.set(key, inb);
      }
      pc.n++;
      for (const [, id] of inb) {
        if (!stopRoutes.has(id)) stopRoutes.set(id, new Set());
        stopRoutes.get(id).add(pc.route);
      }
    }
    // líneas que no llegan al área (p. ej. la R3 de Vic a Puigcerdà)
    const used = new Set([...patternCount.values()].map((pc) => pc.route));
    for (const rid of [...routes.keys()]) if (!used.has(rid)) routes.delete(rid);
  }

  const shapes = new Map();
  for (const s of rows(zip, 'shapes.txt')) {
    let arr = shapes.get(s.shape_id);
    if (!arr) shapes.set(s.shape_id, (arr = []));
    arr.push([+s.shape_pt_sequence, +s.shape_pt_lat, +s.shape_pt_lon]);
  }

  // el TRAM no publica sentido ni destino de los viajes: destino = última parada; sentido = según destino
  if (mode !== 'bus') {
    const byRoute = new Map();
    for (const [key, pc] of patternCount) {
      const seq = (patternStops.get(key) || []).sort((a, b) => a[0] - b[0]);
      const last = stopsById.get(seq.at(-1)?.[1]);
      if (!pc.head && last) pc.head = last.name;
      pc.seq = seq.map(([, id]) => stopsById.get(id)).filter(Boolean);
      if (!byRoute.has(pc.route)) byRoute.set(pc.route, []);
      byRoute.get(pc.route).push(pc);
    }
    for (const pcs of byRoute.values()) {
      if (pcs.some((p) => p.dir)) continue; // ya trae sentido (metro TMB)
      // sentido según el orden de las estaciones respecto al recorrido más frecuente
      // (con varios destinos —trenes cortos, ramales— no basta con mirar la cabecera)
      const ref = pcs.reduce((a, b) => (b.n > a.n ? b : a));
      const pos = new Map(ref.seq.map((s, i) => [s.code, i]));
      const vec = (q) => (q.length > 1 ? [q.at(-1).lat - q[0].lat, q.at(-1).lon - q[0].lon] : [0, 0]);
      const rv = vec(ref.seq);
      for (const p of pcs) {
        const idx = p.seq.map((s) => pos.get(s.code)).filter((x) => x !== undefined);
        let up = 0, down = 0;
        for (let i = 1; i < idx.length; i++) {
          if (idx[i] > idx[i - 1]) up++;
          else if (idx[i] < idx[i - 1]) down++;
        }
        const pv = vec(p.seq);
        p.dir = up !== down ? (up > down ? 0 : 1) : pv[0] * rv[0] + pv[1] * rv[1] >= 0 ? 0 : 1;
      }
    }
  }
  // frecuencias (algunas líneas de metro): salidas cada X segundos entre dos horas
  const freq = new Map();
  for (const r of rows(zip, 'frequencies.txt')) {
    if (!freq.has(r.trip_id)) freq.set(r.trip_id, []);
    freq.get(r.trip_id).push([gtfsSecs(r.start_time), gtfsSecs(r.end_time), +r.headway_secs]);
  }
  return { op, mode, P, bit, match, sig, bbox, tripIds, stations, routes, stopsById, trips, tripSvc, tripStart, freq, patternCount, patternStops, stopRoutes, shapes, svcMasks: serviceMasks(zip, CAL) };
}

const CAL = calendarWindow();

/**
 * Recorta la vía de un tren entre su primera y su última estación (dentro del área) y la orienta
 * en el sentido de la marcha (Renfe usa a veces la misma vía para los dos sentidos).
 * null si la vía publicada no pasa cerca de las estaciones.
 */
function clipShape(pts, stopPts) {
  const near = (p, from = 0) => {
    let bi = from, bd = Infinity;
    for (let i = from; i < pts.length; i++) {
      const d = dist(pts[i], p);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const a = stopPts[0], b = stopPts.at(-1);
  if (near(b) < near(a)) pts = pts.slice().reverse();
  const ia = near(a), ib = near(b, ia);
  if (ib - ia < 1) return null;
  const out = pts.slice(ia, ib + 1);
  if (stopPts.some((p) => distToLine(p, out) > 400)) return null;
  return out;
}

async function main() {
  const [ambZip, tmbZip, renfeZip, fgcZip, ...tramZips] = await Promise.all([
    download(AMB_GTFS, 'amb.zip'),
    download(TMB_GTFS, 'tmb.zip'),
    download(RENFE_GTFS, 'renfe.zip', hasRodalies),
    download(FGC_GTFS, 'fgc.zip'),
    ...TRAM_GTFS.map((u, i) => download(u, `tram${i}.zip`)),
  ]);
  console.log('Procesando TMB…');
  const tmbZ = unzipSync(new Uint8Array(tmbZip));
  const tmb = processFeed(tmbZ, 'tmb');
  console.log('Procesando metro…');
  const metro = processFeed(tmbZ, 'tmb', { mode: 'metro', P: 'm:', types: new Set(['1', '7']), keyPrefix: 'M', bit: 4 });
  console.log('Procesando AMB…');
  const amb = processFeed(unzipSync(new Uint8Array(ambZip)), 'amb');
  console.log('Procesando TRAM…');
  const trams = tramZips.map((z, i) => processFeed(unzipSync(new Uint8Array(z)), 'tram', { mode: 'tram', P: `r${i}:`, types: new Set(['0', '2', '900']), keyPrefix: 'T', bit: 8, defColor: '008080' }));
  console.log('Procesando Rodalies…');
  const GTFS_FILES = /^(agency|routes|trips|stops|stop_times|calendar|calendar_dates|shapes|frequencies).txt$/;
  const rodalies = processFeed(unzipSync(new Uint8Array(renfeZip), { filter: (f) => GTFS_FILES.test(f.name) }), 'renfe', {
    mode: 'rodalies', P: 'rod:', types: new Set(['2']), keyPrefix: 'R', bit: 16, defColor: 'E2231A', match: false,
    routeFilter: (r) => r.route_id.startsWith('51T'), // núcleo 51 = Rodalies de Catalunya
    groupShort: true, codeOf: (id) => id.replace(/^0+(?=d)/, ''), bbox: METRO_AREA, sig: true,
    pre: { trips: (l) => l.startsWith('51T'), stop_times: (l) => l.startsWith('51') },
  });
  console.log('Procesando FGC…');
  const fgc = processFeed(unzipSync(new Uint8Array(fgcZip), { filter: (f) => GTFS_FILES.test(f.name) }), 'fgc', {
    mode: 'fgc', P: 'fgc:', types: new Set(['1', '2', '7']), keyPrefix: 'F', bit: 32, defColor: 'F26F21', match: false,
    codeOf: (id) => id, bbox: METRO_AREA, sig: true, tripIds: true,
  });
  const FEEDS = [tmb, amb, metro, ...trams, rodalies, fgc];

  // --- Líneas ---
  const lines = [];
  const lineIdx = new Map();
  for (const feed of FEEDS) {
    for (const r of feed.routes.values()) {
      lineIdx.set(r.id, lines.length);
      lines.push(r);
    }
  }

  // --- Paradas unificadas por código público ---
  const stops = new Map(); // key -> {code, name, lat, lon, ops, lines:Set}
  const ambStopKey = {}; // stop_id AMB -> clave unificada (solo si difiere del número)
  const stationAlias = {}; // estación FGC -> estación de Rodalies con la que se agrupa
  let merged = 0, conflicts = 0;
  for (const feed of FEEDS) {
    const P = feed.P;
    for (const [stopId, s] of feed.stopsById) {
      const rs = feed.stopRoutes.get(stopId);
      if (!rs || !rs.size || s.out) continue; // parada sin servicio o fuera del área
      let key = stationAlias[s.code] ?? s.code;
      // estación compartida de Rodalies y FGC (Pl. Catalunya, Terrassa Nord, Sabadell Nord…): una sola parada
      if (feed.op === 'fgc' && !stationAlias[s.code] && !stops.has(key)) {
        let twin = null, best = 300;
        for (const st of stops.values()) {
          if (!(st.ops & 16)) continue;
          const d = dist([st.lat, st.lon], [s.lat, s.lon]);
          if (d < best) { best = d; twin = st; }
        }
        if (twin) key = stationAlias[s.code] = twin.code;
      }
      const prev = stops.get(key);
      if (feed.mode === 'bus' && prev && prev.ops !== feed.bit) {
        if (dist([prev.lat, prev.lon], [s.lat, s.lon]) > 150) { key = `${feed.op}-${s.code}`; conflicts++; }
        else if (!(prev.ops & feed.bit)) merged++;
      }
      let st = stops.get(key);
      if (!st) stops.set(key, (st = { code: key, name: s.name, lat: s.lat, lon: s.lon, ops: 0, lines: new Set(), platforms: new Set() }));
      st.ops |= feed.bit;
      if (feed.mode === 'metro' && s.platform) st.platforms.add(+s.platform);
      for (const r of rs) st.lines.add(lineIdx.get(P + r));
      if (feed.op === 'amb' && String(+stopId) !== key) ambStopKey[stopId] = key;
    }
  }
  console.log(`Paradas: ${stops.size} (fusionadas TMB+AMB: ${merged}, conflictos de código: ${conflicts}; estaciones Rodalies+FGC: ${Object.keys(stationAlias).length})`);

  const stopIdToKey = (feed, id) => {
    const s = feed.stopsById.get(id);
    if (!s) return null;
    if (feed.op === 'amb' && ambStopKey[id]) return ambStopKey[id];
    if (stationAlias[s.code]) return stationAlias[s.code];
    if (stops.has(s.code)) return s.code;
    if (feed.mode !== 'bus') return null;
    return stops.has(`${feed.op}-${s.code}`) ? `${feed.op}-${s.code}` : null;
  };

  // --- Patrones por línea (ficheros individuales, carga perezosa) ---
  rmSync(join(OUT, 'lines'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'lines'), { recursive: true });
  const ambPatterns = {}; // prefijo trip_id AMB (4 segmentos) -> [lineIdx, patternIdx]
  let shapeBytes = 0;
  const fileHashes = {}; // fichero de línea -> huella
  const rail = []; // trazado de metro y tranvía para dibujar la red completa en el mapa
  for (const feed of FEEDS) {
    const P = feed.P;
    const byRoute = new Map();
    for (const [key, pc] of feed.patternCount) {
      if (!byRoute.has(pc.route)) byRoute.set(pc.route, []);
      byRoute.get(pc.route).push({ key, ...pc });
    }
    for (const [routeId, pats] of byRoute) {
      // ordenar: sentido, luego más frecuente primero
      pats.sort((a, b) => a.dir - b.dir || b.n - a.n);
      // descartar variantes muy minoritarias (<5% de los viajes del sentido), salvo la principal
      const totalByDir = {};
      for (const p of pats) totalByDir[p.dir] = (totalByDir[p.dir] || 0) + p.n;
      const out = [];
      const keyToIdx = new Map();
      for (const p of pats) {
        const isMain = !out.some((o) => o.d === p.dir);
        if (!isMain && !feed.sig && p.n / totalByDir[p.dir] < 0.05) continue;
        const seq = (feed.patternStops.get(p.key) || []).sort((a, b) => a[0] - b[0]);
        const withKeys = seq.map(([, id, secs]) => [stopIdToKey(feed, id), secs]).filter(([k]) => k);
        const stopKeys = withKeys.map(([k]) => k);
        const t0 = withKeys.find(([, x]) => x >= 0)?.[1] ?? 0;
        // minutos desde la salida hasta cada parada (del viaje tipo)
        const raw = withKeys.map(([, x]) => (x >= 0 ? (x - t0) / 60 : -1));
        // TMB solo publica la hora en algunas paradas: el resto se interpola según la distancia recorrida
        const cumd = [0];
        for (let i = 1; i < stopKeys.length; i++) {
          const a = stops.get(stopKeys[i - 1]), b = stops.get(stopKeys[i]);
          cumd.push(cumd[i - 1] + dist([a.lat, a.lon], [b.lat, b.lon]));
        }
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] >= 0) continue;
          let a = i - 1, b = i + 1;
          while (a >= 0 && raw[a] < 0) a--;
          while (b < raw.length && raw[b] < 0) b++;
          if (a >= 0 && b < raw.length) raw[i] = raw[a] + ((raw[b] - raw[a]) * (cumd[i] - cumd[a])) / Math.max(1, cumd[b] - cumd[a]);
          else if (a >= 0) raw[i] = raw[a] + (cumd[i] - cumd[a]) / 200; // ~200 m/min
          else raw[i] = 0;
        }
        const offsets = raw.map((x) => Math.round(x));
        if (stopKeys.length < 2) continue;
        let poly = '';
        const sh = feed.shapes.get(p.shape);
        if (sh) {
          sh.sort((a, b) => a[0] - b[0]);
          let pts = sh.map(([, la, lo]) => [la, lo]);
          if (feed.sig) pts = clipShape(pts, stopKeys.map((k) => [stops.get(k).lat, stops.get(k).lon])) ?? stopKeys.map((k) => [stops.get(k).lat, stops.get(k).lon]);
          if (feed.match && needsMatching(pts)) {
            const matched = await matchToStreets(`${feed.op}_${p.shape}`, pts, stopKeys.map((k) => [stops.get(k).lat, stops.get(k).lon]));
            if (matched) { pts = matched; matchStats.ok++; } else matchStats.kept++;
          }
          poly = encodePolyline(simplify(pts, 0.00002));
        } else {
          poly = encodePolyline(stopKeys.map((k) => [stops.get(k).lat, stops.get(k).lon]));
        }
        shapeBytes += poly.length;
        keyToIdx.set(p.key, out.length);
        out.push({ d: p.dir, h: p.head, m: isMain ? 1 : 0, n: p.n, s: stopKeys, p: poly, o: offsets });
      }
      const li = lineIdx.get(P + routeId);
      lines[li].heads = out.map((o) => o.h);
      if (feed.mode !== 'bus') {
        // red completa: recorridos principales y, en los trenes, también los ramales con estaciones propias
        const covered = new Set();
        for (const o of [...out.filter((x) => x.m), ...out.filter((x) => !x.m)]) {
          if (!o.m && (!feed.sig || o.s.every((k) => covered.has(k)))) continue;
          rail.push([li, o.p]);
          o.s.forEach((k) => covered.add(k));
        }
      }
      // horarios: salidas de cada viaje agrupadas por servicio (minutos, en diferencias) y días activos
      const svcIdx = new Map();
      const byPat = out.map(() => new Map());
      for (const [tripId, key] of feed.trips) {
        if (!key.startsWith(routeId + '|')) continue;
        const sid = feed.tripSvc.get(tripId);
        const start = feed.tripStart.get(tripId);
        if (!sid || !start || !feed.svcMasks.has(sid)) continue;
        let pi = keyToIdx.get(key);
        if (pi === undefined) pi = out.findIndex((o) => o.d === +key.split('|')[1]);
        if (pi < 0) continue;
        if (!svcIdx.has(sid)) svcIdx.set(sid, svcIdx.size);
        const si = svcIdx.get(sid);
        if (!byPat[pi].has(si)) byPat[pi].set(si, []);
        const fq = feed.freq.get(tripId);
        if (fq) for (const [a, b, h] of fq) for (let t = a; t < b && h > 0; t += h) byPat[pi].get(si).push([Math.round(t / 60), '']);
        else byPat[pi].get(si).push([Math.round(start[1] / 60), tripId]);
      }
      out.forEach((o, pi) => {
        const groups = [...byPat[pi]].map(([si, trips]) => [si, trips.sort((a, b) => a[0] - b[0])]);
        o.t = groups.map(([si, trips]) => [si, ...trips.map(([m], i) => (i ? m - trips[i - 1][0] : m))]);
        // FGC: identificador de cada viaje (última parte del trip_id), para quitar los cancelados en tiempo real
        if (feed.tripIds) o.ti = groups.map(([, trips]) => trips.map(([, id]) => id.split('|').pop()));
      });
      const lineJson = JSON.stringify({ id: P + routeId, patterns: out, cal: { base: CAL.base, svc: [...svcIdx.keys()].map((sid) => feed.svcMasks.get(sid)) } });
      const lineName = `${P.replace(':', '_')}${routeId.replace(/[^\w.-]/g, '_')}.json`;
      writeFileSync(join(OUT, 'lines', lineName), lineJson);
      fileHashes[lineName] = shortHash(lineJson);

      if (feed.op === 'amb' && feed.mode === 'bus') {
        // mapear cada trip_id (sin el último segmento) a su patrón
        for (const [tripId, key] of feed.trips) {
          if (!key.startsWith(routeId + '|')) continue;
          let pi = keyToIdx.get(key);
          if (pi === undefined) {
            // variante descartada: usar la principal del mismo sentido
            const dir = +key.split('|')[1];
            pi = out.findIndex((o) => o.d === dir);
          }
          if (pi < 0) continue;
          const prefix = tripId.split('.').slice(0, 4).join('.');
          ambPatterns[prefix] = [li, pi];
        }
      }
    }
  }
  console.log(`Recorridos: ${Math.round(shapeBytes / 1024)} KB codificados · ajustados a calles: ${matchStats.ok} (${matchStats.partial} por tramos) · se mantiene el oficial en ${matchStats.kept}`);

  // --- Fichero principal ---
  const stopList = [...stops.values()].map((s) => {
    const row = [s.code, s.name, r5(s.lat), r5(s.lon), s.ops, [...s.lines].filter((x) => x !== undefined).sort((a, b) => a - b)];
    if (s.platforms.size) row.push([...s.platforms].sort((a, b) => a - b)); // andenes de metro (códigos iMetro)
    return row;
  });
  const index = {
    v: 1,
    generated: new Date().toISOString(),
    lines: lines.map((l) => [l.id, l.op, l.short, l.long, l.color, l.text, l.url, l.heads || [], l.mode || 'bus']),
    rail,
    stops: stopList,
    ambStopKey,
    ambPatterns,
    stationAlias,
    // estaciones de metro/funicular de TMB como lugares buscables
    places: [], // las estaciones de metro ya son paradas buscables
    files: fileHashes,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'network.json'), JSON.stringify(index));
  await buildPlaces();
  // la app consulta este fichero diminuto para saber si hay una red más nueva que la suya
  // huella del contenido (sin la fecha): si no cambia, las apps no descargan nada
  const { generated: _g, ...content } = index;
  writeFileSync(join(OUT, 'version.json'), JSON.stringify({ generated: index.generated, hash: shortHash(JSON.stringify(content)), lines: lines.length, stops: stopList.length }));
  console.log(`Líneas: ${lines.length}. network.json: ${Math.round(JSON.stringify(index).length / 1024)} KB`);
}

// ---------- lugares de interés (OpenStreetMap) para el buscador ----------
// Monumentos, museos, hospitales, universidades, centros comerciales, estadios, playas, parques, mercados,
// teatros, hoteles, terminales del aeropuerto… de todo el área metropolitana. Si Overpass no responde,
// se usa la copia de la última vez (la búsqueda de lugares nunca se queda vacía).
const POI_BBOX = '41.20,1.80,41.70,2.55';
const POI_QUERY = `[out:json][timeout:240];
(
  nwr["tourism"~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|aquarium|hotel|hostel)$"]["name"](${POI_BBOX});
  nwr["amenity"~"^(hospital|clinic|university|college|theatre|cinema|library|townhall|marketplace|arts_centre|conference_centre|exhibition_centre|bus_station|courthouse|place_of_worship|events_venue|music_venue|nightclub)$"]["name"](${POI_BBOX});
  nwr["leisure"~"^(stadium|park|sports_centre|water_park|marina|garden|beach_resort)$"]["name"](${POI_BBOX});
  nwr["natural"="beach"]["name"](${POI_BBOX});
  nwr["shop"~"^(mall|department_store)$"]["name"](${POI_BBOX});
  nwr["aeroway"="terminal"]["name"](${POI_BBOX});
  nwr["historic"~"^(monument|castle|archaeological_site|memorial)$"]["name"]["wikidata"](${POI_BBOX});
  nwr["building"~"^(stadium|cathedral|university|hospital|train_station)$"]["name"](${POI_BBOX});
);
out center tags;`;

// categoría (una letra) → la app pone el icono
function poiCat(t) {
  if (t.aeroway) return 'a';
  if (t.amenity === 'hospital' || t.amenity === 'clinic' || t.building === 'hospital') return 'h';
  if (t.amenity === 'university' || t.amenity === 'college' || t.building === 'university') return 'u';
  if (t.shop) return 's';
  if (t.leisure === 'stadium' || t.building === 'stadium' || t.leisure === 'sports_centre') return 'd';
  if (t.natural === 'beach' || t.leisure === 'beach_resort') return 'b';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'p';
  if (t.tourism === 'hotel' || t.tourism === 'hostel') return 'z';
  if (t.tourism === 'museum' || t.tourism === 'gallery' || t.amenity === 'arts_centre') return 'm';
  if (t.amenity === 'theatre' || t.amenity === 'cinema' || t.amenity === 'music_venue' || t.amenity === 'events_venue' || t.amenity === 'nightclub') return 't';
  if (t.amenity === 'marketplace') return 'k';
  if (t.amenity === 'place_of_worship' || t.building === 'cathedral') return 'w';
  if (t.amenity === 'townhall' || t.amenity === 'courthouse') return 'g';
  if (t.amenity === 'library') return 'l';
  if (t.amenity === 'bus_station' || t.building === 'train_station') return 'e';
  return 'x'; // monumento, atracción, mirador…
}

async function buildPlaces() {
  const cacheFile = join(CACHE, 'pois.json');
  let raw = null;
  for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try {
      console.log('Descargando lugares de interés de', url);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(POI_QUERY), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'BusMet/2 (datos abiertos)' }, signal: AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      raw = await r.json();
      if (!raw.elements?.length) throw new Error('vacío');
      writeFileSync(cacheFile, JSON.stringify(raw));
      break;
    } catch (e) {
      console.warn('   ', e.message);
    }
  }
  if (!raw && existsSync(cacheFile)) {
    console.warn('   ⚠️ Se usan los lugares de la última vez');
    raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
  }
  if (!raw) {
    // último recurso: la copia que sube cada versión de la app (seed/places.json en el repositorio de datos)
    const seed = join(import.meta.dirname, '..', 'seed', 'places.json');
    if (existsSync(seed)) {
      console.warn('   ⚠️ Se usan los lugares de la última versión publicada');
      writeFileSync(join(OUT, 'places.json'), readFileSync(seed));
    } else console.warn('   Sin lugares de interés');
    return;
  }
  const seen = new Map();
  for (const e of raw.elements) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || !t.name) continue;
    const name = t.name.trim();
    const key = name.toLowerCase() + '|' + lat.toFixed(3) + ',' + lon.toFixed(3);
    if (seen.has(key)) continue;
    // otros nombres por los que se busca (castellano, inglés, nombre corto u oficial)
    const alias = [...new Set([t['name:es'], t['name:en'], t['name:ca'], t.alt_name, t.short_name, t.official_name].filter((x) => x && x !== name))].join('|');
    const town = t['addr:city'] || '';
    const row = [name, r5(lat), r5(lon), poiCat(t)];
    if (alias || town) row.push(alias);
    if (town) row.push(town);
    seen.set(key, row);
  }
  const places = [...seen.values()];
  writeFileSync(join(OUT, 'places.json'), JSON.stringify({ generated: new Date().toISOString(), places }));
  console.log(`Lugares de interés: ${places.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
