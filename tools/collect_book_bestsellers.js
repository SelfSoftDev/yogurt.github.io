// 베스트셀러끝판왕(book) 서점 3사 수집기 — GitHub Actions에서 매일 실행.
//  · 소스가 무겁고 순차 2회 왕복이라 앱에서 느림(실측: yes24 861KB, 알라딘 344~403KB,
//    교보 스토어페이지 159KB + API). 미리 파싱해 작은 JSON으로 제공 → 앱은 1fetch.
//  · 파싱 규칙은 앱 렌더러(ygt_culture_book1/2/3.js)와 동일한 split — 개편 시 여기만 수정.
//  · 출력(각 서점별 파일):
//    book/kyobo.json  {dateKey, generated, week|month|year:{optionsHtml, ymw, dateTxt, books[]}}
//    book/yes24.json  {dateKey, generated, day|week|month:{selects{...}, dateTxt, books[]}}
//    book/aladin.json {dateKey, generated, week|month:{year,month,week?, dateTxt, books[]}}
//      (알라딘 실시간 NowBest는 별도 수집기 collect_aladin_now.js — 30분 크론 스냅샷)
//  · --if-missing: 오늘(KST) 이미 수집됐으면 스킵 (캐치업 크론용)
//
// 사용: node collect_book_bestsellers.js [출력폴더=book] [--if-missing]
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const DIR = _args.filter(a => !a.startsWith('--'))[0] || 'book';
const IF_MISSING = _args.includes('--if-missing');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 교보 스토어 API 키 (앱 ygt_culture_book1.js에 이미 공개된 값 — 로테이션 시 양쪽 갱신)
const KYOBO_KEY = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..hHq0YmVZEzhFd30k.4XrLEzshePYwplLeR0nEaLoauU8dpiEj9iuO7M3rPUhSSpBE4gRVmWafyOsEcIG6YIIn7qYU7Kwv9NCI9ODiU4imO7Adl08IQz4_R27g70uLyL0Ar6K28IefA3IPdPcqE3YWB9pj.eNLP2o2FndVu5DUH6W-EeA';

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

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function dateKey() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); }
function genStamp() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST'; }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function decodeEnt(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// ---------------------------------------------------------------- 교보문고
// 앱 selectParser/kyoboParser(ygt_culture_book1.js)와 동일 규칙
async function collectKyobo() {
  const types = [
    { type: 'week', page: 'https://store.kyobobook.co.kr/bestseller/total/weekly', period: '002' },
    { type: 'month', page: 'https://store.kyobobook.co.kr/bestseller/total/monthly', period: '003' },
    { type: 'year', page: 'https://store.kyobobook.co.kr/bestseller/total/annual', period: '004' },
  ];
  const out = {};
  for (const t of types) {
    const html = await get(t.page);
    const result = html.split('weekDateList')[1].split('[')[1].split(']')[0];
    const $select = result.split('{');
    let opts = [];
    for (let i = 1; i < $select.length; i++) {
      const sttgDate = $select[i].split('sttgDate')[1].split('"')[2].split('\\')[0];
      const endDate = $select[i].split('endDate')[1].split('"')[2].split('\\')[0];
      const sttgWeekNum = $select[i].split('sttgWeekNum')[1].split('"')[2].split('\\')[0];
      opts.push({ val: sttgWeekNum, txt: sttgDate.slice(0, 4) + '.' + sttgDate.slice(4, 6) + '.' + sttgDate.slice(6) + ' ~ ' + endDate.slice(0, 4) + '.' + endDate.slice(4, 6) + '.' + endDate.slice(6) });
    }
    if (t.type === 'year') opts = opts.slice(1); // 앱과 동일: 연간은 첫 항목(진행중 연도) 제외
    if (!opts.length) throw new Error('kyobo ' + t.type + ': 기간목록 없음');
    const ymw = opts[0].val;
    const api = 'https://store.kyobobook.co.kr/api/gw/best/best-seller/total?page=1&per=50&period=' + t.period + '&bsslBksClstCode=A&ymw=' + ymw;
    const j = JSON.parse(await get(api, { 'accept': 'application/json', 'x-api-gw-key': KYOBO_KEY }));
    const books = (j.data.bestSeller || []).map(r => ({
      link: 'https://product.kyobobook.co.kr/detail/' + r.saleCmdtid,
      img: 'https://contents.kyobobook.co.kr/sih/fit-in/142x0/pdt/' + r.cmdtCode + '.jpg',
      rank: r.prstRnkn, title: r.cmdtName, name: r.chrcName, com: r.pbcmName, date: r.rlseDate,
    }));
    if (books.length < 20) throw new Error('kyobo ' + t.type + ': 목록 부족(' + books.length + ')');
    let dateTxt = '';
    if (t.type === 'week') dateTxt = ymw.substring(0, 4) + '년 ' + ymw.substring(4, 6) + '월 ' + ymw.substring(6) + '주';
    else if (t.type === 'month') dateTxt = ymw.substring(0, 4) + '년 ' + ymw.substring(4, 6) + '월';
    else dateTxt = ymw.substring(0, 4) + '년';
    out[t.type] = {
      optionsHtml: opts.map(o => '<option value="' + o.val + '">' + o.txt + '</option>').join(''),
      ymw, dateTxt, books,
    };
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

// ---------------------------------------------------------------- YES24
// 앱 selectParser/dataParser(ygt_culture_book2.js)와 동일 규칙 (최신=디폴트 페이지)
function yes24Books(html) {
  const result = html.split('<li class="" data-goods-no="');
  const books = [];
  for (let i = 1; i < result.length; i++) {
    try {
      books.push({
        id: result[i].split('">')[0],
        rank: result[i].split('<em class="ico rank">')[1].split('</em>')[0],
        link: 'http://www.yes24.com' + result[i].split('<a href="')[1].split('" ')[0],
        img: result[i].split('data-original="')[1].split('"')[0],
        title: decodeEnt(result[i].split('alt="')[1].split('"')[0]),
        name: result[i].split('authPub info_auth')[1].split('">')[2].split('</a>')[0],
        com: result[i].split('authPub info_pub')[1].split('">')[2].split('</a>')[0].trim(),
        date: result[i].split('authPub info_date')[1].split('">')[1].split('<')[0].trim(),
      });
    } catch (e) { /* 행 구조 다르면 스킵 */ }
  }
  return books;
}
function selectedTxt(optHtml) { // fragment에서 selected 옵션의 value/text
  const m = optHtml.match(/<option[^>]*selected[^>]*value="([^"]*)"[^>]*>([^<]*)</i)
    || optHtml.match(/<option[^>]*value="([^"]*)"[^>]*selected[^>]*>([^<]*)</i)
    || optHtml.match(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</i);
  return m ? { val: m[1], txt: m[2].trim() } : { val: '', txt: '' };
}
async function collectYes24() {
  const types = [
    { type: 'day', url: 'https://www.yes24.com/product/category/daybestseller?categoryNumber=001&pageNumber=1&pageSize=50&type=day' },
    { type: 'week', url: 'https://www.yes24.com/product/category/weekbestseller?categoryNumber=001&pageNumber=1&pageSize=50&type=week' },
    { type: 'month', url: 'https://www.yes24.com/product/category/monthbestseller?categoryNumber=001&pageNumber=1&pageSize=50&type=month' },
  ];
  const out = {};
  for (const t of types) {
    const html = await get(t.url);
    const books = yes24Books(html);
    if (books.length < 20) throw new Error('yes24 ' + t.type + ': 목록 부족(' + books.length + ')');
    let selects = {}, dateTxt = '';
    if (t.type === 'day') {
      selects = {
        year: html.split('data-search-type="saleDts">')[1].split('</select>')[0],
        month: html.split('data-search-type="saleDts">')[2].split('</select>')[0],
        day: html.split('data-search-type="saleDts">')[3].split('</select>')[0],
      };
      dateTxt = selectedTxt(selects.year).val + '년 ' + (selectedTxt(selects.month).val * 1) + '월 ' + (selectedTxt(selects.day).val * 1) + '일';
    } else if (t.type === 'week') {
      selects = {
        year: html.split('data-search-type="saleYear">')[1].split('</select>')[0],
        week: html.split('data-search-type="weekNo">')[1].split('</select>')[0],
      };
      dateTxt = selectedTxt(selects.year).val + '년 ' + selectedTxt(selects.week).txt;
    } else {
      selects = {
        year: html.split('data-search-type="saleYear">')[1].split('</select>')[0],
        month: html.split('data-search-type="saleMonth">')[1].split('</select>')[0],
      };
      dateTxt = selectedTxt(selects.year).val + '년 ' + (selectedTxt(selects.month).val * 1) + '월';
    }
    out[t.type] = { selects, dateTxt, books };
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

// ---------------------------------------------------------------- 알라딘 (주간/월간만 — 실시간은 앱 라이브+캐시)
// 앱 selectParser/dataParser(ygt_culture_book3.js)와 동일 규칙
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
async function collectAladin() {
  const out = {};
  // 주간: 디폴트 페이지에서 현재 연/월/주 추출 (앱과 동일 split)
  const wHtml = await get('https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=Bestseller');
  const wYear = wHtml.split("hDisplayHide('Layer_Year')")[1].split('">')[1].split('년')[0].trim();
  const wMonth = wHtml.split("hDisplayHide('Layer_Month')")[1].split('">')[1].split('월')[0].trim();
  const wWeek = wHtml.split("hDisplayHide('Layer_Week')")[1].split('">')[1].split('주')[0].trim();
  const wBooks = aladinBooks(wHtml);
  if (wBooks.length < 20) throw new Error('aladin week: 목록 부족(' + wBooks.length + ')');
  out.week = { year: wYear, month: wMonth, week: wWeek, dateTxt: wYear + '년 ' + wMonth + '월 ' + wWeek + '주', books: wBooks };
  await new Promise(r => setTimeout(r, 400));
  // 월간
  const mHtml = await get('https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=MonthlyBest');
  const mYear = mHtml.split("hDisplayHide('Layer_Year')")[1].split('">')[1].split('년')[0].trim();
  const mMonth = mHtml.split("hDisplayHide('Layer_Month')")[1].split('">')[1].split('월')[0].trim();
  const mBooks = aladinBooks(mHtml);
  if (mBooks.length < 20) throw new Error('aladin month: 목록 부족(' + mBooks.length + ')');
  out.month = { year: mYear, month: mMonth, dateTxt: mYear + '년 ' + mMonth + '월', books: mBooks };
  return out;
}

// ----------------------------------------------------------------
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const today = dateKey();
  const stores = [
    { file: 'kyobo.json', label: '교보문고', fn: collectKyobo },
    { file: 'yes24.json', label: 'YES24', fn: collectYes24 },
    { file: 'aladin.json', label: '알라딘', fn: collectAladin },
  ];
  let okCount = 0, failCount = 0;
  for (const s of stores) {
    const file = path.join(DIR, s.file);
    const prev = readJson(file);
    if (IF_MISSING && prev && prev.dateKey === today) { console.log(s.label + ': 오늘 이미 수집됨 — 스킵(--if-missing)'); okCount++; continue; }
    try {
      const data = await s.fn();
      fs.writeFileSync(file, JSON.stringify(Object.assign({ dateKey: today, generated: genStamp() }, data)));
      const sizes = Object.keys(data).map(k => k + '=' + data[k].books.length + '권').join(', ');
      console.log(s.label + ' 저장: ' + file + ' (' + sizes + ')');
      okCount++;
    } catch (e) {
      console.error(s.label + ' 수집 실패(기존 파일 유지): ' + e.message);
      failCount++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  // 셋 다 실패했을 때만 잡 실패(재시도 유도) — 부분 실패는 기존 파일 유지로 무해
  if (okCount === 0 && failCount > 0) process.exit(1);
})();
