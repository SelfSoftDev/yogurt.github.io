// 공휴일 수집 — 한국천문연구원 특일정보(공휴일 조회 getRestDeInfo) → tool/holidays.json
// GitHub Actions에서 실행(env DATAGO_KEY). 작년~내후년 4개년, isHoliday=Y만.
// 미래 연도 응답이 비면 '공휴일 없음'으로 확정하지 않고 status로 구분(문서 정책).
// 출력: tool/holidays.json {generated, years:{ "2026":{status:"complete",days:[{d,n}]}}}
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const KEY = process.env.DATAGO_KEY;
const OUT_DIR = 'tool';
const OUT = path.join(OUT_DIR, 'holidays.json');
const BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

if (!KEY) { console.error('DATAGO_KEY 미설정'); process.exit(1); }

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// XML <item>들 파싱 (단일/다중/누락 모두 처리)
function parseItems(xml) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const g = (tag) => { const m = it.match(new RegExp('<' + tag + '>([^<]*)<')); return m ? m[1].trim() : ''; };
    out.push({ locdate: g('locdate'), dateName: g('dateName'), isHoliday: g('isHoliday') });
  }
  return out;
}

async function fetchYear(year) {
  const days = []; let ok = true;
  for (let m = 1; m <= 12; m++) {
    const mm = (m < 10 ? '0' : '') + m;
    let page = 1, more = true;
    while (more) {
      const url = `${BASE}?serviceKey=${KEY}&solYear=${year}&solMonth=${mm}&numOfRows=50&pageNo=${page}&_type=xml`;
      let r;
      try { r = await get(url); } catch (e) { console.error(`${year}-${mm} p${page} 실패: ${e.message}`); ok = false; break; }
      if (r.status !== 200) { console.error(`${year}-${mm} HTTP ${r.status}`); ok = false; break; }
      const code = (r.body.match(/<resultCode>([^<]*)</) || [])[1];
      if (code && code !== '00') {
        // 키오류/한도 등은 연도 실패로 처리(무한 재시도 금지)
        console.error(`${year}-${mm} resultCode ${code}: ${(r.body.match(/<resultMsg>([^<]*)</) || [])[1] || ''}`);
        ok = false; break;
      }
      const items = parseItems(r.body);
      for (const it of items) {
        if (it.isHoliday === 'Y' && /^\d{8}$/.test(it.locdate)) days.push({ d: it.locdate, n: it.dateName || '공휴일' });
      }
      const total = Number((r.body.match(/<totalCount>(\d+)</) || [])[1] || 0);
      more = page * 50 < total;
      page++;
      await sleep(120);
    }
    if (!ok) break;
  }
  if (!ok) return { status: 'error', days: [] };
  // 같은 날 복수 명칭 병합은 앱에서 하므로 그대로 두되, 정렬만
  days.sort((a, b) => a.d.localeCompare(b.d));
  if (!days.length) return { status: 'unavailable', days: [] };   // 미래연도 미공표 등 — '없음' 확정 금지
  return { status: 'complete', days };
}

function stamp() {
  const d = new Date(Date.now() + 9 * 3600e3);
  const p = n => (n < 10 ? '0' : '') + n;
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} KST`;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const nowY = new Date(Date.now() + 9 * 3600e3).getUTCFullYear();
  const years = {};
  let okCnt = 0;
  for (const y of [nowY - 1, nowY, nowY + 1, nowY + 2]) {
    const r = await fetchYear(y);
    years[String(y)] = r;
    console.log(`${y}: ${r.status} (${r.days.length}일)`);
    if (r.status === 'complete') okCnt++;
  }
  if (okCnt === 0) { console.error('전 연도 수집 실패 — 저장 안 함'); process.exit(1); }
  // 기존 파일과 병합: 이번에 실패한 연도는 기존 성공본 유지
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).years || {}; } catch (e) {}
  for (const y of Object.keys(years)) {
    if (years[y].status !== 'complete' && prev[y] && prev[y].status === 'complete') years[y] = prev[y];
  }
  for (const y of Object.keys(prev)) if (!years[y]) years[y] = prev[y];   // 과거 연도 보존
  fs.writeFileSync(OUT, JSON.stringify({ generated: stamp(), years }));
  console.log(`저장: ${OUT} (${Object.keys(years).length}개 연도)`);
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
