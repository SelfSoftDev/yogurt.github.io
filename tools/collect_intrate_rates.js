// intrate(금리끝판왕) 계열 금리 수집 — GitHub Actions 일 1회.
//  · 금융감독원 금융상품 한눈에 Open API (키 = env FINLIFE_KEY, 로컬은 .secret/finlife_key.txt 폴백).
//  · 예금·적금(0402) + 주담대·전세·신용(0403) — 앱 렌더러가 로컬 필터·이자계산으로 즉시 렌더.
//  · 행 포맷은 기존 폴백(data_finance_fallback.js)과 동일 계열의 압축 배열.
//  · 출력: intrate/rates.json
//    {dateKey, generated, dcls, comp:[[명,홈피,전화]],
//     dep:[[ci,상품,grp(1은행/2저축),기간,기본,최고(-1),S/C]], ins:[…,적립S/F],
//     mor:[[ci,상품,grp(1은행/2저축/3보험),담보A/E,상환D2/D1/S,금리F/C,min,max,avg]],
//     rent:[[ci,상품,grp,상환,금리,min,max,avg]],
//     crdt:[[ci,대출종류명,grpCode,prdtType,g1,g4,g5,g6,g10,avg]]}  // 대출금리(A) 옵션만
//
// 사용: FINLIFE_KEY=<키> node collect_intrate_rates.js [출력파일=intrate/rates.json]
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'intrate/rates.json';
let KEY = (process.env.FINLIFE_KEY || '').trim();
if (!KEY) {
  try { KEY = fs.readFileSync(path.resolve(__dirname, '../../.secret/finlife_key.txt'), 'utf8').trim(); } catch (e) {}
}
if (!KEY) { console.error('FINLIFE_KEY 미설정'); process.exit(1); }

let FRED_KEY = (process.env.FRED_KEY || '').trim();
if (!FRED_KEY) {
  try { FRED_KEY = fs.readFileSync(path.resolve(__dirname, '../../.secret/fred_api_key.txt'), 'utf8').trim(); } catch (e) {}
}

const API = 'https://finlife.fss.or.kr/finlifeapi/';
const GRP_DEP = ['020000', '030300'];                       // 예·적금: 은행/저축은행
const GRP_LOAN = ['020000', '030300', '050000'];            // 주담대·전세: +보험
const GRP_CRDT = ['020000', '030300', '030200', '050000'];  // 신용: +여신전문

function get(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }, timeout: 15000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}

async function getRetry(url) {
  const waits = [2000, 5000, 10000];
  for (let a = 0; a <= 3; a++) {
    try {
      const j = JSON.parse(await get(url)).result;
      if (j && j.err_cd === '000') return j;
      throw new Error('err_cd ' + (j && j.err_cd));
    } catch (e) {
      if (a === 3) { console.error('요청 실패: ' + e.message); return null; }
      await new Promise(z => setTimeout(z, waits[a]));
    }
  }
  return null;
}

async function fetchAll(endpoint, grp) {
  const base = [], option = [];
  let page = 1, maxPage = 1;
  do {
    const j = await getRetry(API + endpoint + '.json?auth=' + KEY + '&topFinGrpNo=' + grp + '&pageNo=' + page);
    if (j) {
      maxPage = parseInt(j.max_page_no, 10) || 1;
      (j.baseList || []).forEach(b => base.push(b));
      (j.optionList || []).forEach(o => option.push(o));
    } else if (page === 1) break;
    page++;
    await new Promise(z => setTimeout(z, 150));
  } while (page <= maxPage);
  return { base, option };
}

