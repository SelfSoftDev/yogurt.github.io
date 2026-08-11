// car 국내 월간 판매 수집 — GitHub Actions 일 1회 (0901 국산/수입 최신월 스냅샷).
//  · 소스가 월 단위 갱신이라 최신월만 수집 — 과거월 조회는 앱이 기존 라이브 크롤 폴백.
//  · 파싱 규칙 = 앱 렌더러(ygt_car_kor_month.js)와 동일 split.
//  · dateKey는 매 실행 갱신(변경 없어도 커밋) — 앱의 "최근 수집분" 신선도 판정용.
//  · 출력: car/month.json {dateKey, generated, kor:{ym,label,items[50]}, imp:{ym,label,items[50]}}
//
// 사용: node collect_car_month.js [출력파일=car/month.json]
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const OUT = process.argv[2] || 'car/month.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function req(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko', 'Accept-Encoding': 'gzip' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && (opts._redir || 0) < 3) {
        res.resume();
        return resolve(req(new URL(res.headers.location, url).href, Object.assign({}, opts, { _redir: (opts._redir || 0) + 1 })));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + u.hostname)); }
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
    });
    r.on('error', reject);
    r.on('timeout', function () { r.destroy(new Error('timeout ' + u.hostname)); });
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

const BASE = 'https://auto.danawa.com/auto/';
const BRAND_K = '303,304,307,312,316,326,321,322,337';
const BRAND_F = '362,349,371,376,413,422,459,367,394,399,381,440,390,385,358,427,491,486,514,509,500,610,569,573,546,587,611,583';

// 렌더러와 동일 split 파싱
function carItems(html) {
  const result = html.split("<td><input type='checkbox'");
  const items = [];
  for (let i = 1; i < result.length && items.length < 50; i++) {
    try {
      items.push({
        title: result[i].split("title='")[1].split("'")[0].trim(),
        bcode: result[i].split("brand='")[1].split("'")[0].trim(),
        rank: result[i].split("<td class='rank'>")[1].split('</td>')[0].trim(),
        img: result[i].split("<img src='")[1].split("'")[0].trim(),
        sale: result[i].split("<td class='num'>")[1].split('<button')[0].trim(),
        share: result[i].split("<td class='rate right'>")[1].split('</td>')[0].trim(),
      });
    } catch (e) { /* 행 파싱 실패는 건너뜀 */ }
  }
  return items;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // 1) 최신 집계월 감지 (국산/수입 별도)
  const front = await req(BASE + '?Work=record');
  const yK = Number(front.split("<div class='cmnt'>국산차 ")[1].split('년')[0].trim());
  const mK = Number(front.split("<div class='cmnt'>국산차 ")[1].split('년')[1].split('월')[0].trim());
  const yF = Number(front.split("<div class='cmnt'>해외차 ")[1].split('년')[0].trim());
  const mF = Number(front.split("<div class='cmnt'>해외차 ")[1].split('년')[1].split('월')[0].trim());
  if (!yK || !mK || !yF || !mF) throw new Error('최신월 감지 실패');

  const out = { dateKey: dateKey(), generated: genStamp() };

  // 2) 국산 최신월
  await sleep(700);
  const htmlK = await req(BASE + '?pcUse=y&Work=record&Brand=' + BRAND_K + '&Month=' + yK + '-' + p2(mK) + '-00');
  const itemsK = carItems(htmlK);
  if (itemsK.length < 30) throw new Error('국산 파싱 부족: ' + itemsK.length);
  out.kor = { ym: '' + yK + p2(mK), label: yK + '년 ' + p2(mK) + '월', items: itemsK };

  // 3) 수입 최신월
  await sleep(700);
  const htmlF = await req(BASE + '?pcUse=y&Work=record&Tab=Model&Brand=' + BRAND_F + '&Month=' + yF + '-' + p2(mF) + '-00');
  const itemsF = carItems(htmlF);
  if (itemsF.length < 30) throw new Error('수입 파싱 부족: ' + itemsF.length);
  out.imp = { ym: '' + yF + p2(mF), label: yF + '년 ' + p2(mF) + '월', items: itemsF };

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (kor ' + out.kor.ym + '=' + itemsK.length + ', imp ' + out.imp.ym + '=' + itemsF.length + ', ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
