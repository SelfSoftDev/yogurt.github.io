// tv 시청률 최신 스냅샷(일간 최신·주간·역대 × 지상파/종편/케이블 9종) — GitHub Actions 일 1회.
//  · 소스는 포털 검색결과 페이지 — 파싱 규칙 = 앱 렌더러(ygt_culture_TV.js TVParser)와 동일 split.
//  · 과거 날짜 조회는 별도 백필 데이터(data_tv_ratings.js)가 담당 — 여긴 "최신" 9탭만.
//  · 출력: tv/ratings_now.json {dateKey, generated, data:[[{date,items[]}×3]×3]} — [tab(일간/주간/역대)][subtab(지상파/종편/케이블)]
//
// 사용: node collect_tv_ratings_now.js [출력파일=tv/ratings_now.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const OUT = process.argv[2] || 'tv/ratings_now.json';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const URLS = [
  ['https://m.search.daum.net/search?w=tot&q=%EC%9D%BC%EC%9D%BC%EC%8B%9C%EC%B2%AD%EB%A5%A0',
   'https://m.search.daum.net/search?w=tot&q=%EC%A2%85%ED%95%A9%ED%8E%B8%EC%84%B1%20%EC%9D%BC%EC%9D%BC%EC%8B%9C%EC%B2%AD%EB%A5%A0',
   'https://m.search.daum.net/search?w=tot&q=%EC%BC%80%EC%9D%B4%EB%B8%94%20%EC%9D%BC%EC%9D%BC%EC%8B%9C%EC%B2%AD%EB%A5%A0'],
  ['https://m.search.daum.net/search?w=tot&q=%EC%A3%BC%EA%B0%84%EC%8B%9C%EC%B2%AD%EB%A5%A0',
   'https://m.search.daum.net/search?w=tot&q=%EC%A2%85%ED%95%A9%ED%8E%B8%EC%84%B1%20%EC%A3%BC%EA%B0%84%EC%8B%9C%EC%B2%AD%EB%A5%A0',
   'https://m.search.daum.net/search?w=tot&q=%EC%BC%80%EC%9D%B4%EB%B8%94%20%EC%A3%BC%EA%B0%84%EC%8B%9C%EC%B2%AD%EB%A5%A0'],
  ['https://m.search.daum.net/search?w=tot&q=%EC%97%AD%EB%8C%80%EC%8B%9C%EC%B2%AD%EB%A5%A0',
   'https://m.search.daum.net/search?w=tot&q=%EC%A2%85%ED%95%A9%ED%8E%B8%EC%84%B1%20%EC%97%AD%EB%8C%80%EC%8B%9C%EC%B2%AD%EB%A5%A0',
   'https://m.search.daum.net/search?w=tot&q=%EC%BC%80%EC%9D%B4%EB%B8%94%20%EC%97%AD%EB%8C%80%EC%8B%9C%EC%B2%AD%EB%A5%A0'],
];

function req(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko', 'Accept-Encoding': 'gzip' },
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
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

// 렌더러와 동일 split (i<4 상위3위는 컬럼 구조가 다름)
function parseRatings(html) {
  const result = html.split('tr><td><em');
  if (result.length < 2) return null;
  const date = ((result[result.length - 1].split('닐슨코리아 ')[1] || '').split('<a href')[0] || '').trim();
  const items = [];
  for (let i = 1; i < result.length; i++) {
    try {
      const o = {};
      if (i < 4) {
        o.rank = result[i].split('>')[1].split('</')[0].trim();
        o.title = result[i].split('">')[2].split('</')[0].trim();
        o.broad = result[i].split('">')[3].split('</')[0].trim();
        o.rate = result[i].split('">')[4].split('</')[0].trim();
      } else {
        o.rank = result[i].split('>')[1].split('</')[0].trim();
        o.title = result[i].split('">')[1].split('</')[0].trim();
        o.broad = result[i].split('">')[2].split('</')[0].trim();
        o.rate = result[i].split('<span>')[1].split('</')[0].trim();
      }
      if (o.rank && o.title) items.push(o);
    } catch (e) { /* 행 파싱 실패는 건너뜀 */ }
  }
  return { date, items };
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = { dateKey: dateKey(), generated: genStamp(), data: [[], [], []] };
  let ok = 0;

  for (let tab = 0; tab < 3; tab++) {
    for (let sub = 0; sub < 3; sub++) {
      try {
        const html = await req(URLS[tab][sub]);
        const r = parseRatings(html);
        if (!r || r.items.length < 5) throw new Error('파싱 부족: ' + (r ? r.items.length : 'null'));
        out.data[tab][sub] = r;
        ok++;
      } catch (e) {
        console.error('탭 ' + tab + '-' + sub + ' 실패: ' + e.message);
        out.data[tab][sub] = null;
      }
      await sleep(500);
    }
  }

  if (ok < 6) throw new Error('성공 ' + ok + '/9 — 소스 구조 변화 의심');
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + ok + '/9, ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
