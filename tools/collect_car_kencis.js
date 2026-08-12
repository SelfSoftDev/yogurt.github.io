// car 배출가스·소음 인증 수집 — GitHub Actions 일 1회 (0914).
//  · data.go.kr 15000988 (getVems, 공공누리 1유형). 키는 env DATAGO_KEY (Actions secret).
//  · 키 미등록/미설정이면 exit 0 (soft-skip) — 활용신청 승인 전 크론 실패 방지.
//  · 당해+전년 인증분을 국내(gubun=2)/수입(gubun=1)별 수집, 인증일 내림차순.
//  · 출력: car/kencis.json {dateKey, generated, kor:{items}, imp:{items}} — item {name,type,cartype,fuel,office,emisDate,noiseDate}
//
// 사용: DATAGO_KEY=<키> node collect_car_kencis.js [출력파일=car/kencis.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = process.argv[2] || 'car/kencis.json';
const KEY = (process.env.DATAGO_KEY || '').trim();

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000, headers: { 'Accept': '*/*' } }, (res) => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

async function fetchYear(gubun, year) {
  const items = [];
  for (let page = 1; page <= 30; page++) {
    const url = 'https://apis.data.go.kr/1480523/Kencis/getVems?serviceKey=' + encodeURIComponent(KEY)
      + '&pageNo=' + page + '&numOfRows=500&resultType=JSON&gubun=' + gubun + '&certi_date=' + year;
    const r = await get(url);
    if (r.body.indexOf('SERVICE_KEY_IS_NOT_REGISTERED_ERROR') !== -1) return null; // 미등록 키
    let d;
    try { d = JSON.parse(r.body); } catch (e) { throw new Error('JSON 파싱 실패 (HTTP ' + r.status + '): ' + r.body.slice(0, 120)); }
    const body = d && d.response && d.response.body;
    if (!body) throw new Error('예상 밖 응답: ' + r.body.slice(0, 120));
    let arr = body.items && body.items.item;
    if (!arr) break;
    if (!Array.isArray(arr)) arr = [arr];
    arr.forEach(it => items.push({
      name: it.vehNm || '', type: it.vehType || '', cartype: it.cartype || '',
      fuel: it.fueltype || '', office: it.officeNm || '',
      emisDate: it.emisCertiDate || '', noiseDate: it.noiseCertiDate || '',
    }));
    const total = Number(body.totalCount || 0);
    if (page * 500 >= total) break;
    await sleep(300);
  }
  return items;
}

(async () => {
  if (!KEY) { console.log('DATAGO_KEY 미설정 — 스킵'); process.exit(0); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const y = kstNow().getUTCFullYear();
  const out = { dateKey: dateKey(), generated: genStamp(), kor: { items: [] }, imp: { items: [] } };

  for (const [k, gubun] of [['kor', 2], ['imp', 1]]) {
    let all = [];
    for (const yr of [y, y - 1]) {
      const part = await fetchYear(gubun, yr);
      if (part === null) { console.log('서비스키 미등록 — 스킵 (활용신청 필요)'); process.exit(0); }
      all = all.concat(part);
      await sleep(300);
    }
    // 인증일 내림차순, 승용 위주 정렬은 렌더러에서 — 여기선 원본 유지 + 날짜 정렬만
    all.sort((a, b) => String(b.emisDate || b.noiseDate).localeCompare(String(a.emisDate || a.noiseDate)));
    out[k].items = all;
  }

  if (!out.kor.items.length && !out.imp.items.length) throw new Error('수집 0건');
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (국내 ' + out.kor.items.length + ', 수입 ' + out.imp.items.length + ', ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
