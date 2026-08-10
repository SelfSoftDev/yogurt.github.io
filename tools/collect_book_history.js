// 베스트셀러끝판왕(book) 주간 순위 이력 수집기 — 통합 인기순위/급상승/신규/스테디용.
//  · 3사 주간 Top 50 × 최근 N주(기본 12주 백필, 이후 매일 실행하며 현재 주만 갱신·누적 최대 52주).
//  · periodKey = 교보 ymw(YYYYMM+월중주차, 예 2026081). 주 정렬은 "최근 i번째 주" 인덱스 기준
//    (서점별 주 경계가 하루쯤 다를 수 있으나 3사 모두 주 단위 연속이라 인덱스 정렬이 일관적).
//    yes24는 연중 주차(weekNo) — 현재 주차에서 i를 빼며 역산(연 경계는 전년 마지막 주차 프로브).
//  · 상태: RANKED(정상) / SOURCE_ERROR(수집·파싱 실패) — 실패 주는 기존 값 유지, 없으면 상태만 기록.
//    앱은 SOURCE_ERROR를 0점 처리하지 않고 "임시 집계"로 표시한다.
//  · 용량: 최신 주는 전체 필드, 과거 주는 슬림 {r,t,n}만 (제목·저자면 workId 매칭에 충분).
//  · 교보 항목은 img URL의 ISBN-13을 isbn 필드로 보존 (1차 식별자).
//  · 출력: book/history.json {dateKey, generated, weeks:[{periodKey, weekStart, label, stores:{...}}] 최신순}
//
// 사용: node collect_book_history.js [출력파일=book/history.json] [--weeks=12] [--if-missing]
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'book/history.json';
const BACKFILL = parseInt((_args.find(a => a.startsWith('--weeks=')) || '').split('=')[1] || '12', 10);
const IF_MISSING = _args.includes('--if-missing');
const MAX_WEEKS = 52;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 교보 스토어 API 게이트웨이 키(교보 웹페이지가 모든 브라우저에 내려주는 공개값).
// 사본 중복 방지: 같은 폴더의 collect_book_bestsellers.js에 있는 값을 런타임에 읽는다.
const KYOBO_KEY = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'collect_book_bestsellers.js'), 'utf8');
  const m = src.match(/KYOBO_KEY\s*=\s*'([^']+)'/);
  if (!m) throw new Error('collect_book_bestsellers.js에서 KYOBO_KEY를 찾지 못함');
  return m[1];
})();

function get(url, headers, redirects) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko' }, headers || {}),
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, headers, (redirects || 0) + 1));
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function dateKey() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); }
function genStamp() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST'; }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function decodeEnt(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// ------------------------------------------------ 교보: 주간 기간목록 + 주별 Top50
async function kyoboWeekList() { // [{ymw, sttgDate, endDate}] 최신순
  const html = await get('https://store.kyobobook.co.kr/bestseller/total/weekly');
  const result = html.split('weekDateList')[1].split('[')[1].split(']')[0];
  const $select = result.split('{');
  const list = [];
  for (let i = 1; i < $select.length; i++) {
    const sttgDate = $select[i].split('sttgDate')[1].split('"')[2].split('\\')[0];
    const endDate = $select[i].split('endDate')[1].split('"')[2].split('\\')[0];
    const ymw = $select[i].split('sttgWeekNum')[1].split('"')[2].split('\\')[0];
    list.push({ ymw, sttgDate, endDate });
  }
  if (!list.length) throw new Error('kyobo: 주간 기간목록 없음');
  return list;
}
async function kyoboWeek(ymw) {
  const api = 'https://store.kyobobook.co.kr/api/gw/best/best-seller/total?page=1&per=50&period=002&bsslBksClstCode=A&ymw=' + ymw;
  const j = JSON.parse(await get(api, { 'accept': 'application/json', 'x-api-gw-key': KYOBO_KEY }));
  const items = (j.data.bestSeller || []).map(r => ({
    rank: r.prstRnkn, title: r.cmdtName, name: r.chrcName, com: r.pbcmName, date: r.rlseDate,
    img: 'https://contents.kyobobook.co.kr/sih/fit-in/142x0/pdt/' + r.cmdtCode + '.jpg',
    link: 'https://product.kyobobook.co.kr/detail/' + r.saleCmdtid,
    isbn: /^97[89]\d{10}$/.test(String(r.cmdtCode)) ? String(r.cmdtCode) : undefined,
  }));
  if (items.length < 20) throw new Error('kyobo ' + ymw + ': 목록 부족(' + items.length + ')');
  return items;
}

