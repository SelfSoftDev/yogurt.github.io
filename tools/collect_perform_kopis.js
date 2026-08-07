// 공연순위끝판왕(perform) KOPIS 박스오피스 수집기 — GitHub Actions에서 매일 실행.
//  · 소스: kopis.or.kr:9001/api/prs/graphql (공연예술통합전산망 웹 GraphQL, 인증 불필요)
//    ※ 구 form POST 방식은 415로 거부됨(2026-08-07 실측) — GraphQL JSON만 동작
//  · 범위: 기간 3종(주간 7일/월간 1개월/연간 1년, 어제 기준) × 장르 7종 = 21건, 각 TOP 50
//  · 출력: perform/kopis.json {dateKey, generated, endDate, w|m|y: {장르코드: [performObj...]}}
//    performObj 필드는 앱 렌더러(ygt_culture_perform1.js uiSetting)와 동일
//  · --if-missing: 오늘(KST) 이미 수집됐으면 스킵
//
// 사용: node collect_perform_kopis.js [출력경로=perform/kopis.json] [--if-missing]
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'perform/kopis.json';
const IF_MISSING = _args.includes('--if-missing');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const GENRES = ['AAAA', 'GGGA', 'CCCA', 'CCCC', 'CCCD', 'BBBC', 'BBBE']; // 연극/뮤지컬/클래식/국악/대중음악/무용/대중무용
const QUERY = `query GetBoxofficeList($startDate: String!, $endDate: String!, $genre_code: String, $STDG_CPSGG_CD: String, $seatScale: String, $rankType: String) {
  boxofficeList(startDate: $startDate endDate: $endDate genre_code: $genre_code STDG_CPSGG_CD: $STDG_CPSGG_CD seatScale: $seatScale rankType: $rankType) {
    result { rnum data1 data2 data3 data8 data9 data10 data11 data12 data13 data14 prfStateNm }
    curDate postDate
  }
}`;

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'kopis.or.kr', port: 9001, path: '/api/prs/graphql', method: 'POST',
      headers: {
        'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body), 'Origin': 'https://www.kopis.or.kr', 'Referer': 'https://www.kopis.or.kr/',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) { const p = n => (n < 10 ? '0' : '') + n; return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); }
function dateKey() { return ymd(kstNow()); }
function genStamp() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST'; }
function startOf(range) { // 어제 기준: w=7일, m=1개월, y=1년
  const d = kstNow(); d.setUTCDate(d.getUTCDate() - 1);
  if (range === 'w') d.setUTCDate(d.getUTCDate() - 6);
  else if (range === 'm') d.setUTCMonth(d.getUTCMonth() - 1);
  else d.setUTCFullYear(d.getUTCFullYear() - 1);
  return ymd(d);
}

// 앱 렌더러(ygt_culture_perform.js performParser)와 동일 매핑
function mapItems(result) {
  return result.slice(0, 50).map(r => {
    let poster = r.data3 || '';
    if (poster.startsWith('/upload')) poster = 'https://www.kopis.or.kr' + poster;
    return {
      rnum: r.rnum,
      mt20id: r.data1,
      prfnm: r.data2,
      poster: poster,
      prfpd: (r.data8 || '') + ' ~ ' + (r.data9 || ''),
      area: r.data10 || '',
      prfplcnm: (r.data11 || '') + ' ' + (r.data13 || ''),
      cate: r.data12 || '',
      state: r.prfStateNm || '',
    };
  });
}

(async () => {
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return null; } })();
  const today = dateKey();
  if (IF_MISSING && prev && prev.dateKey === today) { console.log('오늘(' + today + ') 이미 수집됨 — 스킵(--if-missing)'); return; }

  const endD = kstNow(); endD.setUTCDate(endD.getUTCDate() - 1);
  const endDate = ymd(endD);
  const out = { dateKey: today, generated: genStamp(), endDate };
  let ok = 0, fail = 0;
  for (const range of ['w', 'm', 'y']) {
    out[range] = {};
    const startDate = startOf(range);
    for (const g of GENRES) {
      try {
        const j = JSON.parse(await post({
          operationName: 'GetBoxofficeList',
          variables: { startDate, endDate, genre_code: g, STDG_CPSGG_CD: '', seatScale: '', rankType: 'ntssAmountSm' },
          query: QUERY,
        }));
        const result = (j.data && j.data.boxofficeList && j.data.boxofficeList.result) || [];
        out[range][g] = mapItems(result);
        ok++;
        console.log(range + '/' + g + ': ' + out[range][g].length + '건' + (out[range][g][0] ? ' (1위 ' + out[range][g][0].prfnm.slice(0, 20) + ')' : ''));
      } catch (e) {
        fail++;
        // 실패 장르는 기존 파일 값 유지 (없으면 빈 배열 — 앱이 라이브 폴백)
        out[range][g] = (prev && prev[range] && prev[range][g]) || [];
        console.error(range + '/' + g + ' 실패: ' + e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  if (ok === 0) { console.error('전 조합 실패'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (성공 ' + ok + '/21, 실패 ' + fail + ')');
})();
