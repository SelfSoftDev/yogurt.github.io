// news 많이 본 뉴스 랭킹 수집 — GitHub Actions 1시간 주기.
//  · 네이트 랭킹(많이 본, EUC-KR)을 TextDecoder로 디코드 후 mlt01 블록 파싱.
//  · 종합 TOP 30 + 섹션 5종(정치/경제/사회/스포츠/연예) TOP 10.
//  · 추가 소스(2026-08-19, 각각 소프트 실패 — 실패 시 해당 키 생략):
//    zum(언론사별 많이 본, 원문 직링크) / yna(공식 RSS 주요기사) / google(뉴스 RSS 주요뉴스).
//  · 출력: news/rank.json {t, dateKey, generated, sections:{...}, zum|yna|google:{basis, items:[{r,t,p,l}]}}
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

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getUtf8(url, ua) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': ua || UA, 'Accept': 'text/html,application/xml,*/*' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => resolve(Buffer.concat(ch).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// zum 홈 '언론사별 가장 많이 본 뉴스' — 서버렌더, 원문(언론사) 직링크 + data-r 순위
function parseZum(html) {
  const sec = (html.split('home_ranking_news')[1] || '').split('</section>')[0];
  const items = [];
  const lis = sec.split('<li>');
  for (let i = 1; i < lis.length; i++) {
    const c = lis[i].replace(/<!--[\s\S]*?-->/g, '');   // 로고 주석 안 </span>이 media 블록을 자름 — 먼저 제거
    let link = (c.split('href="')[1] || '').split('"')[0].replace(/&(amp;)+/g, '&');
    if (!link.startsWith('http')) continue;
    const h2 = (c.split('class="title"')[1] || '').split('</h2>')[0];
    const title = strip(h2.substring(h2.indexOf('>') + 1));
    const media = (c.split('class="media"')[1] || '').split('</span>')[0];
    const press = strip(media.substring(media.indexOf('>') + 1));
    const r = parseInt((c.split('data-r="')[1] || '').split('"')[0], 10) || (items.length + 1);
    if (!title) continue;
    items.push({ r, t: title, p: press, l: link });
  }
  return items;
}

// RSS 공통 — pressFixed 없으면 구글뉴스식 "제목 - 언론사"에서 분리
function parseRss(xml, pressFixed, limit) {
  const items = [];
  const chunks = xml.split('<item>');
  for (let i = 1; i < chunks.length && items.length < limit; i++) {
    const c = chunks[i];
    let title = (c.split('<title>')[1] || '').split('</title>')[0].replace('<![CDATA[', '').replace(']]>', '');
    const link = strip((c.split('<link>')[1] || '').split('</link>')[0].replace('<![CDATA[', '').replace(']]>', ''));
    let press = pressFixed || '';
    if (!pressFixed) {
      const at = title.lastIndexOf(' - ');
      if (at > 0) { press = title.slice(at + 3); title = title.slice(0, at); }
    }
    title = strip(title);
    if (!title || !link.startsWith('http')) continue;
    items.push({ r: items.length + 1, t: title, p: strip(press), l: link });
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

  // 추가 소스 — 하나가 죽어도 나머지·네이트에 영향 없음 (해당 키만 생략)
  const EXTRAS = [
    ['zum', async () => {
      // 모바일 UA는 302(모바일 페이지행) — PC UA 필수
      const items = parseZum(await getUtf8('https://news.zum.com/', UA_PC));
      if (items.length < 8) throw new Error('items ' + items.length);
      return { basis: '언론사별 많이 본 · 최근 1시간', items };
    }],
    ['yna', async () => {
      const items = parseRss(await getUtf8('https://www.yna.co.kr/rss/news.xml'), '연합뉴스', 30);
      if (items.length < 10) throw new Error('items ' + items.length);
      return { basis: '공식 RSS 주요기사', items };
    }],
    ['google', async () => {
      const items = parseRss(await getUtf8('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko'), null, 30);
      if (items.length < 10) throw new Error('items ' + items.length);
      return { basis: '주요 뉴스 RSS', items };
    }],
  ];
  let okx = 0;
  for (const [k, fn] of EXTRAS) {
    try { out[k] = await fn(); okx++; } catch (e) { console.error(k + ' 실패: ' + e.message); }
    await sleep(300);
  }

  if (!out.sections.all || ok < 4) throw new Error('수집 부족 (' + ok + '/6)');
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + ok + '/6 섹션 + 추가 ' + okx + '/3, 종합 ' + out.sections.all.length + '건, ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