// ------------------------------------------------ YES24: 현재 주차 + 주별 Top50
function yes24Books(html) {
  const result = html.split('<li class="" data-goods-no="');
  const books = [];
  for (let i = 1; i < result.length; i++) {
    try {
      books.push({
        rank: parseInt(result[i].split('<em class="ico rank">')[1].split('</em>')[0], 10),
        link: 'http://www.yes24.com' + result[i].split('<a href="')[1].split('" ')[0],
        img: result[i].split('data-original="')[1].split('"')[0],
        title: decodeEnt(result[i].split('alt="')[1].split('"')[0]),
        name: result[i].split('authPub info_auth')[1].split('">')[2].split('</a>')[0],
        com: result[i].split('authPub info_pub')[1].split('">')[2].split('</a>')[0].trim(),
        date: result[i].split('authPub info_date')[1].split('">')[1].split('<')[0].trim(),
      });
    } catch (e) { /* 스킵 */ }
  }
  return books;
}
async function yes24Current() { // {saleYear, weekNo}
  const html = await get('https://www.yes24.com/product/category/weekbestseller?categoryNumber=001&pageNumber=1&pageSize=50&type=week');
  const yearOpt = html.split('data-search-type="saleYear">')[1].split('</select>')[0];
  const weekOpt = html.split('data-search-type="weekNo">')[1].split('</select>')[0];
  const sel = o => { const m = o.match(/<option[^>]*selected[^>]*value="([^"]*)"/i) || o.match(/<option[^>]*value="([^"]*)"[^>]*selected/i) || o.match(/<option[^>]*value="([^"]*)"/i); return m ? m[1] : ''; };
  const saleYear = parseInt(sel(yearOpt), 10), weekNo = parseInt(sel(weekOpt), 10);
  if (!saleYear || !weekNo) throw new Error('yes24: 현재 주차 파싱 실패');
  return { saleYear, weekNo };
}
async function yes24Week(saleYear, weekNo) {
  const url = 'https://www.yes24.com/Product/Category/BestSellerContents?categoryNumber=001&pageNumber=1&pageSize=50&bestType=WEEK_BESTSELLER&type=week&saleYear=' + saleYear + '&weekNo=' + weekNo;
  const items = yes24Books(await get(url));
  if (items.length < 20) throw new Error('yes24 ' + saleYear + '/' + weekNo + ': 목록 부족(' + items.length + ')');
  return items;
}
// 연 경계 역산: weekNo<=0이면 전년 53→52 프로브
async function yes24WeekAt(cur, back) {
  let y = cur.saleYear, w = cur.weekNo - back;
  if (w >= 1) return yes24Week(y, w);
  for (const lastW of [53, 52]) {
    try { return await yes24Week(y - 1, lastW + w); } catch (e) { /* 다음 후보 */ }
  }
  throw new Error('yes24: 전년 주차 역산 실패');
}

// ------------------------------------------------ 알라딘: 주별 Top50 (교보 ymw의 연/월/주 재사용)
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
    } catch (e) { /* 스킵 */ }
  }
  return books;
}
async function aladinWeek(ymw) {
  const y = ymw.substring(0, 4), m = parseInt(ymw.substring(4, 6), 10), w = parseInt(ymw.substring(6), 10);
  const url = 'https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&CID=0&Year=' + y + '&Month=' + m + '&Week=' + w + '&BestType=Bestseller&SearchSubBarcode=';
  const items = aladinBooks(await get(url));
  if (items.length < 20) throw new Error('aladin ' + ymw + ': 목록 부족(' + items.length + ')');
  return items;
}

