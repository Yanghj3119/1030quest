// Vercel 서버리스 함수: GET /api/places
// 키는 Vercel 프로젝트 환경변수(JEJU_CULTURE_*)에서만 읽고, 브라우저에는 노출하지 않습니다.
import { getPlaces } from '../lib/places.js';

export default async function handler(req, res) {
  try {
    const data = await getPlaces();
    // CDN에 1시간 캐시(성공한 응답만) → 공공 API 호출 횟수를 줄입니다.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (e) {
    console.error('[places]', e.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message });
  }
}
