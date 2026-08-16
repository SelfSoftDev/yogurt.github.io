// news(뉴스끝판왕) 링크 헬스체크 — GitHub Actions 주 1회.
//  · 기존 news/links.json의 전 링크를 실제 호출: 200+리다이렉트면 최종 URL로 자가 치유,
//    실패면 기존 링크 유지 + dead 표시(로그로 수동 점검 유도). 앱은 gh 목록 우선.
//  · 출력: news/links.json {dateKey, generated, news:[{Code,Name,Link}], community:[...]}
//
// 사용: node collect_news_links.js [파일=news/links.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const OUT = process.argv[2] || 'news/links.json';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

function probe(url, redir) {
  redir = redir || 0;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 'BADURL' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' }, timeout: 15000,
    }, (rs) => {
      rs.resume();
      if ([301, 302, 307, 308].includes(rs.statusCode) && rs.headers.location && redir < 5) {
        return resolve(probe(new URL(rs.headers.location, url).href, redir + 1));
      }
      resolve({ status: rs.statusCode, final: url, hops: redir });
    });
    r.on('error', e => resolve({ status: 'ERR:' + e.code }));
    r.on('timeout', function () { r.destroy(); resolve({ status: 'TIMEOUT' }); });
    r.end();
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }

(async () => {
  if (!fs.existsSync(OUT)) throw new Error(OUT + ' 없음 — 번들 목록으로 시드 후 실행할 것');
  const out = JSON.parse(fs.readFileSync(OUT, 'utf8'));

  let healed = 0, dead = 0, ok = 0;
  for (const grp of ['news', 'community']) {
    const list = out[grp] || [];
    for (let i = 0; i < list.length; i += 8) {
      const batch = list.slice(i, i + 8);
      await Promise.all(batch.map(async (it) => {
        const r = await probe(it.Link);
        if (r.status === 200) {
          ok++;
          delete it.dead;
          if (r.hops > 0 && r.final && r.final !== it.Link) {
            // 리다이렉트 최종 URL로 자가 치유 — 단 전혀 다른 도메인이면 보류(도메인 매각 오탐 방지)
            const oldHost = new URL(it.Link).hostname.split('.').slice(-2).join('.');
            const newHost = new URL(r.final).hostname.split('.').slice(-2).join('.');
            if (oldHost === newHost) { it.Link = r.final; healed++; }
            else { console.log('도메인 변경 보류: ' + it.Name + ' ' + it.Link + ' → ' + r.final); }
          }
        } else {
          dead++;
          it.dead = String(r.status);
          console.log('죽은 링크: [' + grp + '] ' + it.Name + ' (' + r.status + ') ' + it.Link);
        }
      }));
    }
  }

  // 안전판: 절반 이상 죽으면 네트워크 이상 의심 — 갱신 중단
  if (dead > (ok + dead) / 2) throw new Error('과반 실패(' + dead + '/' + (ok + dead) + ') — 러너 네트워크 이상 의심, 갱신 중단');

  out.dateKey = dateKey();
  out.generated = genStamp();
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (정상 ' + ok + ' / 치유 ' + healed + ' / 죽음 ' + dead + ')');
})().catch(e => { console.error('헬스체크 실패: ' + e.message); process.exit(1); });