// ------------------------------------------------ 슬림/스토어 수집
function slim(items) { return items.map(b => ({ r: b.rank, t: b.title, n: b.name })); }
async function collectStores(kw, yes24Cur, backIdx, full) {
  const stores = {};
  const jobs = [
    ['kyobo', () => kyoboWeek(kw.ymw)],
    ['yes24', () => yes24WeekAt(yes24Cur, backIdx)],
    ['aladin', () => aladinWeek(kw.ymw)],
  ];
  for (const [store, fn] of jobs) {
    try {
      const items = await fn();
      stores[store] = { status: 'RANKED', items: full ? items : slim(items) };
    } catch (e) {
      console.error('  ' + store + ' ' + kw.ymw + ' 실패: ' + e.message);
      stores[store] = { status: 'SOURCE_ERROR', items: [] };
    }
    await sleep(400);
  }
  return stores;
}

// ----------------------------------------------------------------
(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const prev = readJson(OUT);
  const kWeeks = await kyoboWeekList();
  const latest = kWeeks[0];

  // --if-missing: 최신 주가 이미 3사 RANKED로 있으면 스킵
  if (IF_MISSING && prev && prev.weeks && prev.weeks[0] && prev.weeks[0].periodKey === latest.ymw
    && ['kyobo', 'yes24', 'aladin'].every(s => prev.weeks[0].stores[s] && prev.weeks[0].stores[s].status === 'RANKED')) {
    console.log('현재 주(' + latest.ymw + ') 이미 완비 — 스킵(--if-missing)');
    return;
  }

  const yes24Cur = await yes24Current();
  const prevWeeks = (prev && prev.weeks) || [];
  const prevByKey = {};
  prevWeeks.forEach(w => { prevByKey[w.periodKey] = w; });

  const wantCount = prevWeeks.length ? Math.max(prevWeeks.length, 1) : BACKFILL;
  const weeks = [];
  for (let i = 0; i < Math.min(kWeeks.length, MAX_WEEKS); i++) {
    const kw = kWeeks[i];
    const existing = prevByKey[kw.ymw];
    const isLatest = i === 0;
    // 기존에 3사 완비면 재수집 안 함 (최신 주는 항상 재확인)
    if (existing && !isLatest && ['kyobo', 'yes24', 'aladin'].every(s => existing.stores[s] && existing.stores[s].status === 'RANKED')) {
      weeks.push(existing);
      continue;
    }
    // 신규 백필 범위 제한: 기존 파일이 있으면 기존 주 + 최신 주만, 없으면 BACKFILL주
    if (!existing && !isLatest && weeks.length >= wantCount) break;
    if (!existing && !isLatest && i >= BACKFILL) break;
    console.log((isLatest ? '[최신] ' : '[백필] ') + kw.ymw + ' (' + kw.sttgDate + '~' + kw.endDate + ') 수집...');
    const stores = await collectStores(kw, yes24Cur, i, isLatest);
    // 실패 스토어는 기존 값 유지
    if (existing) {
      for (const s of ['kyobo', 'yes24', 'aladin']) {
        if (stores[s].status !== 'RANKED' && existing.stores[s] && existing.stores[s].status === 'RANKED') stores[s] = existing.stores[s];
      }
    }
    weeks.push({
      periodKey: kw.ymw, weekStart: kw.sttgDate,
      label: kw.ymw.substring(0, 4) + '년 ' + parseInt(kw.ymw.substring(4, 6), 10) + '월 ' + kw.ymw.substring(6) + '주',
      stores,
    });
  }
  // 최신 주가 과거 슬림으로 강등되도록: 이전 최신 주가 이번에 index>0이 되면 슬림화
  for (let i = 1; i < weeks.length; i++) {
    for (const s of ['kyobo', 'yes24', 'aladin']) {
      const st = weeks[i].stores[s];
      if (st && st.items && st.items.length && st.items[0].rank !== undefined) st.items = slim(st.items);
    }
  }

  const rankedCount = weeks.filter(w => ['kyobo', 'yes24', 'aladin'].every(s => w.stores[s] && w.stores[s].status === 'RANKED')).length;
  if (!weeks.length || (weeks[0] && ['kyobo', 'yes24', 'aladin'].every(s => weeks[0].stores[s].status !== 'RANKED'))) {
    console.error('최신 주 전체 실패 — 기존 파일 유지'); process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify({ dateKey: dateKey(), generated: genStamp(), weeks: weeks.slice(0, MAX_WEEKS) }));
  console.log('저장: ' + OUT + ' (' + weeks.length + '주, 3사 완비 ' + rankedCount + '주, ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
