// news 핫뉴스 경량 수집 — GitHub Actions 5분 주기 (AI 요약용 API).
//  · 네이트 많이 본 종합 TOP 30 (EUC-KR) + 구글뉴스 주요 RSS TOP 20, 요청 2회로 최소화.
//  · 출력: news/hot.json {t, dateKey, generated, nate:[{r,t,p,l}], google:[{r,t,p,l}]}
//    — 제목·언론사·링크만 담은 ~15KB 평문 JSON. 소비처: AI 요약(클로드 코드 /news 등).
//  · rank.json(매시, 섹션별)과 별개 파일 — 앱은 rank.json, AI는 hot.json.
//
// 사용: node collect_news_hot.js [출력파일=news/hot.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = process.argv[2] || 'news/hot.json';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

function get(url, enc) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml,*/*' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        try { resolve(enc === 'euc-kr' ? new TextDecoder('euc-kr').decode(Buffer.concat(ch)) : Buffer.concat(ch).toString('utf8')); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

// 네이트 많이 본 (mlt01 리치 블록 + postRankSubject 리스트) — collect_news_rank.js와 동일 파싱
function parseNate(html, limit) {
  const items = [];
  const chunks = html.split('<div class="mlt01">');
  for (let i = 1; i < chunks.length && items.length < limit; i++) {
    const c = chunks[i];
    let link = (c.split('href="')[1] || '').split('"')[0];
    if (link.startsWith('//')) link = 'https:' + link;
    const title = strip((c.split('class="tit">')[1] || '').split('</h2>')[0]);
    const press = strip(((c.split('class="medium">')[1] || '').split('</span>')[0]).split('<em>')[0]);
    if (title && link) items.push({ r: items.length + 1, t: title, p: press, l: link });
  }
  const post = html.split('id="postRankSubject"')[1] || '';
  const lis = post.split('<li>');
  for (let i = 1; i < lis.length && items.length < limit; i++) {
    const c = lis[i];
    let link = (c.split('href="')[1] || '').split('"')[0];
    if (link.startsWith('//')) link = 'https:' + link;
    const title = strip((c.split('<h2>')[1] || '').split('</h2>')[0]);
    if (title && link) items.push({ r: items.length + 1, t: title, p: '', l: link });
  }
  return items;
}

// 구글뉴스 주요 RSS — "제목 - 언론사" 분리
function parseGoogle(xml, limit) {
  const items = [];
  const chunks = xml.split('<item>');
  for (let i = 1; i < chunks.length && items.length < limit; i++) {
    const c = chunks[i];
    let title = (c.split('<title>')[1] || '').split('</title>')[0].replace('<![CDATA[', '').replace(']]>', '');
    const link = strip((c.split('<link>')[1] || '').split('</link>')[0]);
    let press = '';
    const at = title.lastIndexOf(' - ');
    if (at > 0) { press = title.slice(at + 3); title = title.slice(0, at); }
    title = strip(title);
    if (title && link.startsWith('http')) items.push({ r: items.length + 1, t: title, p: strip(press), l: link });
  }
  return items;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = { t: Date.now(), dateKey: dateKey(), generated: genStamp() };
  let ok = 0;
  try {
    const items = parseNate(await get('https://news.nate.com/rank/interest?sc=all&p=day', 'euc-kr'), 30);
    if (items.length < 8) throw new Error('items ' + items.length);
    out.nate = items; ok++;
  } catch (e) { console.error('nate 실패: ' + e.message); }
  try {
    const items = parseGoogle(await get('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko'), 20);
    if (items.length < 8) throw new Error('items ' + items.length);
    out.google = items; ok++;
  } catch (e) { console.error('google 실패: ' + e.message); }

  if (!ok) throw new Error('전 소스 실패');
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + ok + '/2 소스, nate ' + (out.nate ? out.nate.length : 0) + ' + google ' + (out.google ? out.google.length : 0) + '건, ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
