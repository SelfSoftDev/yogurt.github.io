// 웨이브/티빙 "오늘의 TOP 20" 수집기 — GitHub Actions에서 매일 새벽 4시(KST)에 실행.
//  · Wavve : apis.wavve.com 공개 웹 API (catalogType=ranking) — 로그인 불필요
//  · Tving : www.tving.com 홈 HTML의 __NEXT_DATA__에 내장된 VOD_BASIC_RANKING 밴드
//  · 출력  : {date(KST YYYYMMDD), generated, wavve:[{rank,title,image}], tving:[...]}
//  · 누적  : 같은 폴더의 ott_top20_history.json 에 {날짜: {wavve,tving,generated}}로
//            계속 쌓음(기존 날짜 보존 — 나중에 추이 기능 등에 재사용 가능).
//  · 한쪽 실패 시: 기존 출력 파일의 해당 서비스 데이터를 유지(부분 갱신).
//    둘 다 실패면 exit 1 (Actions 재시도 유도).
//
// 사용: node collect_ott_top20.js [출력경로=ott/ott_top20.json] [--if-missing]
//   --if-missing: 오늘치가 히스토리에 온전히 있으면 수집 없이 종료 — 크론 스킵 대비
//   캐치업 예약(오전/오후)이 성공한 날 불필요한 재수집·커밋을 안 만들게 함.
//   (웨이브/티빙은 "현재 순위"만 제공해 과거 백필이 불가 → 캐치업 크론이 유일한 보완)
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'ott/ott_top20.json';
const IF_MISSING = _args.includes('--if-missing');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Wavve 웹 클라이언트의 공개 apikey (사이트 JS 번들에 노출된 값. 로테이션되면 여기만 갱신)
const WAVVE_URL = 'https://apis.wavve.com/v1/catalog?broadcastid=CN2&catalogType=ranking&limit=20&offset=0'
  + '&orderby=default&rankingType=top&uicode=CN2&uiparent=GN51-CN2&uirank=16&uitype=band_98&isBand=true'
  + '&apikey=E5F3E0D30947AA5440556471321BB6D9&device=pc&partner=pooq&region=kor&targetage=all&pooqzone=none&drm=wm';
const TVING_URL = 'https://www.tving.com/';
// tving SPA의 BFF 홈 API — HTML 파싱보다 안정적이라 1순위로 시도 (실패 시 HTML 폴백)
const TVING_BFF_URL = 'https://gw.tving.com/bff/web/v3/home/main?screenCode=CSSD0100&osCode=CSOD0900';

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko' },
      timeout: 25000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstDateKey() {
  const d = kstNow();
  const p = n => (n < 10 ? '0' : '') + n;
  return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

async function collectWavve() {
  const j = JSON.parse(await get(WAVVE_URL));
  const list = (j.data && j.data.context_list) || [];
  const out = list.slice(0, 20).map((it, i) => {
    const prog = it.program || {}, series = it.series || {};
    return {
      rank: i + 1,
      title: (prog.title || series.title || '').trim(),
      image: prog.vertical_logo_y_image || prog.square_image || series.vertical_logo_y_image || '',
    };
  }).filter(x => x.title);
  if (out.length < 10) throw new Error('wavve: 아이템 부족 (' + out.length + ')');
  return out;
}

function findRankingBand(data) {
  // 구조 변경에 견디도록 딥워크로 VOD_BASIC_RANKING 밴드를 찾음
  let band = null;
  (function walk(o) {
    if (band || !o || typeof o !== 'object') return;
    if (o.bandType === 'VOD_BASIC_RANKING' && Array.isArray(o.items) && o.items.length) { band = o; return; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  })(data);
  return band;
}

async function collectTving() {
  let band = null;
  // ① BFF 홈 API (JSON, 가장 안정적)
  try { band = findRankingBand(JSON.parse(await get(TVING_BFF_URL))); } catch (e) {}
  // ② 폴백: 데스크톱 홈 HTML의 __NEXT_DATA__
  if (!band) {
    const html = await get(TVING_URL);
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('tving: __NEXT_DATA__ 없음');
    band = findRankingBand(JSON.parse(m[1]));
  }
  if (!band) throw new Error('tving: TOP20 밴드 없음');
  const out = band.items.slice(0, 20).map((it, i) => ({
    rank: i + 1,
    title: (it.title || '').trim(),
    image: it.imageUrl ? (it.imageUrl.startsWith('http') ? it.imageUrl : 'https://image.tving.com' + it.imageUrl) : '',
  })).filter(x => x.title);
  if (out.length < 10) throw new Error('tving: 아이템 부족 (' + out.length + ')');
  return out;
}

(async () => {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}

  // --if-missing: 오늘치가 이미 온전히 수집돼 있으면 스킵 (캐치업 크론용)
  if (IF_MISSING) {
    const HIST0 = path.join(path.dirname(OUT), 'ott_top20_history.json');
    let h = {}; try { h = JSON.parse(fs.readFileSync(HIST0, 'utf8')); } catch (e) {}
    const today = h[kstDateKey()];
    if (today && (today.wavve || []).length >= 10 && (today.tving || []).length >= 10) {
      console.log('오늘(' + kstDateKey() + ')치 이미 수집됨 — 스킵(--if-missing)');
      return;
    }
  }

  let wavve = null, tving = null, errs = [];
  try { wavve = await collectWavve(); console.log('wavve OK (' + wavve.length + '): ' + wavve[0].title + ' ...'); }
  catch (e) { errs.push('wavve: ' + e.message); }
  try { tving = await collectTving(); console.log('tving OK (' + tving.length + '): ' + tving[0].title + ' ...'); }
  catch (e) { errs.push('tving: ' + e.message); }

  if (!wavve && !tving) { console.error('둘 다 실패: ' + errs.join(' | ')); process.exit(1); }
  if (errs.length) console.warn('부분 실패(기존값 유지): ' + errs.join(' | '));

  const d = kstNow();
  const p = n => (n < 10 ? '0' : '') + n;
  const result = {
    date: kstDateKey(),
    generated: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
      + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST',
    wavve: wavve || prev.wavve || [],
    tving: tving || prev.tving || [],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log('저장: ' + OUT + ' (date=' + result.date + ', wavve=' + result.wavve.length + ', tving=' + result.tving.length + ')');

  // 누적 히스토리: 날짜키로 계속 쌓음 (기존 날짜 유지 — 같은 날 재실행은 그 날짜만 최신으로 갱신)
  const HIST = path.join(path.dirname(OUT), 'ott_top20_history.json');
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch (e) {}
  hist[result.date] = { wavve: result.wavve, tving: result.tving, generated: result.generated };
  fs.writeFileSync(HIST, JSON.stringify(hist));
  console.log('누적: ' + HIST + ' (' + Object.keys(hist).length + '일치)');
})();
