// 알라딘 실시간(NowBest) 스냅샷 수집기 — GitHub Actions 30분 주기.
//  · 실시간 랭킹이라 라이브가 정본 — 이 스냅샷은 앱의 "첫 진입(캐시 없음) 임시 표시"용.
//    앱은 스냅샷을 먼저 그려주고 라이브 도착 시 교체 (ygt_culture_book3.js dataParser day).
//  · 파싱 규칙은 앱 렌더러(ygt_culture_book3.js)·collect_book_bestsellers.js와 동일 split.
//  · 출력: book/aladin_now.json  {t(epoch ms), dateKey, generated, dateTxt, books[]}
//    t는 epoch라 시간대 무관 — 앱이 응답 서버시간과 비교해 3시간 이내만 사용.
//  · 항상 새로 씀(t 갱신) — 커밋 폭증은 워크플로의 amend-squash가 흡수.
//
// 사용: node collect_aladin_now.js [출력파일=book/aladin_now.json]
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'book/aladin_now.json';
// 알라딘은 모바일 UA를 모바일 사이트로 302 → PC UA 필수 (앱 페이지의 var userAgent="PC"와 동일 이유)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function get(url, redirects) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(ch);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') resolve(zlib.gunzipSync(buf).toString('utf8'));
          else if (enc === 'deflate') resolve(zlib.inflateSync(buf).toString('utf8'));
          else if (enc === 'br') resolve(zlib.brotliDecompressSync(buf).toString('utf8'));
          else resolve(buf.toString('utf8'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function dateKey() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); }
function genStamp() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST'; }
// 앱 strTodayKor()와 동일 표기 (패딩 없음), KST 기준
function todayKor() { const d = kstNow(); return d.getUTCFullYear() + '년 ' + (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일'; }

// 앱 dataParser(day)/collect_book_bestsellers.js aladinBooks()와 동일 규칙
function aladinBooks(html) {
  const resultAll = html.split('<div class="megaseller_clbox megaseller_sp2">')[1];
  const result = resultAll.split('<div class="ss_book_box" itemId="');
  const books = [];
  for (let i = 1; i < result.length; i++) {
    try {
      const b = {
        rank: i,
        link: 'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=' + result[i].split('">')[0],
        img: result[i].split('<img src="')[1].split('"')[0],
        title: result[i].split('class="bo3">')[1].split('</a>')[0],
        name: '', com: '', date: '',
      };
      if (result[i].indexOf('BranchType=') !== -1) {
        if (result[i].indexOf('AuthorSearch=') !== -1) b.name = result[i].split('AuthorSearch=')[1].split('>')[1].split('<')[0].trim();
        if (result[i].indexOf('PublisherSearch=') !== -1) {
          b.com = result[i].split('PublisherSearch=')[1].split('>')[1].split('<')[0].trim();
          b.date = result[i].split('PublisherSearch=')[1].split('|')[1].split('<')[0].trim();
        }
      }
      books.push(b);
    } catch (e) { /* 행 구조 다르면 스킵 */ }
  }
  return books;
}

(async () => {
  const html = await get('https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=NowBest');
  const books = aladinBooks(html);
  if (books.length < 20) { console.error('알라딘 NowBest: 목록 부족(' + books.length + ') — 기존 파일 유지'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ t: Date.now(), dateKey: dateKey(), generated: genStamp(), dateTxt: todayKor(), books }));
  console.log('알라딘 NowBest 저장: ' + OUT + ' (' + books.length + '권, ' + genStamp() + ')');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
