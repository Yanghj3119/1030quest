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
import { getPlaces, env, SOURCES, isCached } from './lib/places.js';

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

const PORT = +env('PORT') || 3000;

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
        cached: isCached(),
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
