// 날씨 수집 — GitHub Actions 주기 실행. 네이버 날씨 choiceApi를 앱 대신 수집해
// github.io에 올림(네이버 포맷 변경 시 앱이 아닌 이 수집기만 수정). 소스 3개:
//   · 지역검색  ac.weather.naver.com/ac  → 시드 이름 → naverRgnCd (regions.json은 최초/주1회만 갱신)
//   · 지역날씨  weather.naver.com/choiceApi/api {nowFcast} → 현재+시간별+주간
// 출력:
//   weather/regions.json  {generated, regions:[{code,full,sido,sigungu,dong}]}  (검색 인덱스, 시군구 단위)
//   weather/now.json      {t, generated, wx:{<code>:{tmpr,wetrTxt,wetrCd,rainProb,humd,windSpd,hourly:[...],weekly:[...]}}}
//
// 사용: node collect_weather.js            (now.json 갱신)
//       node collect_weather.js --regions  (regions.json 재생성 = 시드 재해석)
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const SEED = require('./region_seed.js');

const OUT_DIR = 'weather';
const REGIONS = path.join(OUT_DIR, 'regions.json');
const NOW = path.join(OUT_DIR, 'now.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

function get(url, host) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://weather.naver.com/', 'Accept': 'application/json' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve(Buffer.concat(ch).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kst() { return new Date(Date.now() + 9 * 3600e3); }
const p2 = n => (n < 10 ? '0' : '') + n;
function stamp() { const d = kst(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

// 시드 이름 → naverRgnCd 해석 (첫 지역형 결과: 숫자코드 + 공백 2개 이상)
async function resolveRegion(term) {
  const j = JSON.parse(await get('https://ac.weather.naver.com/ac?q_enc=utf-8&r_format=json&r_enc=utf-8&r_lt=1&st=1&r_unit=1&q=' + encodeURIComponent(term)));
  const items = (j.items && j.items[0]) || [];
  for (const it of items) {
    const full = it[0][0], code = it[1][0];
    if (/^\d{6,}$/.test(code) && full.split(' ').length >= 2) {
      const parts = full.split(' ');
      return { code, full, sido: parts[0], sigungu: parts.slice(1, -1).join(' ') || parts[1], dong: parts[parts.length - 1] };
    }
  }
  return null;
}

async function buildRegions() {
  const out = [];
  for (const term of SEED) {
    try { const r = await resolveRegion(term); if (r) { out.push({ code: r.code, full: r.full, sido: r.sido, sigungu: term.split(' ').slice(1).join(' ') || r.sigungu, dong: r.dong, term }); } else console.error('미해석: ' + term); }
    catch (e) { console.error('해석실패 ' + term + ': ' + e.message); }
    await sleep(120);
  }
  fs.writeFileSync(REGIONS, JSON.stringify({ generated: stamp(), count: out.length, regions: out }));
  console.log('regions.json: ' + out.length + '/' + SEED.length + '개');
  return out;
}

// 단일 지역 nowFcast → 현재 요약 + 시간별
async function fetchWx(code) {
  const q = encodeURIComponent(JSON.stringify({ nowFcast: { naverRgnCd: code } }));
  const j = JSON.parse(await get('https://weather.naver.com/choiceApi/api?choiceQuery=' + q));
  const cr = j.results.choiceResult || {};
  const nf = cr.nowFcast; if (!nf || !nf.nowFcastList || !nf.nowFcastList.length) throw new Error('빈 nowFcast');
  const cur = nf.nowFcastList[0];
  const hourly = nf.nowFcastList.map(h => ({ tm: h.aplTm, t: h.tmpr, wc: h.wetrCd, wt: h.wetrTxt, rp: h.rainProb, hm: h.humd, ws: h.windSpd, ra: h.rainAmt }));
  return { sido: nf.lareaNm, sigungu: nf.mareaNm, dong: nf.sareaNm, tmpr: cur.tmpr, wetrCd: cur.wetrCd, wetrTxt: cur.wetrTxt, rainProb: cur.rainProb, humd: cur.humd, windSpd: cur.windSpd, aplYmdt: cur.aplYmdt, hourly };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let regions;
  if (process.argv.includes('--regions') || !fs.existsSync(REGIONS)) {
    regions = await buildRegions();
  } else {
    regions = JSON.parse(fs.readFileSync(REGIONS, 'utf8')).regions;
  }

  const wx = {}; let ok = 0, fail = 0;
  for (const r of regions) {
    try { wx[r.code] = await fetchWx(r.code); ok++; }
    catch (e) { fail++; console.error('날씨실패 ' + r.term + '(' + r.code + '): ' + e.message); }
    await sleep(80);
  }
  if (ok < regions.length * 0.5) throw new Error('수집 과반 실패 (' + ok + '/' + regions.length + ')');
  fs.writeFileSync(NOW, JSON.stringify({ t: Date.now(), generated: stamp(), count: ok, wx }));
  console.log('now.json: ' + ok + '개 성공, ' + fail + '개 실패, ' + Math.round(fs.statSync(NOW).size / 1024) + 'KB');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
