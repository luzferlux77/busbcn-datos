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
const TMB_GTFS = process.env.TMB_APP_ID
  ? `https://api.tmb.cat/v1/static/datasets/gtfs.zip?app_id=${process.env.TMB_APP_ID}&app_key=${process.env.TMB_APP_KEY}`
  : 'https://files.mobilitydatabase.org/mdb-2359/latest.zip';

async function download(url, name) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file) && !process.argv.includes('--fresh')) return readFileSync(file);
  console.log('Descargando', url.replace(/app_key=[^&]+/, 'app_key=***'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
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

function* rows(zip, name) {
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

/**
 * Procesa un GTFS y devuelve líneas de bus, paradas (por código público) y patrones.
 * op: 'tmb' | 'amb'
 */
function processFeed(zip, op) {
  const P = op === 'tmb' ? 't:' : 'a:';
  const routes = new Map();
  for (const r of rows(zip, 'routes.txt')) {
    if (r.route_type !== '3' && r.route_type !== '700') continue; // solo autobús
    routes.set(r.route_id, {
      id: P + r.route_id,
      op,
      short: r.route_short_name || r.route_id,
      long: r.route_long_name || '',
      color: (r.route_color || (op === 'tmb' ? 'D7282F' : 'FFAA00')).toUpperCase(),
      text: (r.route_text_color || 'FFFFFF').toUpperCase(),
      url: (r.route_url || '').trim(),
    });
  }

  const stopsById = new Map();
  const stations = [];
  for (const s of rows(zip, 'stops.txt')) {
    if (s.location_type === '1') stations.push([s.stop_name, r5(+s.stop_lat), r5(+s.stop_lon)]);
    if (s.location_type && s.location_type !== '0') continue;
    const code = (s.stop_code || s.stop_id).replace(/^0+(?=\d)/, '');
    stopsById.set(s.stop_id, { code, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon });
  }

  // viajes: patrón = (ruta, sentido, shape, cabecera)
  const trips = new Map();
  const tripSvc = new Map(); // trip_id -> service_id
  const tripStart = new Map(); // trip_id -> [secuencia, segundos] de la primera parada
  const patternCount = new Map();
  for (const t of rows(zip, 'trips.txt')) {
    if (!routes.has(t.route_id)) continue;
    if (trips.has(t.trip_id)) continue; // AMB duplica algunos trip_id con route_id compuestos
    const key = `${t.route_id}|${t.direction_id || '0'}|${t.shape_id}|${t.trip_headsign}`;
    trips.set(t.trip_id, key);
    tripSvc.set(t.trip_id, t.service_id);
    const pc = patternCount.get(key) || { n: 0, trip: t.trip_id, route: t.route_id, dir: +(t.direction_id || 0), shape: t.shape_id, head: t.trip_headsign };
    pc.n++;
    patternCount.set(key, pc);
  }

  // Patrón principal por (ruta, sentido) + guardamos el resto para mapear tiempo real
  const repTrips = new Map(); // trip_id -> pattern key
  for (const [key, pc] of patternCount) repTrips.set(pc.trip, key);

  const stopRoutes = new Map(); // stop_id -> Set(route_id)
  const patternStops = new Map(); // key -> [stop_id...]
  for (const st of rows(zip, 'stop_times.txt')) {
    const key = trips.get(st.trip_id);
    if (!key) continue;
    const route = key.slice(0, key.indexOf('|'));
    let set = stopRoutes.get(st.stop_id);
    if (!set) stopRoutes.set(st.stop_id, (set = new Set()));
    set.add(route);
    const seq = +st.stop_sequence;
    const secs = gtfsSecs(st.departure_time || st.arrival_time);
    const first = tripStart.get(st.trip_id);
    if (secs >= 0 && (!first || seq < first[0])) tripStart.set(st.trip_id, [seq, secs]);
    if (repTrips.get(st.trip_id) === key) {
      let arr = patternStops.get(key);
      if (!arr) patternStops.set(key, (arr = []));
      arr.push([seq, st.stop_id, secs]);
    }
  }

  const shapes = new Map();
  for (const s of rows(zip, 'shapes.txt')) {
    let arr = shapes.get(s.shape_id);
    if (!arr) shapes.set(s.shape_id, (arr = []));
    arr.push([+s.shape_pt_sequence, +s.shape_pt_lat, +s.shape_pt_lon]);
  }

  return { op, stations, routes, stopsById, trips, tripSvc, tripStart, patternCount, patternStops, stopRoutes, shapes, svcMasks: serviceMasks(zip, CAL) };
}

const CAL = calendarWindow();

async function main() {
  const [ambZip, tmbZip] = await Promise.all([download(AMB_GTFS, 'amb.zip'), download(TMB_GTFS, 'tmb.zip')]);
  console.log('Procesando TMB…');
  const tmb = processFeed(unzipSync(new Uint8Array(tmbZip)), 'tmb');
  console.log('Procesando AMB…');
  const amb = processFeed(unzipSync(new Uint8Array(ambZip)), 'amb');

  // --- Líneas ---
  const lines = [];
  const lineIdx = new Map();
  for (const feed of [tmb, amb]) {
    for (const r of feed.routes.values()) {
      lineIdx.set(r.id, lines.length);
      lines.push(r);
    }
  }

  // --- Paradas unificadas por código público ---
  const stops = new Map(); // key -> {code, name, lat, lon, ops, lines:Set}
  const ambStopKey = {}; // stop_id AMB -> clave unificada (solo si difiere del número)
  let merged = 0, conflicts = 0;
  for (const feed of [tmb, amb]) {
    const P = feed.op === 'tmb' ? 't:' : 'a:';
    for (const [stopId, s] of feed.stopsById) {
      const rs = feed.stopRoutes.get(stopId);
      if (!rs || !rs.size) continue; // parada sin servicio de bus
      let key = s.code;
      const prev = stops.get(key);
      if (prev && prev.ops !== (feed.op === 'tmb' ? 1 : 2)) {
        if (dist([prev.lat, prev.lon], [s.lat, s.lon]) > 150) { key = `${feed.op}-${s.code}`; conflicts++; }
        else if (!(prev.ops & (feed.op === 'tmb' ? 1 : 2))) merged++;
      }
      let st = stops.get(key);
      if (!st) stops.set(key, (st = { code: key, name: s.name, lat: s.lat, lon: s.lon, ops: 0, lines: new Set() }));
      st.ops |= feed.op === 'tmb' ? 1 : 2;
      for (const r of rs) st.lines.add(lineIdx.get(P + r));
      if (feed.op === 'amb' && String(+stopId) !== key) ambStopKey[stopId] = key;
    }
  }
  console.log(`Paradas: ${stops.size} (fusionadas TMB+AMB: ${merged}, conflictos de código: ${conflicts})`);

  const stopIdToKey = (feed, id) => {
    const s = feed.stopsById.get(id);
    if (!s) return null;
    if (feed.op === 'amb' && ambStopKey[id]) return ambStopKey[id];
    if (stops.has(s.code)) return s.code;
    return stops.has(`${feed.op}-${s.code}`) ? `${feed.op}-${s.code}` : null;
  };

  // --- Patrones por línea (ficheros individuales, carga perezosa) ---
  rmSync(join(OUT, 'lines'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'lines'), { recursive: true });
  const ambPatterns = {}; // prefijo trip_id AMB (4 segmentos) -> [lineIdx, patternIdx]
  let shapeBytes = 0;
  const fileHashes = {}; // fichero de línea -> huella
  for (const feed of [tmb, amb]) {
    const P = feed.op === 'tmb' ? 't:' : 'a:';
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
        if (!isMain && p.n / totalByDir[p.dir] < 0.05) continue;
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
          if (needsMatching(pts)) {
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
        byPat[pi].get(si).push(Math.round(start[1] / 60));
      }
      out.forEach((o, pi) => {
        o.t = [...byPat[pi]].map(([si, mins]) => {
          mins.sort((a, b) => a - b);
          return [si, ...mins.map((m, i) => (i ? m - mins[i - 1] : m))];
        });
      });
      const lineJson = JSON.stringify({ id: P + routeId, patterns: out, cal: { base: CAL.base, svc: [...svcIdx.keys()].map((sid) => feed.svcMasks.get(sid)) } });
      const lineName = `${P.replace(':', '_')}${routeId.replace(/[^\w.-]/g, '_')}.json`;
      writeFileSync(join(OUT, 'lines', lineName), lineJson);
      fileHashes[lineName] = shortHash(lineJson);

      if (feed.op === 'amb') {
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
  const stopList = [...stops.values()].map((s) => [s.code, s.name, r5(s.lat), r5(s.lon), s.ops, [...s.lines].filter((x) => x !== undefined).sort((a, b) => a - b)]);
  const index = {
    v: 1,
    generated: new Date().toISOString(),
    lines: lines.map((l) => [l.id, l.op, l.short, l.long, l.color, l.text, l.url, l.heads || []]),
    stops: stopList,
    ambStopKey,
    ambPatterns,
    // estaciones de metro/funicular de TMB como lugares buscables
    places: [...new Map(tmb.stations.map((p) => [p[0], p])).values()],
    files: fileHashes,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'network.json'), JSON.stringify(index));
  // la app consulta este fichero diminuto para saber si hay una red más nueva que la suya
  // huella del contenido (sin la fecha): si no cambia, las apps no descargan nada
  const { generated: _g, ...content } = index;
  writeFileSync(join(OUT, 'version.json'), JSON.stringify({ generated: index.generated, hash: shortHash(JSON.stringify(content)), lines: lines.length, stops: stopList.length }));
  console.log(`Líneas: ${lines.length}. network.json: ${Math.round(JSON.stringify(index).length / 1024)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
