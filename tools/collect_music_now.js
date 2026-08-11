// music 실시간 차트 스냅샷 — GitHub Actions 30분 주기 (멜론 TOP100·지니 실시간·벅스 실시간).
//  · 실시간이라 라이브가 정본 — 스냅샷은 앱의 "신선(45분 이내)하면 정본, 아니면 라이브" 1순위 소스.
//  · 파싱 규칙 = collect_music_charts.js와 공유(동일 split). t(epoch)로 신선도 판정(시간대 무관).
//  · 출력: music/now.json {t, dateKey, generated, melon:{date,items}, genie:{date,items}, bugs:{date,items}}
//
// 사용: node collect_music_now.js [출력파일=music/now.json]
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'music/now.json';

// charts 수집기의 파서/헬퍼 재사용 (사본 중복 방지 — module.exports)
const { req, sleep, dateKey, genStamp, melonItems, melonDate, melonLikes, genieItems, bugsItems } = require('./collect_music_charts.js');

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = { t: Date.now(), dateKey: dateKey(), generated: genStamp() };
  let ok = 0;

  try { // 멜론 TOP100 (24시간 집계)
    const html = await req('https://www.melon.com/chart/index.htm');
    out.melon = { date: melonDate(html, 'hour'), items: await melonLikes(melonItems(html)) };
    ok++;
  } catch (e) { console.error('melon 실패: ' + e.message); }
  await sleep(500);

  try { // 지니 실시간 (2페이지)
    const p1 = await req('https://www.genie.co.kr/chart/top200?ditc=D&rtm=Y&pg=1');
    const items = genieItems(p1, '<caption>곡 리스트</caption>', '<!--// LIST -->');
    await sleep(400);
    const p2 = await req('https://www.genie.co.kr/chart/top200?ditc=D&rtm=Y&pg=2');
    const all = items.concat(genieItems(p2, '<div class="music-list-wrap">', '<hr class="hide" />'));
    const date = p2.split('id="curDateComma" value="')[1].split('"')[0] + '&nbsp;&nbsp;&nbsp;' + p2.split('id="strHH" value="')[1].split('"')[0] + ':00';
    out.genie = { date, items: all };
    ok++;
  } catch (e) { console.error('genie 실패: ' + e.message); }
  await sleep(500);

  try { // 벅스 실시간
    const html = await req('https://music.bugs.co.kr/chart/track/realtime/total');
    const date = (html.split('<time datetime="')[1].split('>')[1].split('<')[0].replace(/\s+/g, ' ').trim())
      + '&nbsp;&nbsp;&nbsp;' + (html.split('<time datetime="')[1].split('<em>')[1].split('<')[0].replace(/\s+/g, ' ').trim());
    out.bugs = { date, items: bugsItems(html) };
    ok++;
  } catch (e) { console.error('bugs 실패: ' + e.message); }

  if (!ok) { console.error('전 소스 실패'); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + ['melon', 'genie', 'bugs'].filter(k => out[k]).map(k => k + '=' + out[k].items.length).join(', ') + ', ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
