// 공공데이터 API 호출·병합 로직 (로컬 server.js 와 Vercel api/places.js 가 함께 사용)
//
// 환경변수
//   JEJU_CULTURE_LOCATION_KEY  제주역사문화 위치정보 API 인증키
//   JEJU_CULTURE_INFO_KEY      제주역사문화 일반정보 API 인증키
//   JEJU_CULTURE_LOCATION_URL  위치정보 API 요청주소 (키 제외)
//   JEJU_CULTURE_INFO_URL      일반정보 API 요청주소 (키 제외)
//   (선택) JEJU_KEY_PARAM=serviceKey, JEJU_PAGE_SIZE=100
//   (로컬 전용) JEJU_DATA_SOURCE=csv + JEJU_CSV_DIR=<CSV 폴더>
import fs from 'node:fs';
import path from 'node:path';

export const env = (k) => (process.env[k] || '').trim().replace(/^["']+|["']+$/g, '').trim();
const TTL = 60 * 60 * 1000;

export const SOURCES = {
  location: { key: 'JEJU_CULTURE_LOCATION_KEY', url: 'JEJU_CULTURE_LOCATION_URL' },
  info: { key: 'JEJU_CULTURE_INFO_KEY', url: 'JEJU_CULTURE_INFO_URL' },
};

// ---------- API 호출
const scrub = (s, key) => (key ? String(s).split(key).join('***') : String(s));

function findItems(json) {
  const body = json?.response?.body ?? json;
  const items = body?.items?.item ?? body?.items ?? body?.data ?? body?.list ?? json?.data;
  return Array.isArray(items) ? items : items && typeof items === 'object' ? [items] : [];
}
function totalOf(json) {
  const n = +(json?.response?.body?.totalCount ?? json?.totalCount ?? json?.matchCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// 요청주소가 데이터가 아니라 Swagger 명세(문서)를 가리키면, 명세 안의 호스트·경로로 실제 호출 주소를 만듭니다.
function swaggerEndpoint(doc) {
  if (!doc || !doc.swagger || !doc.paths || !doc.host) return null;
  const paths = Object.keys(doc.paths);
  const p = paths.find((k) => doc.paths[k]?.get) ?? paths[0];
  if (p === undefined) return null;
  return `${(doc.schemes || ['https'])[0]}://${doc.host}${doc.basePath || ''}${p}`;
}

async function fetchAll(name) {
  const { key: keyVar, url: urlVar } = SOURCES[name];
  const KEY_PARAM = env('JEJU_KEY_PARAM') || 'serviceKey';
  const PAGE_SIZE = +env('JEJU_PAGE_SIZE') || 100;
  const key = env(keyVar), base = env(urlVar);
  if (!key) throw new Error(`환경변수 ${keyVar} 가 설정되지 않았습니다.`);
  if (!base) throw new Error(`환경변수 ${urlVar}(API 요청주소)가 설정되지 않았습니다.`);
  const all = [];
  let endpoint = base;
  for (let page = 1; page <= 200; page++) {
    const u = new URL(endpoint);
    // 디코딩 키·인코딩 키 모두 안전하게 쓰도록 이미 %가 있으면 한 번 풀어서 넣습니다.
    u.searchParams.set(KEY_PARAM, /%[0-9A-F]{2}/i.test(key) ? decodeURIComponent(key) : key);
    u.searchParams.set('pageNo', page);
    u.searchParams.set('numOfRows', PAGE_SIZE);
    u.searchParams.set('type', 'json');
    u.searchParams.set('page', page);
    u.searchParams.set('perPage', PAGE_SIZE);
    u.searchParams.set('returnType', 'JSON');
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
    if (page === 1 && json?.swagger) {
      const next = swaggerEndpoint(json);
      if (!next) throw new Error(`${name} 요청주소가 Swagger 명세를 가리키는데 호출 경로를 찾지 못했습니다. 명세의 host/basePath/paths 로 만든 실제 API 주소를 환경변수에 넣어 주세요.`);
      endpoint = next; page = 0; continue;
    }
    const items = findItems(json);
    if (page === 1 && !items.length) {
      const msg = json?.response?.header?.resultMsg || json?.resultMsg || '';
      throw new Error(`${name} API 응답에서 항목을 찾지 못했습니다. 응답 최상위 키: [${Object.keys(json).join(', ')}]${msg ? ' / 메시지: ' + msg : ''}`);
    }
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
export async function getPlaces() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  let loc, info;
  if (env('JEJU_DATA_SOURCE') === 'csv') { loc = loadCsv('위치정보'); info = loadCsv('일반정보'); }
  else [loc, info] = await Promise.all([fetchAll('location'), fetchAll('info')]);
  const data = merge(loc, info);
  if (!data.length) {
    const keys = (rows) => Object.keys(rows[0] || {}).join(', ') || '(없음)';
    throw new Error(`API 응답의 필드명이 예상과 달라 장소를 만들지 못했습니다. 위치정보 ${loc.length}건 필드: [${keys(loc)}] / 일반정보 ${info.length}건 필드: [${keys(info)}]`);
  }
  cache = { at: Date.now(), data };
  return data;
}


export const isCached = () => !!cache.data;
