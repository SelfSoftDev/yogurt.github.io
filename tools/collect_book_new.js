// 서점 3사 신간 수집기 — GitHub Actions 매일 실행. API 키 불필요 (교보 키는 웹 공개 게이트웨이값 재사용).
//  · 용도: ① 각 서점 페이지 "신간" 탭 (gh 우선 + 라이브 폴백) ② 찜한 작가 신간 매칭 알림.
//  · 교보: api/gw/pdt/v2/newest/md-pick/list — 깨끗한 JSON (isbn·출간일 포함).
//    weekth(연+월+월중주차)를 이번 주~3주 전까지 프로브해 병합 (주 초반엔 당주 데이터가 적음).
//  · YES24: product/category/newproduct (베스트셀러와 동일 li 마크업 → 동일 split).
//  · 알라딘: wnew.aspx SpecialNew(주목 신간) — 베스트셀러와 동일 ss_book_box 마크업.
//  · 출력: book/new_releases.json {dateKey, generated, kyobo|yes24|aladin:{status,items[]}}
//    items: {title, name, com, date, img, link, isbn?} (신간이라 rank 없음 — 앱이 순번 표시)
//  · 부분 실패 = 해당 서점만 SOURCE_ERROR + 기존 값 유지. --if-missing: 오늘 수집분 있으면 스킵.
//
// 사용: node collect_book_new.js [출력파일=book/new_releases.json] [--if-missing]
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'book/new_releases.json';
const IF_MISSING = _args.includes('--if-missing');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 교보 스토어 API 게이트웨이 키 — collect_book_bestsellers.js의 공개값 재사용 (사본 중복 방지)
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

// ---------------------------------------------------------------- 교보 (newest API)
// weekth = 연 + 월 + 월중주차(ceil(일/7)). 이번 주 포함 최근 4주 프로브 → 병합.
function weekthCandidates() {
  const out = [];
  for (let back = 0; back < 4; back++) {
    const d = new Date(kstNow().getTime() - back * 7 * 86400000);
    const p = n => (n < 10 ? '0' : '') + n;
    out.push('' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + Math.ceil(d.getUTCDate() / 7));
  }
  return [...new Set(out)];
}
async function collectKyobo() {
  const seen = {};
  const items = [];
  for (const w of weekthCandidates()) {
    let page = 1, total = 0;
    do {
      const api = 'https://store.kyobobook.co.kr/api/gw/pdt/v2/newest/md-pick/list?page=' + page + '&per=50&sort=rec&saleCmdtDvsnCode=KOR&soldOutExcludeYn=N&weekth=' + w;
      const j = JSON.parse(await get(api, { 'accept': 'application/json', 'x-api-gw-key': KYOBO_KEY }));
      total = (j.data && j.data.totalCount) || 0;
      const list = (j.data && j.data.newestList) || [];
      for (const row of list) {
        const r = row.productInfo || row;
        if (!r.saleCmdtid || seen[r.saleCmdtid]) continue;
        seen[r.saleCmdtid] = 1;
        items.push({
          title: r.cmdtName, name: r.chrcName || '', com: r.pbcmName || '', date: r.rlseDate || '',
          img: 'https://contents.kyobobook.co.kr/sih/fit-in/142x0/pdt/' + r.cmdtcode + '.jpg',
          link: 'https://product.kyobobook.co.kr/detail/' + r.saleCmdtid,
          isbn: /^97[89]\d{10}$/.test(String(r.cmdtcode)) ? String(r.cmdtcode) : undefined,
        });
      }
      page++;
      await sleep(300);
    } while ((page - 1) * 50 < Math.min(total, 100)); // 주당 최대 100권
    await sleep(300);
  }
  if (items.length < 10) throw new Error('kyobo 신간: 목록 부족(' + items.length + ')');
  // 출간일 내림차순 (최신 먼저)
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return items;
}

// ---------------------------------------------------------------- YES24 (신간 코너, 베스트셀러와 동일 마크업)
function yes24Books(html) {
  const result = html.split('<li class="" data-goods-no="');
  const books = [];
  for (let i = 1; i < result.length; i++) {
    try {
      books.push({
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
async function collectYes24() {
  const html = await get('https://www.yes24.com/product/category/newproduct?categoryNumber=001&pageNumber=1&pageSize=100');
  const items = yes24Books(html);
  if (items.length < 10) throw new Error('yes24 신간: 목록 부족(' + items.length + ')');
  return items;
}

// ---------------------------------------------------------------- 알라딘 (주목 신간, 베스트셀러와 동일 마크업)
function aladinBooks(html) {
  const resultAll = html.split('<div class="megaseller_clbox megaseller_sp2">')[1] || html;
  const result = resultAll.split('<div class="ss_book_box" itemId="');
  const books = [];
  for (let i = 1; i < result.length; i++) {
    try {
      const b = {
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
async function collectAladin() {
  const html = await get('https://www.aladin.co.kr/shop/common/wnew.aspx?BranchType=1&NewType=SpecialNew');
  const items = aladinBooks(html);
  if (items.length < 10) throw new Error('aladin 신간: 목록 부족(' + items.length + ')');
  return items;
}

// ----------------------------------------------------------------
(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const prev = readJson(OUT);
  const today = dateKey();
  if (IF_MISSING && prev && prev.dateKey === today) { console.log('오늘 이미 수집됨 — 스킵(--if-missing)'); return; }

  const out = { dateKey: today, generated: genStamp() };
  const stores = [['kyobo', collectKyobo], ['yes24', collectYes24], ['aladin', collectAladin]];
  let okCount = 0;
  for (const [store, fn] of stores) {
    try {
      const items = await fn();
      out[store] = { status: 'RANKED', items };
      console.log(store + ': ' + items.length + '권');
      okCount++;
    } catch (e) {
      console.error(store + ' 실패(기존 값 유지): ' + e.message);
      out[store] = (prev && prev[store] && prev[store].status === 'RANKED') ? prev[store] : { status: 'SOURCE_ERROR', items: [] };
    }
    await sleep(500);
  }
  if (!okCount) { console.error('전 서점 실패 — 기존 파일 유지'); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
