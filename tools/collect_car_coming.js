// car 신차 출시예정 수집 — GitHub Actions 일 1회 (0913).
//  · 목록 페이지가 Ajax 렌더라 데이터 엔드포인트(searchAjax) POST 1회로 전량 수집.
//  · 설명문은 편집 저작물이라 첫 줄(strong 요약)만 보관, 나머지는 미수집.
//  · 출력: car/coming.json {dateKey, generated, items:[{id,name,brand,img,date,price,summary}]}
//
// 사용: node collect_car_coming.js [출력파일=car/coming.json]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const OUT = process.argv[2] || 'car/coming.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko', 'Accept-Encoding': 'gzip',
        'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body),
        'Referer': 'https://auto.danawa.com/newcar/?Work=coming',
      },
      timeout: 45000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(ch);
        try {
          if (res.headers['content-encoding'] === 'gzip') resolve(zlib.gunzipSync(buf).toString('utf8'));
          else resolve(buf.toString('utf8'));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', function () { r.destroy(new Error('timeout')); });
    r.write(body);
    r.end();
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }
function genStamp() { const d = kstNow(); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' KST'; }
const strip = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const body = 'listSortType=7&tab=coming&searchKeyword=&listCount=200&page=1&brandList=&segmentList=&attributeList=';
  const html = await post('https://auto.danawa.com/newcar/searchAjax.php', body);

  // 항목 = image 앵커 기준 분할 (앵커가 이미지/모델명 2개라 image 쪽만).
  // 카드 2형: 요약형(spec comingtext + datestart) / 스펙형(spec 스팬 + "YYYY.MM. 출시" 스팬)
  const items = [];
  const chunks = html.split('class="image sendGA"');
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i].split('class="image sendGA"')[0];
    const prev = chunks[i - 1];
    try {
      const it = {};
      it.id = (prev.split('model="').pop() || '').split('"')[0].trim();
      // 모델 이미지의 alt = 표시명 전체
      it.name = strip((c.split('alt="')[1] || '').split('"')[0]);
      // 브랜드 로고 img: photo/brand/{bcode}_40.png alt="브랜드"
      const bm = c.match(/photo\/brand\/(\d+)_40\.png"\s+alt="([^"]+)"/);
      it.brand = bm ? bm[2].trim() : '';
      it.bcode = bm ? bm[1] : '';
      it.img = it.id ? 'https://autoimg.danawa.com/photo/' + it.id + '/model_200.png' : '';
      // 출시 시기: datestart(따옴표 혼재) 우선 → 스펙형은 "YYYY.MM. 출시" 스팬
      const ds = c.split("class='datestart'")[1] || c.split('class="datestart"')[1];
      if (ds) { it.date = strip(ds.split('<strong>')[1].split('</strong>')[0]); }
      else {
        const dm = c.match(/<span>\s*(\d{4}\.\d{2}\.?)\s*출시\s*<\/span>/);
        it.date = dm ? dm[1] : '';
      }
      const pr = c.split('class="price"')[1];
      it.price = pr ? strip(pr.split('</div>')[0].split('>').slice(1).join('>')) : strip((pr || '').split('</div>')[0]);
      if (!it.price) { const pv = c.split('class="price"')[1]; it.price = pv ? strip(pv.split('</div>')[0]) : ''; }
      // 요약: comingtext strong → 없으면 스펙 스팬 상위 2개(차급/연료)
      const sm = c.split('class="spec comingtext"')[1];
      if (sm) { it.summary = strip((sm.split('<strong>')[1] || '').split('</strong>')[0]); }
      else {
        const sp = c.split('class="spec ')[1];
        if (sp) {
          const spans = (sp.split('</div>')[0].match(/<span>([^<]+)<\/span>/g) || [])
            .map(x => strip(x)).filter(x => x && x.indexOf('출시') === -1);
          it.summary = spans.slice(0, 3).join(' · ');
        } else { it.summary = ''; }
      }
      if (it.id && it.name) items.push(it);
    } catch (e) { /* 항목 파싱 실패는 건너뜀 */ }
  }

  if (items.length < 20) throw new Error('출시예정 파싱 부족: ' + items.length);

  const out = { dateKey: dateKey(), generated: genStamp(), items };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + items.length + '건, ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
