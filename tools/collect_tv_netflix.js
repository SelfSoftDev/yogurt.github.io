// tv 넷플릭스 TOP 10 최신주 수집(한국/미국/일본×영화·TV + 세계 주간/역대×4) — GitHub Actions 일 1회.
//  · 파싱 규칙 = 앱 렌더러(ygt_culture_netflix.js selectParser/dataParser)와 동일 split.
//  · 최신주만 수집 — 과거 주(?week=) 조회는 앱이 라이브 폴백.
//  · 출력: tv/netflix.json {dateKey, generated, tabs:[[ {weeks:[{s,e}...최신순], items:[{rank,title,hours?,img}]} ×subtab ] ×5]}
//
// 사용: node collect_tv_netflix.js [출력파일=tv/netflix.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const OUT = process.argv[2] || 'tv/netflix.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const URLS = [
  ['https://www.netflix.com/tudum/top10/south-korea', 'https://www.netflix.com/tudum/top10/south-korea/tv'],
  ['https://www.netflix.com/tudum/top10/united-states', 'https://www.netflix.com/tudum/top10/united-states/tv'],
  ['https://www.netflix.com/tudum/top10/japan', 'https://www.netflix.com/tudum/top10/japan/tv'],
  ['https://www.netflix.com/tudum/top10', 'https://www.netflix.com/tudum/top10/films-non-english',
   'https://www.netflix.com/tudum/top10/tv', 'https://www.netflix.com/tudum/top10/tv-non-english'],
  ['https://www.netflix.com/tudum/top10/most-popular', 'https://www.netflix.com/tudum/top10/most-popular/films-non-english',
   'https://www.netflix.com/tudum/top10/most-popular/tv', 'https://www.netflix.com/tudum/top10/most-popular/tv-non-english'],
];

function req(url, redir) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'ko,en', 'Accept-Encoding': 'gzip' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && (redir || 0) < 3) {
        res.resume();
        return resolve(req(new URL(res.headers.location, url).href, (redir || 0) + 1));
      }
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

// weeks: 렌더러 selectParser와 동일 split — {startDate, endDate} 목록
function parseWeeks(html) {
  const seg = html.split('"weeks":')[1];
  if (!seg) return [];
  const result = seg.split('[')[1].split(']')[0];
  const sel = result.split('{');
  const weeks = [];
  for (let i = sel.length - 1; i > 0; i--) {
    try {
      const s = sel[i].split('startDate')[1].split('"')[2].split('"')[0];
      const e = sel[i].split('endDate')[1].split('"')[2].split('"')[0];
      weeks.push({ s, e });
    } catch (err) { /* skip */ }
  }
  return weeks; // 최신주 먼저 (렌더러 옵션 순서와 동일)
}

// top10: 렌더러 dataParser와 동일 split
function parseTop10(html, withHours) {
  const result = html.split('<td class="title" data-uia="top10-table-row-title">');
  const items = [];
  for (let i = 1; i < 11 && i < result.length; i++) {
    try {
      const o = {};
      o.rank = result[i].split('<span class="rank">')[1].split('</span>')[0];
      o.title = result[i].split('<button>')[1].split('</button>')[0];
      if (withHours) o.hours = (result[i].split('data-uia="top10-table-row-views">')[1] || '').split('</td>')[0];
      o.img = result[i].split('src="')[1].split('"')[0];
      items.push(o);
    } catch (e) { /* skip */ }
  }
  return items;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = { dateKey: dateKey(), generated: genStamp(), tabs: [] };
  let ok = 0, total = 0;

  for (let tab = 0; tab < URLS.length; tab++) {
    const row = [];
    for (let sub = 0; sub < URLS[tab].length; sub++) {
      total++;
      try {
        const html = await req(URLS[tab][sub]);
        const weeks = parseWeeks(html);
        const items = parseTop10(html, tab >= 3);
        if (items.length < 5) throw new Error('items ' + items.length);
        row.push({ weeks, items });
        ok++;
      } catch (e) {
        console.error('탭 ' + tab + '-' + sub + ' 실패: ' + e.message);
        row.push(null);
      }
      await sleep(700);
    }
    out.tabs.push(row);
  }

  if (ok < 10) throw new Error('성공 ' + ok + '/' + total + ' — 소스 구조 변화 의심');
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + ok + '/' + total + ', ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
