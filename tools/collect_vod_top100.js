// IPTV·케이블TV 통합 영화 VOD 일간 TOP 100 수집기 — VKOBIS(영화진흥위원회
// 온라인상영관 통합전산망) 공식 데이터. GitHub Actions에서 매일 새벽 4시대(KST) 실행.
//  · 소스: POST /boxoffice/selectBoxofficeDayListTableAjax.do
//          {startDate, endDate(YYYYMMDD), first:1, second:100} → JSON 100건
//          (IPTV 3사 + 디지털케이블TV TVOD/PPV 이용건수 기준, 영진위 집계)
//  · 데이터는 D-2~D-3까지 제공 → 어제부터 거슬러가며 첫 유효 날짜를 수집
//  · 출력: vod/vod_top100.json (최신) + vod/vod_top100_history.json (날짜별 누적,
//          기존 날짜 보존 — 사용자 지시 "누적으로, 나중에 사용")
//
// 사용: node collect_vod_top100.js [출력경로=vod/vod_top100.json] [--if-missing]
//   --if-missing: 최신분(D-3 이내)이 이미 있으면 최신 수집은 스킵 (캐치업 크론용).
//   크론 스킵 대비: 실행마다 최근 14일 히스토리 누락 날짜를 VKOBIS로 백필
//   (VKOBIS는 과거 날짜 조회 가능 — 빠진 날을 스스로 메꾼다).
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'vod/vod_top100.json';
const IF_MISSING = _args.includes('--if-missing');
const BACKFILL_DAYS = 14;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HOST = 'www.vkobis.or.kr';
const AJAX_PATH = '/boxoffice/selectBoxofficeDayListTableAjax.do';

function post(path_, form) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(form).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const req = https.request({
      hostname: HOST, path: path_, method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Referer': 'https://' + HOST + '/boxoffice/selectBoxofficeDayList.do',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      timeout: 25000,
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

function kstToday() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}
function daysAgo(n) { const d = kstToday(); d.setUTCDate(d.getUTCDate() - n); return d; }

async function fetchDay(dateKey) {
  // 페이지와 동일하게 startDate = endDate-6 로 전달 (일간 조회에선 endDate 기준)
  const start = new Date(Date.UTC(+dateKey.slice(0, 4), +dateKey.slice(4, 6) - 1, +dateKey.slice(6, 8)));
  start.setUTCDate(start.getUTCDate() - 6);
  const raw = await post(AJAX_PATH, { startDate: ymd(start), endDate: dateKey, first: 1, second: 100 });
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length < 30) return null; // 미집계일(주말 직후 등)
  return arr;
}

function mapItems(rows) {
  return rows.map(r => ({
    rank: r.RANK,
    title: (r.MOVIE_NAME || '').trim(),
    titleEn: (r.MOVIE_EN_NM || '').trim(),
    useCo: r.USE_CO,                       // 해당일 이용건수
    prevCo: r.E_USE_CO,                    // 전일 이용건수 (증감률 계산용)
    per: parseFloat(r.PER) || 0,           // 점유율(%)
    accCo: r.T_USE_CO,                     // 누적 이용건수
    release: r.FRST_RLSE_DE || '',         // 개봉일
    poster: (r.PINK_YN === 'N' && r.FILE_SAVE_PATH && r.FILE_SAVE_PATH.length > 1) ? r.FILE_SAVE_PATH : '',
    trend: r.DATE_SCOPE || '',             // 최근 일별 추이(콤마 구분)
  })).filter(x => x.title);
}

function genStamp() {
  const d = kstToday(); const p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST';
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const HIST = path.join(path.dirname(OUT), 'vod_top100_history.json');
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch (e) {}
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  let changed = false, latestFail = false;

  // ① 최신분 — --if-missing이고 이미 D-4 이내면 스킵 (캐치업 크론용; 집계는 D-2~D-4 지연 실측)
  if (IF_MISSING && prev && prev.date >= ymd(daysAgo(4))) {
    console.log('최신분(' + prev.date + ') 이미 D-4 이내 — 스킵(--if-missing)');
  } else {
    // 어제(D-1)부터 D-6까지 거슬러가며 첫 유효 집계일 사용
    let dateKey = null, rows = null;
    for (let n = 1; n <= 6; n++) {
      const k = ymd(daysAgo(n));
      try {
        const r = await fetchDay(k);
        if (r) { dateKey = k; rows = r; break; }
        console.log(k + ': 데이터 없음(미집계)');
      } catch (e) { console.log(k + ': ' + e.message); }
    }
    if (!rows) {
      console.error('유효한 집계일을 못 찾음 (D-1~D-6)');
      latestFail = true;
    } else {
      const items = mapItems(rows);
      // 같은 기준일·같은 내용이면 다시 쓰지 않음 (generated만 바뀌는 무의미한 커밋 방지)
      if (prev && prev.date === dateKey && JSON.stringify(prev.items) === JSON.stringify(items)) {
        console.log('최신분(' + dateKey + ') 변경 없음 — 유지');
        if (!hist[dateKey]) { hist[dateKey] = { total: prev.total, items: items, generated: prev.generated }; changed = true; }
      } else {
        const result = {
          date: dateKey,                          // 데이터 기준일 (집계 지연으로 D-2~D-4)
          generated: genStamp(),
          total: rows[0] ? rows[0].DT_TOTAL : 0,  // 해당일 총 이용건수
          source: 'VKOBIS(영화진흥위원회 온라인상영관 통합전산망) — IPTV 3사·디지털케이블TV TVOD',
          items: items,
        };
        fs.writeFileSync(OUT, JSON.stringify(result));
        console.log('저장: ' + OUT + ' (기준일=' + result.date + ', ' + items.length + '건, 1위 ' + items[0].title + ')');
        hist[result.date] = { total: result.total, items: items, generated: result.generated };
        changed = true;
      }
    }
  }

  // ② 갭 백필 — 크론 스킵으로 빠진 최근 14일 누락 날짜를 채움 (기존 날짜 보존)
  for (let n = 2; n <= BACKFILL_DAYS; n++) {
    const k = ymd(daysAgo(n));
    if (hist[k]) continue;
    try {
      const r = await fetchDay(k);
      if (r) {
        const items = mapItems(r);
        hist[k] = { total: r[0] ? r[0].DT_TOTAL : 0, items: items, generated: genStamp() };
        changed = true;
        console.log('백필: ' + k + ' (' + items.length + '건)');
      } else {
        console.log('백필: ' + k + ' 데이터 없음(미집계) — 스킵');
      }
      await new Promise(res => setTimeout(res, 400));
    } catch (e) { console.log('백필 ' + k + ' 실패: ' + e.message); }
  }

  if (changed) {
    fs.writeFileSync(HIST, JSON.stringify(hist));
    console.log('누적: ' + HIST + ' (' + Object.keys(hist).length + '일치)');
  }

  // 최신분도 실패하고 백필 진전도 없으면 실패 처리 (잡 재시도 유도)
  if (latestFail && !changed) process.exit(1);
})();
