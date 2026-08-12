// movie 평론가 별점(1104) 증분 수집 — GitHub Actions 일 1회.
//  · 리뷰 목록: POST /db/writer/info_review20_items/?p=N&pre_code=… → JSON {items:[{movie_id,hname,review_point,comment}]}
//  · 목록은 최신순 — 기존에 아는 movie_id를 만나면 그 평론가는 중단(신규만 수집).
//  · 신규 항목만 상세(포스터/연도) 크롤 (1초 간격) — 파싱 규칙 = 앱 내 ygt9999_MoviePPS_Parser.html과 동일.
//  · 기존 movie/critic.json 필수(번들 데이터로 시드) — 없으면 전량 크롤이 되므로 에러.
//  · 출력: movie/critic.json {dateKey, generated, pps:{items}, lyc:{items}} — item {id,title,num,com,link,img,year}
//
// 사용: node collect_movie_critic.js [출력파일=movie/critic.json]
'use strict';
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');

const OUT = process.argv[2] || 'movie/critic.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CRITICS = [['pps', 'E20041252'], ['lyc', 'E20041291']];
const MAX_PAGES = 30;

function req(url, form) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = form ? new URLSearchParams(form).toString() : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: body ? 'POST' : 'GET',
      headers: Object.assign(
        { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko', 'Accept-Encoding': 'gzip' },
        body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(ch);
        try {
          if (res.headers['content-encoding'] === 'gzip') resolve(zlib.gunzipSync(buf).toString('utf8'));
          else resolve(buf.toString('utf8'));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', function () { r.destroy(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

async function movieDetail(id) {
  try {
    const html = await req('https://cine21.com/movie/info/?movie_id=' + id);
    const titlePart = html.split('<div class="movie_title">')[1];
    if (!titlePart) return { img: '', year: '' };
    const detailPart = titlePart.split('<div class="movie_detail_star_box_wrap">')[0];
    const img = ((detailPart.split('<div class="poster">')[1] || '').split('<img src="')[1] || '').split('"')[0].trim();
    const rawYear = ((detailPart.split('<p class="eng">')[1] || '').split('</p>')[0] || '').trim();
    const ym = rawYear.match(/\((\d{4})\)/);
    return { img, year: ym ? ym[1] : '' };
  } catch (e) { return { img: '', year: '' }; }
}

async function fetchNew(code, knownIds) {
  const found = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const raw = await req('https://cine21.com/db/writer/info_review20_items/?p=' + p + '&pre_code=' + code, { pre_code: code, p: String(p) });
    let items;
    try { items = JSON.parse(raw).items; } catch (e) { throw new Error('목록 JSON 파싱 실패 p=' + p + ': ' + raw.slice(0, 100)); }
    if (!items || !items.length) break;
    let hitKnown = false;
    for (const it of items) {
      if (knownIds.has(String(it.movie_id))) { hitKnown = true; break; }
      found.push({
        id: String(it.movie_id), title: it.hname || '', num: String(it.review_point == null ? '' : it.review_point),
        com: it.comment || '', link: 'https://cine21.com//movie/info/?movie_id=' + it.movie_id,
      });
    }
    if (hitKnown) break;
    await sleep(600);
  }
  return found;
}

(async () => {
  if (!fs.existsSync(OUT)) throw new Error(OUT + ' 없음 — 번들 데이터로 시드 후 실행할 것 (전량 크롤 방지)');
  const out = JSON.parse(fs.readFileSync(OUT, 'utf8'));

  let totalNew = 0;
  for (const [key, code] of CRITICS) {
    const list = (out[key] && out[key].items) || [];
    const known = new Set(list.map(it => String(it.id)));
    const fresh = await fetchNew(code, known);
    for (const it of fresh) {
      await sleep(1000);
      const d = await movieDetail(it.id);
      it.img = d.img; it.year = d.year;
    }
    out[key] = { items: fresh.concat(list) };
    totalNew += fresh.length;
    console.log(key + ': 신규 ' + fresh.length + '건 (총 ' + out[key].items.length + ')');
    await sleep(600);
  }

  out.dateKey = dateKey();
  out.generated = genStamp();
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (신규 ' + totalNew + ', ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
