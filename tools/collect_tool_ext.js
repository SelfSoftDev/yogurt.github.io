// 도구 확장 데이터 수집 — 환율(fx.json) / 일출일몰(sun.json) / 대기질(air.json)
// 각 파트는 독립 실행: 하나가 실패해도 나머지는 저장(차단 금지 — car 교훈).
// 키: KOREAEXIM_KEY(환율, 수출입은행 자체 발급), DATAGO_KEY(출몰시각·에어코리아).
// 키 없거나 미승인인 파트는 건너뛰고 기존 파일 유지(빈 파일로 덮지 않음).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = 'tool';
const EXIM_KEY = process.env.KOREAEXIM_KEY;
const DATAGO_KEY = process.env.DATAGO_KEY;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000, headers: { 'Accept': '*/*' } }, (res) => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kst() { return new Date(Date.now() + 9 * 3600e3); }
const p2 = n => (n < 10 ? '0' : '') + n;
function stamp() { const d = kst(); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} KST`; }
function ymd(d) { return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; }
function xmlTag(src, tag) { const m = src.match(new RegExp('<' + tag + '>([^<]*)<')); return m ? m[1].trim() : ''; }

// ---------- 환율 (수출입은행 AP01) ----------
async function collectFx() {
  if (!EXIM_KEY) { console.log('fx: KOREAEXIM_KEY 없음 — 건너뜀'); return; }
  // 주말/미고시 대비 최근 7일 역순으로 시도
  for (let i = 0; i < 7; i++) {
    const d = kst(); d.setUTCDate(d.getUTCDate() - i);
    const day = ymd(d);
    let r;
    try { r = await get(`https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${EXIM_KEY}&searchdate=${day}&data=AP01`); }
    catch (e) { console.error('fx: ' + e.message); return; }
    if (r.status !== 200) { console.error('fx: HTTP ' + r.status); return; }
    let arr;
    try { arr = JSON.parse(r.body); } catch (e) { console.error('fx: JSON 파싱 실패'); return; }
    if (!Array.isArray(arr) || !arr.length) { await sleep(300); continue; }   // 미고시일 → 이전 날
    if (arr[0] && arr[0].result && arr[0].result !== 1) { console.error('fx: result=' + arr[0].result + ' (키/한도 확인)'); return; }
    const rates = arr.filter(x => x.result === 1).map(x => {
      const um = String(x.cur_unit || '').match(/^([A-Z]+)\((\d+)\)/);
      return {
        cur: um ? um[1] : x.cur_unit,
        unit: um ? Number(um[2]) : 1,
        name: x.cur_nm || '',
        rate: Number(String(x.deal_bas_r || '').replace(/,/g, '')),
      };
    }).filter(x => x.cur && x.rate > 0);
    if (!rates.length) { await sleep(300); continue; }
    const base = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
    fs.writeFileSync(path.join(OUT_DIR, 'fx.json'), JSON.stringify({ generated: stamp(), base, rates }));
    console.log(`fx: ${rates.length}통화 (기준일 ${base})`);
    return;
  }
  console.error('fx: 최근 7일 고시 없음');
}

// ---------- 일출일몰 (천문연 RiseSetInfoService, 지역명) ----------
const SUN_CITIES = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '수원', '춘천', '강릉', '청주', '전주', '목포', '여수', '포항', '창원', '제주'];
async function collectSun() {
  if (!DATAGO_KEY) { console.log('sun: DATAGO_KEY 없음 — 건너뜀'); return; }
  const days = {};
  let anyOk = false, authFail = false;
  for (let i = 0; i < 8 && !authFail; i++) {
    const d = kst(); d.setUTCDate(d.getUTCDate() + i);
    const day = ymd(d);
    days[day] = {};
    for (const city of SUN_CITIES) {
      const url = `https://apis.data.go.kr/B090041/openapi/service/RiseSetInfoService/getAreaRiseSetInfo?serviceKey=${DATAGO_KEY}&locdate=${day}&location=${encodeURIComponent(city)}`;
      let r;
      try { r = await get(url); } catch (e) { console.error(`sun ${city} ${day}: ${e.message}`); continue; }
      const code = xmlTag(r.body, 'resultCode');
      if (code && code !== '00') {
        console.error(`sun: resultCode ${code} ${xmlTag(r.body, 'resultMsg')}`);
        if (/(SERVICE|KEY|REGISTERED)/i.test(r.body) || code === '30' || code === '20') { authFail = true; break; }
        continue;
      }
      const rise = (xmlTag(r.body, 'sunrise') || '').replace(/\s/g, '').slice(0, 4);
      const set = (xmlTag(r.body, 'sunset') || '').replace(/\s/g, '').slice(0, 4);
      if (/^\d{4}$/.test(rise) && /^\d{4}$/.test(set)) { days[day][city] = { rise, set }; anyOk = true; }
      await sleep(80);
    }
  }
  if (!anyOk) { console.error('sun: 수집 실패(활용신청/승인 확인 필요) — 기존 파일 유지'); return; }
  fs.writeFileSync(path.join(OUT_DIR, 'sun.json'), JSON.stringify({ generated: stamp(), cities: SUN_CITIES, days }));
  console.log(`sun: ${Object.keys(days).length}일 × ${SUN_CITIES.length}지역`);
}

