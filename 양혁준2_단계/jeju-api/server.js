// 제주 역사문화 사이트용 서버
//  - 브라우저는 /api/places 만 호출하고, 공공데이터 API 키는 이 서버의 환경변수에서만 읽습니다.
//  - 외부 패키지 없이 Node 18+ 만으로 동작합니다.
//
// 환경변수
//   JEJU_CULTURE_LOCATION_KEY  제주역사문화 위치정보 API 인증키
//   JEJU_CULTURE_INFO_KEY      제주역사문화 일반정보 API 인증키
//   JEJU_CULTURE_LOCATION_URL  위치정보 API 요청주소 (키 제외, 예: https://apis.data.go.kr/.../getList)
//   JEJU_CULTURE_INFO_URL      일반정보 API 요청주소 (키 제외)
//   (선택) JEJU_KEY_PARAM=serviceKey, JEJU_PAGE_SIZE=100, PORT=3000
//   (선택) JEJU_DATA_SOURCE=csv + JEJU_CSV_DIR=<CSV 폴더>  : API 없이 CSV로 화면만 확인할 때
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// .env.local → .env 순서로 읽어서 비어 있는 환경변수만 채웁니다 (실제 환경변수가 우선).
for (const name of ['.env.local', '.env']) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 파일 없음 */ }
}

const env = (k) => (process.env[k] || '').trim();
const PORT = +env('PORT') || 3000;
const KEY_PARAM = env('JEJU_KEY_PARAM') || 'serviceKey';
const PAGE_SIZE = +env('JEJU_PAGE_SIZE') || 100;
const TTL = 60 * 60 * 1000;

const SOURCES = {
  location: { key: 'JEJU_CULTURE_LOCATION_KEY', url: 'JEJU_CULTURE_LOCATION_URL' },
  info: { key: 'JEJU_CULTURE_INFO_KEY', url: 'JEJU_CULTURE_INFO_URL' },
};

// ---------- API 호출
const scrub = (s, key) => (key ? String(s).split(key).join('***') : String(s));

function findItems(json) {
  const body = json?.response?.body ?? json;
  const items = body?.items?.item ?? body?.items ?? body?.data ?? body?.list ?? json?.data ?? json;
  return Array.isArray(items) ? items : items && typeof items === 'object' ? [items] : [];
}
function totalOf(json) {
  const n = +(json?.response?.body?.totalCount ?? json?.totalCount ?? json?.matchCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function fetchAll(name) {
  const { key: keyVar, url: urlVar } = SOURCES[name];
  const key = env(keyVar), base = env(urlVar);
  if (!key) throw new Error(`환경변수 ${keyVar} 가 설정되지 않았습니다.`);
  if (!base) throw new Error(`환경변수 ${urlVar}(API 요청주소)가 설정되지 않았습니다.`);
  const all = [];
  for (let page = 1; page <= 200; page++) {
    const u = new URL(base);
    // 디코딩 키·인코딩 키 모두 안전하게 쓰도록 이미 %가 있으면 한 번 풀어서 넣습니다.
    u.searchParams.set(KEY_PARAM, /%[0-9A-F]{2}/i.test(key) ? decodeURIComponent(key) : key);
    u.searchParams.set('pageNo', page);
    u.searchParams.set('numOfRows', PAGE_SIZE);
    u.searchParams.set('type', 'json');
    let res, text;
    try {
      res = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      text = await res.text();
    } catch (e) {
      throw new Error(`${name} API 호출 실패: ${scrub(e.message, key)}`);
    }
    if (!res.ok) throw new Error(`${name} API 응답 ${res.status}: ${scrub(text.slice(0, 200), key)}`);
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`${name} API가 JSON이 아닌 응답을 보냈습니다: ${scrub(text.slice(0, 200), key)}`); }
    const items = findItems(json);
    all.push(...items);
    const total = totalOf(json);
    if (!items.length || items.length < PAGE_SIZE || (total && all.length >= total)) break;
  }
  return all;
}

