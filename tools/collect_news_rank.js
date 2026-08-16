// news 많이 본 뉴스 랭킹 수집 — GitHub Actions 1시간 주기.
//  · 네이트 랭킹(많이 본, EUC-KR)을 TextDecoder로 디코드 후 mlt01 블록 파싱.
//  · 종합 TOP 30 + 섹션 5종(정치/경제/사회/스포츠/연예) TOP 10.
//  · 출력: news/rank.json {t, dateKey, generated, sections:{all|pol|eco|soc|spo|ent:[{r,t,p,l,i}]}}
//
// 사용: node collect_news_rank.js [출력파일=news/rank.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = process.argv[2] || 'news/rank.json';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const SECTIONS = [['all', 30], ['pol', 10], ['eco', 10], ['soc', 10], ['spo', 10], ['ent', 10]];

function getEucKr(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        try { resolve(new TextDecoder('euc-kr').decode(Buffer.concat(ch))); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

function parseRank(html, limit) {
  const items = [];
  // 1~5위: 리치 블록(mlt01 — 제목/언론사/썸네일)
  const chunks = html.split('<div class="mlt01">');
  for (let i = 1; i < chunks.length && items.length < limit; i++) {
    const c = chunks[i];
    try {
      let link = (c.split('href="')[1] || '').split('"')[0];
      if (link.startsWith('//')) link = 'https:' + link;
      const title = strip((c.split('class="tit">')[1] || '').split('</h2>')[0]);
      const medium = (c.split('class="medium">')[1] || '').split('</span>')[0];
      const press = strip(medium.split('<em>')[0]);
      let img = (c.split('<img src="')[1] || '').split('"')[0];
      if (img.startsWith('//')) img = 'https:' + img;
      if (!title || !link) continue;
      items.push({ r: items.length + 1, t: title, p: press, l: link, i: img || '' });
    } catch (e) { /* skip */ }
  }
  // 6위~: 제목 리스트(postRankSubject)
  const post = html.split('id="postRankSubject"')[1] || '';
  const lis = post.split('<li>');
  for (let i = 1; i < lis.length && items.length < limit; i++) {
    const c = lis[i];
    try {
      let link = (c.split('href="')[1] || '').split('"')[0];
      if (link.startsWith('//')) link = 'https:' + link;
      const title = strip((c.split('<h2>')[1] || '').split('</h2>')[0]);
      if (!title || !link) continue;
      items.push({ r: items.length + 1, t: title, p: '', l: link, i: '' });
    } catch (e) { /* skip */ }
  }
  return items;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = { t: Date.now(), dateKey: dateKey(), generated: genStamp(), sections: {} };
  let ok = 0;

  for (const [sc, limit] of SECTIONS) {
    try {
      const html = await getEucKr('https://news.nate.com/rank/interest?sc=' + sc + '&p=day');
      const items = parseRank(html, limit);
      if (items.length < Math.min(limit, 8)) throw new Error('items ' + items.length);
      out.sections[sc] = items;
      ok++;
    } catch (e) { console.error(sc + ' 실패: ' + e.message); }
    await sleep(400);
  }

  if (!out.sections.all || ok < 4) throw new Error('수집 부족 (' + ok + '/6)');
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + ok + '/6 섹션, 종합 ' + out.sections.all.length + '건, ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
