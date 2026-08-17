// scripts/fetch-kopis.mjs
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const KEY = process.env.KOPIS_API_KEY;
const BASE = 'http://kopis.or.kr/openApi/restful';
const GENRES = { CCCD: '대중음악', GGGA: '뮤지컬', CCCA: '서양음악(클래식)' };
const MONTHS_AHEAD = 6;

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const https = (u) => (u || '').replace(/^http:\/\//, 'https://');

async function getXml(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      return parser.parse(await res.text());
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

function ymd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// 한 달 단위로 잘라서 목록 조회 (페이지당 최대 100건)
async function listByMonth(genre, start, end) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const url = `${BASE}/pblprfr?service=${KEY}&stdate=${start}&eddate=${end}`
      + `&cpage=${page}&rows=100&shcate=${genre}&prfstate=01`;
    const json = await getXml(url);
    const rows = arr(json?.dbs?.db);
    out.push(...rows);
    if (rows.length < 100) break;
    await sleep(300);
  }
  return out;
}

// "R석 154,000원, S석 132,000원" → 좌석 등급별 배열
function parsePrice(raw) {
  if (!raw) return { raw: '', tiers: [], min: null, max: null, free: false };
  if (/무료/.test(raw)) return { raw, tiers: [], min: 0, max: 0, free: true };
  const tiers = [...raw.matchAll(/([^,\/]*?)\s*([\d]{1,3}(?:,\d{3})+|\d{4,})\s*원/g)]
    .map((m) => ({
      grade: m[1].replace(/[,\/]/g, '').trim() || '기본가',
      price: Number(m[2].replace(/,/g, '')),
    }));
  const nums = tiers.map((t) => t.price);
  return {
    raw,
    tiers,
    min: nums.length ? Math.min(...nums) : null,
    max: nums.length ? Math.max(...nums) : null,
    free: false,
  };
}

async function detail(id) {
  const json = await getXml(`${BASE}/pblprfr/${id}?service=${KEY}`);
  const d = arr(json?.dbs?.db)[0];
  if (!d) return null;
  return {
    id: d.mt20id,
    name: d.prfnm,
    from: String(d.prfpdfrom).replace(/\./g, '-'),
    to: String(d.prfpdto).replace(/\./g, '-'),
    venue: d.fcltynm,
    area: d.area || '',
    genre: d.genrenm,
    cast: d.prfcast || '',
    runtime: d.prfruntime || '',
    age: d.prfage || '',
    host: d.entrpsnm || '',
    times: d.dtguidance || '',
    poster: https(d.poster),
    state: d.prfstate,
    price: parsePrice(d.pcseguidance),
    booking: arr(d.relates?.relate).map((r) => ({
      name: r.relatenm,
      url: https(r.relateurl),
    })),
  };
}

const today = new Date();
const ranges = [];
for (let i = 0; i < MONTHS_AHEAD; i++) {
  const s = new Date(today.getFullYear(), today.getMonth() + i, 1);
  const e = new Date(today.getFullYear(), today.getMonth() + i + 1, 0);
  ranges.push([ymd(i === 0 ? today : s), ymd(e)]);
}

const ids = new Set();
for (const g of Object.keys(GENRES)) {
  for (const [s, e] of ranges) {
    const rows = await listByMonth(g, s, e);
    rows.forEach((r) => ids.add(r.mt20id));
    console.log(`${GENRES[g]} ${s}~${e}: ${rows.length}건`);
  }
}

const results = [];
let n = 0;
for (const id of ids) {
  const d = await detail(id).catch(() => null);
  if (d) results.push(d);
  if (++n % 25 === 0) console.log(`상세 ${n}/${ids.size}`);
  await sleep(200); // 서버 부하 방지
}

// 수동 관리하는 예매 오픈일 병합
const overridePath = 'data/ticket-open.json';
const overrides = existsSync(overridePath)
  ? JSON.parse(readFileSync(overridePath, 'utf8'))
  : {};
results.forEach((r) => {
  const o = overrides[r.id] || overrides[r.name];
  if (o) r.ticketOpen = o;
});

results.sort((a, b) => a.from.localeCompare(b.from));
mkdirSync('data', { recursive: true });
writeFileSync(
  'data/concerts.json',
  JSON.stringify({ updatedAt: new Date().toISOString(), items: results }, null, 1)
);
console.log(`완료: ${results.length}건`);
