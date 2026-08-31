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
const WEEKLY = path.join(OUT_DIR, 'weekly.json');
const WDAY = ['일', '월', '화', '수', '목', '금', '토'];
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
  var nz = function (v) { return (v === undefined || v === null || v === '') ? null : v; };
  const hourly = nf.nowFcastList.map(h => ({ tm: h.aplTm, t: nz(h.tmpr), wc: h.wetrCd, wt: h.wetrTxt, rp: nz(h.rainProb), hm: nz(h.humd), ws: nz(h.windSpd), ra: nz(h.rainAmt) }));
  // 현재 시각(첫 항목)엔 강수확률이 없을 수 있음 → 첫 유효 예보값을 카드 대표값으로
  var repRain = cur.rainProb;
  if (repRain === undefined || repRain === null) { for (var i = 0; i < hourly.length; i++) { if (hourly[i].rp !== null) { repRain = hourly[i].rp; break; } } }
  return { sido: nf.lareaNm, sigungu: nf.mareaNm, dong: nf.sareaNm, tmpr: nz(cur.tmpr), wetrCd: cur.wetrCd, wetrTxt: cur.wetrTxt, rainProb: nz(repRain), humd: nz(cur.humd), windSpd: nz(cur.windSpd), aplYmdt: cur.aplYmdt, hourly };
}

// 주간 예보 — today 페이지 SSR의 domesticWeeklyFcastList(10일) 파싱.
// choiceApi엔 주간 모듈이 없어(weeklyFcast=빈값) HTML에서 추출. 주간은 느리게 바뀌어 저빈도 수집.
function extractArr(html, key) {
  const i = html.indexOf('"' + key + '":');
  if (i < 0) return null;
  let s = html.indexOf('[', i), depth = 0;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(s, k + 1)); } catch (e) { return null; } } }
  }
  return null;
}
async function fetchWeekly(code) {
  const html = await get('https://weather.naver.com/today/' + code);
  const arr = extractArr(html, 'domesticWeeklyFcastList');
  if (!arr || !arr.length) throw new Error('빈 weekly');
  const nz = v => (v === undefined || v === null || v === '') ? null : v;
  return arr.map(d => {
    const ymd = String(d.aplYmd || '');
    const dt = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
    return { d: ymd, w: WDAY[dt.getDay()], aw: d.amWetrTxt, ar: nz(d.amRainProb), pw: d.pmWetrTxt, pr: nz(d.pmRainProb), tn: nz(d.minTmpr), tx: nz(d.maxTmpr) };
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let regions;
  if (process.argv.includes('--regions') || !fs.existsSync(REGIONS)) {
    regions = await buildRegions();
  } else {
    regions = JSON.parse(fs.readFileSync(REGIONS, 'utf8')).regions;
  }

  // 주간 예보 수집 모드 (별도 저빈도 크론)
  if (process.argv.includes('--weekly')) {
    const wk = {}; let wok = 0, wfail = 0;
    for (const r of regions) {
      try { wk[r.code] = await fetchWeekly(r.code); wok++; }
      catch (e) { wfail++; console.error('주간실패 ' + r.term + '(' + r.code + '): ' + e.message); }
      await sleep(120);
    }
    if (wok < regions.length * 0.5) throw new Error('주간 수집 과반 실패 (' + wok + '/' + regions.length + ')');
    fs.writeFileSync(WEEKLY, JSON.stringify({ t: Date.now(), generated: stamp(), count: wok, wk }));
    console.log('weekly.json: ' + wok + '개 성공, ' + wfail + '개 실패, ' + Math.round(fs.statSync(WEEKLY).size / 1024) + 'KB');
    return;
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