// ---------- CSV 개발용 대체 (JEJU_DATA_SOURCE=csv)
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...b] = rows;
  return b.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k.replace(/^﻿/, ''), (r[i] ?? '').trim()])));
}
function loadCsv(pattern) {
  const dir = env('JEJU_CSV_DIR');
  if (!dir) throw new Error('JEJU_CSV_DIR 가 설정되지 않았습니다.');
  const f = fs.readdirSync(dir).find((n) => n.includes(pattern) && n.endsWith('.csv'));
  if (!f) throw new Error(`${dir} 에서 ${pattern} CSV를 찾지 못했습니다.`);
  return parseCSV(new TextDecoder('euc-kr').decode(fs.readFileSync(path.join(dir, f))));
}

// ---------- 병합 (필드명은 CSV 헤더와 같다고 가정하되 흔한 별칭도 허용)
const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return String(r[n]).trim(); return ''; };
const idOf = (r) => pick(r, '데이터 고유번호', '데이터고유번호', 'dataId', 'id');

function merge(locRows, infoRows) {
  const map = new Map();
  const get = (id) => { if (!map.has(id)) map.set(id, { id }); return map.get(id); };
  for (const r of locRows) {
    const id = idOf(r); if (!id) continue;
    Object.assign(get(id), {
      hasLoc: true, name: pick(r, '장소명'), lat: +pick(r, '위도') || null, lon: +pick(r, '경도') || null,
      zip: pick(r, '우편번호'), addr: pick(r, '위치', '주소'), url: pick(r, '데이터 상세보기 URL'),
    });
  }
  for (const r of infoRows) {
    const id = idOf(r); if (!id) continue;
    const d = get(id);
    d.hasGen = true;
    if (!d.name) d.name = pick(r, '장소명');
    if (!d.lat && +pick(r, '위도')) { d.lat = +pick(r, '위도'); d.lon = +pick(r, '경도'); }
    if (!d.url) d.url = pick(r, '링크');
    Object.assign(d, {
      cat: pick(r, '분류'), dir1: pick(r, '디렉토리1'), dir2: pick(r, '디렉토리2'), title: pick(r, '제목'), sub: pick(r, '부제목'),
      author: pick(r, '저작자'), topic: pick(r, '주제'), body: pick(r, '내용'), toc: pick(r, '목차'), abstract: pick(r, '초록'),
      publisher: pick(r, '발행자'), date: pick(r, '발행일'), type: pick(r, '자료유형'),
    });
  }
  return [...map.values()].filter((d) => d.name);
}

let cache = { at: 0, data: null };
async function getPlaces() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  let loc, info;
  if (env('JEJU_DATA_SOURCE') === 'csv') { loc = loadCsv('위치정보'); info = loadCsv('일반정보'); }
  else [loc, info] = await Promise.all([fetchAll('location'), fetchAll('info')]);
  const data = merge(loc, info);
  if (!data.length) throw new Error('API 응답에서 장소 데이터를 찾지 못했습니다. 요청주소와 응답 필드명을 확인해 주세요.');
  cache = { at: Date.now(), data };
  return data;
}

// ---------- HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/api/places') return send(res, 200, JSON.stringify(await getPlaces()));
    if (pathname === '/api/health') {
      return send(res, 200, JSON.stringify({
        source: env('JEJU_DATA_SOURCE') === 'csv' ? 'csv' : 'api',
        locationKey: !!env(SOURCES.location.key), infoKey: !!env(SOURCES.info.key),
        locationUrl: !!env(SOURCES.location.url), infoUrl: !!env(SOURCES.info.url),
        cached: !!cache.data,
      }));
    }
    // 정적 파일 (public/)
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 403, '{"error":"forbidden"}');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, '{"error":"not found"}');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error('[error]', e.message);
    send(res, 502, JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}  (데이터: ${env('JEJU_DATA_SOURCE') === 'csv' ? 'CSV 개발 모드' : 'API'})`));