const num = v => { if (v == null || v === '' || v === '-') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // 회사 테이블 (전 권역 통합)
  const compIdx = {}, comp = [];
  for (const grp of GRP_CRDT) {
    const c = await fetchAll('companySearch', grp);
    for (const b of c.base) {
      if (compIdx[b.fin_co_no] == null) {
        compIdx[b.fin_co_no] = comp.length;
        comp.push([b.kor_co_nm, b.homp_url || '', b.cal_tel || '']);
      }
    }
  }
  const ci = (b) => {
    if (compIdx[b.fin_co_no] == null) { compIdx[b.fin_co_no] = comp.length; comp.push([b.kor_co_nm, '', '']); }
    return compIdx[b.fin_co_no];
  };
  const optJoin = (base, option) => {
    const key = x => x.fin_co_no + '|' + x.fin_prdt_cd + '|' + x.dcls_month;
    const m = {};
    option.forEach(o => (m[key(o)] = m[key(o)] || []).push(o));
    return base.map(b => ({ b, opts: m[key(b)] || [] }));
  };

  const out = { dateKey: dateKey(), generated: genStamp(), dcls: '', comp, dep: [], ins: [], mor: [], rent: [], crdt: [] };
  const grpNum = { '020000': 1, '030300': 2, '050000': 3 };

  // 예금·적금
  for (const grp of GRP_DEP) {
    const d = await fetchAll('depositProductsSearch', grp);
    for (const { b, opts } of optJoin(d.base, d.option)) {
      if (!out.dcls && b.dcls_month) out.dcls = b.dcls_month;
      for (const o of opts) {
        const r = num(o.intr_rate); if (r == null || !o.save_trm) continue;
        out.dep.push([ci(b), b.fin_prdt_nm, grpNum[grp], parseInt(o.save_trm, 10), r, num(o.intr_rate2) != null ? num(o.intr_rate2) : -1, o.intr_rate_type === 'S' ? 'S' : 'C']);
      }
    }
    const s = await fetchAll('savingProductsSearch', grp);
    for (const { b, opts } of optJoin(s.base, s.option)) {
      for (const o of opts) {
        const r = num(o.intr_rate); if (r == null || !o.save_trm) continue;
        out.ins.push([ci(b), b.fin_prdt_nm, grpNum[grp], parseInt(o.save_trm, 10), r, num(o.intr_rate2) != null ? num(o.intr_rate2) : -1, o.intr_rate_type === 'S' ? 'S' : 'C', o.rsrv_type || '']);
      }
    }
    console.log('[' + grp + '] 예금옵션 ' + out.dep.length + ' / 적금옵션 ' + out.ins.length);
  }

  // 주담대 / 전세
  for (const grp of GRP_LOAN) {
    const mo = await fetchAll('mortgageLoanProductsSearch', grp);
    for (const { b, opts } of optJoin(mo.base, mo.option)) {
      for (const o of opts) {
        const mn = num(o.lend_rate_min), mx = num(o.lend_rate_max);
        if (mn == null) continue;
        out.mor.push([ci(b), b.fin_prdt_nm, grpNum[grp], o.mrtg_type || 'A', o.rpay_type || '', o.lend_rate_type || '', mn, mx != null ? mx : -1, num(o.lend_rate_avg) != null ? num(o.lend_rate_avg) : -1]);
      }
    }
    const re = await fetchAll('rentHouseLoanProductsSearch', grp);
    for (const { b, opts } of optJoin(re.base, re.option)) {
      for (const o of opts) {
        const mn = num(o.lend_rate_min), mx = num(o.lend_rate_max);
        if (mn == null) continue;
        out.rent.push([ci(b), b.fin_prdt_nm, grpNum[grp], o.rpay_type || '', o.lend_rate_type || '', mn, mx != null ? mx : -1, num(o.lend_rate_avg) != null ? num(o.lend_rate_avg) : -1]);
      }
    }
  }
  console.log('주담대옵션 ' + out.mor.length + ' / 전세옵션 ' + out.rent.length);

  // 신용대출 — 대출금리(A) 옵션만 (페이지 표시 기준)
  for (const grp of GRP_CRDT) {
    const cr = await fetchAll('creditLoanProductsSearch', grp);
    for (const { b, opts } of optJoin(cr.base, cr.option)) {
      for (const o of opts) {
        if (o.crdt_lend_rate_type && o.crdt_lend_rate_type !== 'A') continue;
        const g = k => { const v = num(o[k]); return v != null ? v : -1; };
        const avg = num(o.crdt_grad_avg); if (avg == null) continue;
        out.crdt.push([ci(b), b.crdt_prdt_type_nm || b.fin_prdt_nm, grp, String(b.crdt_prdt_type || ''), g('crdt_grad_1'), g('crdt_grad_4'), g('crdt_grad_5'), g('crdt_grad_6'), g('crdt_grad_10'), avg]);
      }
    }
  }
  console.log('신용옵션 ' + out.crdt.length);

  if (out.dep.length < 100 || out.ins.length < 100) throw new Error('예·적금 수집 부족 (dep ' + out.dep.length + ', ins ' + out.ins.length + ')');
  if (out.mor.length < 30 || out.crdt.length < 30) throw new Error('대출 수집 부족 (mor ' + out.mor.length + ', crdt ' + out.crdt.length + ')');

  // ── 기준금리 (0401) — 실패해도 나머지 데이터는 저장 (렌더러가 번들 폴백)
  out.base = {};
  try { // 한국: 한국은행 변경 이력 표 (연도/변경일/금리)
    const html = await get('https://www.bok.or.kr/portal/singl/baseRate/list.do?dataSeCd=01&menuNo=200643');
    const tb = html.split('<tbody>')[1].split('</tbody>')[0];
    const rows = [];
    for (const tr of (tb.match(/<tr[\s\S]*?<\/tr>/g) || [])) {
      const tds = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(t => t.replace(/<[^>]+>/g, '').trim());
      if (tds.length >= 3 && /^\d{4}$/.test(tds[0])) rows.push({ year: tds[0], date: tds[1], int: parseFloat(tds[2]).toFixed(2) });
    }
    for (let i = 0; i < rows.length; i++) { // 직전 변경 대비 방향 (표시는 상승/하락/유지)
      const prev = rows[i + 1];
      const diff = prev ? (parseFloat(rows[i].int) - parseFloat(prev.int)) : 0;
      rows[i].udico = diff > 0 ? '상승' : (diff < 0 ? '하락' : '유지');
      rows[i].udnum = Math.abs(diff).toFixed(2);
    }
    if (rows.length >= 20) out.base.kor = rows;
    console.log('기준금리 한국: ' + rows.length + '행 (최신 ' + rows[0].year + ' ' + rows[0].date + ' ' + rows[0].int + '%)');
  } catch (e) { console.error('한국 기준금리 실패: ' + e.message); }

  try { // 미국: FRED 연방기금 목표 상단(DFEDTARU) 일별 → 변경 시점 추출
    if (!FRED_KEY) throw new Error('FRED_KEY 미설정');
    const j = JSON.parse(await get('https://api.stlouisfed.org/fred/series/observations?series_id=DFEDTARU&api_key=' + FRED_KEY + '&file_type=json&observation_start=2008-12-01'));
    const obs = (j.observations || []).filter(o => o.value !== '.');
    const rows = [];
    let last = null;
    for (const o of obs) {
      const v = parseFloat(o.value);
      if (last === null || v !== last) {
        const diff = last === null ? 0 : v - last;
        rows.unshift({ // 최신이 앞
          year: o.date.slice(0, 4), date: o.date.slice(5, 7) + '월 ' + o.date.slice(8, 10) + '일',
          intlow: (v - 0.25).toFixed(2) + '~', int: v.toFixed(2),
          udico: diff > 0 ? '상승' : (diff < 0 ? '하락' : '유지'), udnum: Math.abs(diff).toFixed(2),
        });
        last = v;
      }
    }
    if (rows.length >= 20) out.base.usa = rows;
    console.log('기준금리 미국: ' + rows.length + '행 (최신 ' + rows[0].year + ' ' + rows[0].date + ' ' + rows[0].int + '%)');
  } catch (e) { console.error('미국 기준금리 실패: ' + e.message); }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (comp ' + comp.length + ', ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
