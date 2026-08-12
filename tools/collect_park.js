// 파킹통장(수시입출금) 금리 수집 — GitHub Actions 일 1회 (0402 저축은행 보통예금 탭).
//  · 네이버 블로그(jj976431)의 최신 "(…현재) 수시입출금…종합" 글을 목록 API로 찾아 표를 파싱.
//  · 기존 앱은 글 번호가 고정돼 블로거가 새 글을 올리면 낡은 표를 보여줬음 — 최신 글 자동 추적.
//  · 출력: intrate/park.json {dateKey, generated, srcDate, logNo, items:[{bank,name,rate,aft,limit,age,cond,pay,kind,protect}]}
//
// 사용: node collect_park.js [출력파일=intrate/park.json]
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'intrate/park.json';
const BLOG = 'jj976431';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Referer': 'https://m.blog.naver.com/' + BLOG },
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // 1) 최신 파킹 종합 글 찾기 (목록 2페이지까지)
  let logNo = null, title = '';
  for (let page = 1; page <= 2 && !logNo; page++) {
    const j = JSON.parse(await get('https://m.blog.naver.com/api/blogs/' + BLOG + '/post-list?categoryNo=0&itemCount=30&page=' + page));
    for (const it of (j.result && j.result.items) || []) {
      if (/현재\)/.test(it.titleWithInspectMessage) && /수시입출금/.test(it.titleWithInspectMessage)) {
        logNo = it.logNo; title = it.titleWithInspectMessage; break;
      }
    }
  }
  if (!logNo) throw new Error('최신 파킹 글을 못 찾음');
  console.log('최신 글: ' + logNo + ' — ' + title.slice(0, 50));

  // 2) 본문 표 파싱 (앱 buildSavParkHtml과 동일 규칙)
  const raw = await get('https://m.blog.naver.com/PostView.naver?blogId=' + BLOG + '&logNo=' + logNo + '&proxyReferer=&noTrackingCode=true');
  const ti = raw.search(/<table class="se-table-content"/i);
  if (ti < 0) throw new Error('표 없음');
  const seg = raw.slice(ti, raw.indexOf('</table>', ti));
  const trs = seg.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const cells = tr => (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(td =>
    td.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x?[0-9a-fA-F]+;/g, '').replace(/\s+/g, ' ').trim());

  const items = [];
  for (let i = 1; i < trs.length; i++) {
    const c = cells(trs[i]);
    if (c.length < 4 || !c[0] || !c[1]) continue;
    items.push({
      name: c[0], bank: c[1],
      rate: c[2] ? (/%$/.test(c[2]) ? c[2] : c[2] + '%') : '-',
      aft: c[3] ? (/%$/.test(c[3]) ? c[3] : c[3] + '%') : '',
      limit: c[4] || '', age: c[5] || '', cond: c[6] || '', pay: c[7] || '',
      kind: c[10] || '', protect: c[11] || '',
    });
  }
  if (items.length < 10) throw new Error('행 부족: ' + items.length);

  const srcDate = (title.match(/\(([^)]*?현재)\)/) || [])[1] || '';
  const out = { dateKey: dateKey(), generated: genStamp(), srcDate, logNo: String(logNo), items: items.slice(0, 40) };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + out.items.length + '행, 소스 "' + srcDate + '")');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
