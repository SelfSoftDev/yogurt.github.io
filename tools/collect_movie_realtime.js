// KOBIS 실시간 예매율 스냅샷 수집기 — GitHub Actions에서 20분 주기로 실행.
//  · 소스: 메인 위젯 searchMainRealTicket.do (앱 실시간 탭과 동일 엔드포인트/형식)
//  · 출력: movie/realtime_snapshot.json {generated(KST), items:[KOBIS 원본 객체]}
//  · 용도: 앱은 KOBIS를 직접 호출(최신성 우선)하고, KOBIS 장애 시에만 이 스냅샷을
//    폴백으로 사용 — "장애 직전 마지막 예매율"이라도 빈 화면보다 낫다.
//  · 히스토리 누적 없음(실시간 데이터라 가치 없음). 워크플로가 amend-squash로
//    커밋 1개를 유지해 repo 히스토리 오염을 막는다.
//
// 사용: node collect_movie_realtime.js [출력경로=movie/realtime_snapshot.json]
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'movie/realtime_snapshot.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.kobis.or.kr/' },
      timeout: 25000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function genStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST';
}

(async () => {
  const arr = JSON.parse(await get('https://www.kobis.or.kr/kobis/business/main/searchMainRealTicket.do'));
  if (!Array.isArray(arr) || arr.length < 5) { console.error('실시간 응답 형식 이상 (' + (arr && arr.length) + '건)'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generated: genStamp(), items: arr }));
  console.log('저장: ' + OUT + ' (' + arr.length + '건, 1위 ' + arr[0].movieNm + ' ' + arr[0].totIssuCntRatio + ')');
})().catch(e => { console.error('실시간 수집 실패: ' + e.message); process.exit(1); });