// ---------- 대기질 (에어코리아 시도별 시간평균 + 예보) ----------
const AIR_SIDO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '세종'];
async function collectAir() {
  if (!DATAGO_KEY) { console.log('air: DATAGO_KEY 없음 — 건너뜀'); return; }
  const rows = {};
  let anyOk = false;
  for (const item of ['PM10', 'PM25']) {
    const url = `https://apis.data.go.kr/B552584/ArpltnStatsSvc/getCtprvnMesureLIst?serviceKey=${DATAGO_KEY}&returnType=json&numOfRows=1&pageNo=1&itemCode=${item}&dataGubun=HOUR`;
    let r;
    try { r = await get(url); } catch (e) { console.error(`air ${item}: ${e.message}`); continue; }
    let j;
    try { j = JSON.parse(r.body); } catch (e) { console.error(`air ${item}: JSON 아님 (${r.body.slice(0, 80)})`); continue; }
    const hdr = j.response && j.response.header;
    if (!hdr || hdr.resultCode !== '00') { console.error(`air ${item}: ${hdr ? hdr.resultCode + ' ' + hdr.resultMsg : '헤더 없음'}`); continue; }
    const it = j.response.body && j.response.body.items && j.response.body.items[0];
    if (!it) continue;
    for (const s of AIR_SIDO) {
      const v = Number(it[s.toLowerCase()] ?? it[s]);
      const key = { '서울': 'seoul', '부산': 'busan', '대구': 'daegu', '인천': 'incheon', '광주': 'gwangju', '대전': 'daejeon', '울산': 'ulsan', '경기': 'gyeonggi', '강원': 'gangwon', '충북': 'chungbuk', '충남': 'chungnam', '전북': 'jeonbuk', '전남': 'jeonnam', '경북': 'gyeongbuk', '경남': 'gyeongnam', '제주': 'jeju', '세종': 'sejong' }[s];
      const val = Number(it[key]);
      if (!isNaN(val)) {
        rows[s] = rows[s] || {};
        rows[s][item === 'PM10' ? 'pm10' : 'pm25'] = val;
        anyOk = true;
      }
    }
    var basis = it.dataTime || '';
    if (anyOk) rows._basis = basis;
    await sleep(200);
  }
  if (!anyOk) { console.error('air: 수집 실패(활용신청/승인 확인 필요) — 기존 파일 유지'); return; }
  const basisOut = rows._basis || ''; delete rows._basis;
  fs.writeFileSync(path.join(OUT_DIR, 'air.json'), JSON.stringify({ generated: stamp(), basis: basisOut, rows }));
  console.log(`air: ${Object.keys(rows).length}개 시도 (기준 ${basisOut})`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await collectFx().catch(e => console.error('fx 예외: ' + e.message));
  await collectSun().catch(e => console.error('sun 예외: ' + e.message));
  await collectAir().catch(e => console.error('air 예외: ' + e.message));
})();
