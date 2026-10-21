/**
 * daily-scan — AI สแกนหุ้นให้ทุกวัน
 *
 * ใครเรียกได้
 *   1) pg_cron ทุกเช้า 08:30 น. (เวลาไทย) ส่ง header  x-cron-secret
 *   2) แอดมินกด "สแกนตอนนี้" ในแอป (ส่ง JWT ของผู้ใช้ที่อยู่ในตาราง admins)
 *
 * ทำอะไร
 *   ดึงข้อมูลจาก TradingView → ให้คะแนน 5 ด้านแบบเดียวกับหน้าเว็บ → คัดหุ้นเด่นเป็นกลุ่ม
 *   → ส่งตัวเลขให้ Gemini เขียนบทสรุปภาษาไทย → บันทึกลง public.daily_scans
 *   ถ้าไม่มี GEMINI_API_KEY หรือ Gemini ล่ม จะเขียนสรุปจากกฎแทน ระบบยังทำงานต่อได้
 *
 * Secrets
 *   GEMINI_API_KEY   (ไม่ใส่ก็ได้)  key ฟรีจาก https://aistudio.google.com/apikey
 *   GEMINI_MODEL     (ไม่ใส่ก็ได้)  ค่าเริ่มต้นไล่ gemini-3.8-flash → flash-lite-latest → flash-latest (รวมไม่เกิน 90 วิ)
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// รับได้ทั้งชื่อมาตรฐาน GEMINI_API_KEY และ secret ชื่ออื่นที่มีคำว่า gemini (กันตั้งชื่อผิด)
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ??
  Object.entries(Deno.env.toObject()).find(([k, v]) => /gemini/i.test(k) && !/model/i.test(k) && v)?.[1] ?? "";
// ไล่ลองทีละรุ่น — รุ่นเก่าถูกปลดได้ และรุ่น latest อาจคนใช้เยอะจนตอบ 503
const GEMINI_MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-3.8-flash", "gemini-flash-lite-latest",
  "gemini-flash-latest"].filter(Boolean) as string[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

type Row = Record<string, any>;
type Market = "thailand" | "america" | "crypto";
const MARKET_TH: Record<Market, string> = { thailand: "หุ้นไทย", america: "หุ้นสหรัฐฯ", crypto: "คริปโต" };

/* ---------------- TradingView ---------------- */
const STOCK_COLS = ["name", "description", "close", "change", "volume", "market_cap_basic",
  "price_earnings_ttm", "price_book_fq", "return_on_equity", "net_margin_ttm",
  "total_revenue_yoy_growth_ttm", "earnings_per_share_diluted_yoy_growth_ttm",
  "dividends_yield_current", "debt_to_equity", "RSI", "Recommend.All",
  "Perf.W", "Perf.1M", "Perf.3M", "Perf.YTD", "Perf.Y", "sector", "SMA50", "SMA200",
  "relative_volume_10d_calc", "piotroski_f_score_ttm", "free_cash_flow_margin_ttm",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer",
  "is_primary"];
const CRYPTO_COLS = ["base_currency", "base_currency_desc", "close", "change", "market_cap_calc",
  "volume", "RSI", "Recommend.All", "Perf.W", "Perf.1M", "Perf.3M", "Perf.YTD", "Perf.Y",
  "SMA50", "SMA200", "relative_volume_10d_calc",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];

async function tvScan(market: Market): Promise<Row[]> {
  const crypto = market === "crypto";
  const columns = crypto ? CRYPTO_COLS : STOCK_COLS;
  const filter = crypto
    ? [{ left: "exchange", operation: "equal", right: "BINANCE" }]
    : [{ left: "is_primary", operation: "equal", right: true }];
  const body = {
    columns, filter, ignore_unknown_fields: false, options: { lang: "en" },
    range: [0, crypto ? 400 : 300],
    sort: { sortBy: crypto ? "market_cap_calc" : "market_cap_basic", sortOrder: "desc" },
    markets: [market],
  };
  const res = await fetch(`https://scanner.tradingview.com/${market}/scan?label-product=screener-stock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (stock-finder daily-scan)" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TradingView HTTP ${res.status}`);
  const j = await res.json();
  let rows: Row[] = (j.data ?? []).map((d: any) => {
    const o: Row = { symbol: d.s };
    columns.forEach((c, i) => (o[c] = d.d[i]));
    o.name = o.name || String(d.s).split(":")[1] || d.s;
    return o;
  });
  if (crypto) {
    // BTC มีหลายคู่ — เก็บเฉพาะคู่ USD ตัวแรกของแต่ละเหรียญ
    const seen = new Set<string>();
    rows = rows.filter((r) => /USDT?$/.test(String(r.symbol)) && !seen.has(r.base_currency) && seen.add(r.base_currency));
    rows.forEach((r) => { r.description = r.base_currency_desc; r.name = r.base_currency; });
  }
  return rows;
}

/* ---------------- คะแนน (ตรงกับ pillars() ในหน้าเว็บ) ---------------- */
const nz = (v: any) => (v === null || v === undefined || Number.isNaN(+v) ? null : +v);
function band(v: any, lo: number, hi: number, inv = false) {
  const x = nz(v); if (x === null) return null;
  let t = (x - lo) / (hi - lo); t = Math.max(0, Math.min(1, t));
  return (inv ? 1 - t : t) * 100;
}
const avg = (a: (number | null)[]) => {
  const x = a.filter((v): v is number => v !== null && !Number.isNaN(v));
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null;
};
function pillars(r: Row, crypto: boolean) {
  const rsi = nz(r.RSI);
  const above200 = nz(r.close) !== null && nz(r.SMA200) ? (r.close > r.SMA200 ? 85 : 35) : null;
  if (crypto) {
    const momentum = avg([band(r["Perf.W"], -15, 15), band(r["Perf.1M"], -30, 40), band(r["Perf.3M"], -50, 80)]);
    const rs = rsi === null ? null : rsi < 30 ? 55 : rsi < 50 ? 70 : rsi < 65 ? 85 : rsi < 75 ? 55 : 25;
    return { value: null, quality: null, growth: null, momentum, tech: avg([band(r["Recommend.All"], -1, 1), rs, above200]) };
  }
  const pe = nz(r.price_earnings_ttm), pb = nz(r.price_book_fq), de = nz(r.debt_to_equity);
  const value = avg([pe !== null && pe > 0 ? band(pe, 5, 40, true) : pe !== null ? 20 : null,
    pb !== null && pb > 0 ? band(pb, 0.5, 6, true) : null, band(r.dividends_yield_current, 0, 7)]);
  const quality = avg([band(r.return_on_equity, 0, 30), band(r.net_margin_ttm, 0, 25),
    band(r.free_cash_flow_margin_ttm, -5, 25), de !== null ? band(de, 0, 2.5, true) : null,
    band(r.piotroski_f_score_ttm, 3, 9)]);
  const growth = avg([band(r.total_revenue_yoy_growth_ttm, -5, 35), band(r.earnings_per_share_diluted_yoy_growth_ttm, -10, 50)]);
  const momentum = avg([band(r["Perf.1M"], -12, 15), band(r["Perf.3M"], -20, 30), band(r["Perf.YTD"], -25, 45), band(r["Perf.Y"], -30, 60)]);
  const rs = rsi === null ? null : rsi < 30 ? 60 : rsi < 45 ? 70 : rsi < 60 ? 88 : rsi < 70 ? 65 : 30;
  const tech = avg([band(r["Recommend.All"], -1, 1), rs, above200,
    nz(r.SMA50) !== null && nz(r.SMA200) ? (r.SMA50 > r.SMA200 ? 80 : 40) : null]);
  return { value, quality, growth, momentum, tech };
}
const W = { value: 20, quality: 25, growth: 20, momentum: 20, tech: 15 } as const;
function score(p: Record<string, number | null>) {
  let s = 0, t = 0;
  for (const k of Object.keys(W) as (keyof typeof W)[]) { const v = p[k]; if (v === null) continue; s += v * W[k]; t += W[k]; }
  return t ? Math.round(s / t) : 0;
}

/* ---------------- คัดหุ้นเป็นกลุ่ม ---------------- */
const BULL = ["Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const r1 = (v: any, d = 1) => (nz(v) === null ? null : Math.round(+v * 10 ** d) / 10 ** d);
const slim = (r: Row) => ({
  symbol: r.symbol, name: r.name, desc: r.description ?? null, sector: r.sector ?? null,
  close: r1(r.close, 4), chg: r1(r.change, 2), score: r._score,
  p: Object.fromEntries(Object.entries(r._p).map(([k, v]) => [k, v === null ? null : Math.round(v as number)])),
  rsi: r1(r.RSI), pe: r1(r.price_earnings_ttm), dy: r1(r.dividends_yield_current, 2),
  roe: r1(r.return_on_equity), m1: r1(r["Perf.1M"]), m3: r1(r["Perf.3M"]), y1: r1(r["Perf.Y"]),
  rec: r1(r["Recommend.All"], 2), rvol: r1(r.relative_volume_10d_calc, 2),
  candle: BULL.find((k) => r[k] === 1)?.replace("Candle.", "") ?? null,
});

function pick(rows: Row[], crypto: boolean) {
  const by = (f: (r: Row) => boolean, k: (r: Row) => number, n = 5) =>
    rows.filter(f).sort((a, b) => k(b) - k(a)).slice(0, n).map(slim);
  const P = (r: Row, k: string) => (r._p[k] ?? -1) as number;
  const groups: Record<string, { title: string; note: string; items: any[] }> = {
    top: { title: "คะแนนรวมสูงสุด", note: "คะแนน 0–100 จาก 5 ด้านตามน้ำหนักมาตรฐาน",
      items: by(() => true, (r) => r._score, 10) },
    momentum: { title: "โมเมนตัมแรง ยังไม่ร้อนเกิน", note: "ราคาขึ้นต่อเนื่อง RSI ต่ำกว่า 70",
      items: by((r) => (nz(r.RSI) ?? 99) < 70 && (nz(r["Perf.1M"]) ?? 0) > 0, (r) => P(r, "momentum") + P(r, "tech")) },
    rebound: { title: "ขายมากเกินไป ลุ้นเด้ง", note: "RSI ต่ำกว่า 35" + (crypto ? "" : " และคุณภาพกิจการไม่แย่"),
      items: by((r) => (nz(r.RSI) ?? 99) < 35 && (crypto || P(r, "quality") >= 50), (r) => r._score) },
    signal: { title: "สัญญาณกลับตัวขาขึ้นวันนี้", note: "แท่งเทียนกลับตัวขาขึ้น + สัญญาณเทคนิคเป็นบวก",
      items: by((r) => BULL.some((k) => r[k] === 1) && (nz(r["Recommend.All"]) ?? 0) > 0, (r) => r._score) },
  };
  if (!crypto) {
    groups.value = { title: "ถูกและดี", note: "มูลค่าน่าสนใจ + คุณภาพกิจการดี",
      items: by((r) => P(r, "value") >= 55 && P(r, "quality") >= 55, (r) => P(r, "value") + P(r, "quality")) };
    groups.volume = { title: "วอลุ่มผิดปกติ", note: "ปริมาณซื้อขายสูงกว่าค่าเฉลี่ย 10 วันเกิน 2 เท่า",
      items: by((r) => (nz(r.relative_volume_10d_calc) ?? 0) >= 2, (r) => nz(r.relative_volume_10d_calc) ?? 0) };
  }
  for (const k of Object.keys(groups)) if (!groups[k].items.length) delete groups[k];
  return groups;
}

function breadthOf(rows: Row[]) {
  const ch = rows.map((r) => nz(r.change)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const up = ch.filter((v) => v > 0).length, dn = ch.filter((v) => v < 0).length;
  const ab = rows.filter((r) => nz(r.close) !== null && nz(r.SMA200)).map((r) => r.close > r.SMA200);
  const sec: Record<string, number[]> = {};
  rows.forEach((r) => { if (r.sector && nz(r.change) !== null) (sec[r.sector] ||= []).push(+r.change); });
  const secAvg = Object.entries(sec).filter(([, a]) => a.length >= 3)
    .map(([s, a]) => ({ s, v: Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 }))
    .sort((a, b) => b.v - a.v);
  return {
    n: rows.length, up, down: dn,
    median: ch.length ? Math.round(ch[Math.floor(ch.length / 2)] * 100) / 100 : null,
    above200: ab.length ? Math.round((ab.filter(Boolean).length / ab.length) * 100) : null,
    bestSectors: secAvg.slice(0, 3), worstSectors: secAvg.slice(-3).reverse(),
  };
}

/* ---------------- Gemini ---------------- */
async function askGemini(market: Market, breadth: any, groups: any) {
  if (!GEMINI_KEY) { console.warn("ไม่พบ Gemini key — ใช้สรุปจากกฎ"); return null; }
  const compact = Object.fromEntries(Object.entries(groups).map(([k, g]: any) => [k, {
    title: g.title, items: g.items.map((x: any) => ({
      symbol: x.symbol, name: x.desc || x.name, sector: x.sector, score: x.score, pillars: x.p,
      chg_today: x.chg, rsi: x.rsi, pe: x.pe, div_yield: x.dy, roe: x.roe,
      perf_1m: x.m1, perf_3m: x.m3, perf_1y: x.y1, tv_rating: x.rec, rel_volume: x.rvol, candle: x.candle,
    })),
  }]));
  const prompt = `คุณคือนักวิเคราะห์หุ้นที่เขียนสรุปตลาดประจำวันเป็นภาษาไทย กระชับ ตรงประเด็น อ่านง่ายสำหรับนักลงทุนรายย่อย
ตลาด: ${MARKET_TH[market]}
ภาพรวมตลาด (จากหลักทรัพย์ขนาดใหญ่ ${breadth.n} ตัว): ${JSON.stringify({
    จำนวนที่ขึ้น_ตัว: breadth.up, จำนวนที่ลง_ตัว: breadth.down,
    ค่ากลางการเปลี่ยนแปลงวันนี้_เปอร์เซ็นต์: breadth.median,
    สัดส่วนที่ยืนเหนือเส้นค่าเฉลี่ย200วัน_เปอร์เซ็นต์: breadth.above200,
    กลุ่มที่ดีที่สุด_เปลี่ยนแปลงเฉลี่ยเปอร์เซ็นต์: breadth.bestSectors, กลุ่มที่แย่ที่สุด_เปลี่ยนแปลงเฉลี่ยเปอร์เซ็นต์: breadth.worstSectors,
  })}
(หมายเหตุ: ค่าที่ลงท้ายด้วย _เปอร์เซ็นต์ เป็นร้อยละแล้ว เช่น 62 หมายถึง 62% ไม่ใช่ 62 ตัว)
หุ้นที่ระบบคัดมาเป็นกลุ่ม (คะแนน 0–100, pillars = value/quality/growth/momentum/tech): ${JSON.stringify(compact)}

กติกา
- ใช้เฉพาะตัวเลขที่ให้ไว้ ห้ามแต่งข่าว เหตุการณ์ งบการเงิน หรือราคาเป้าหมายที่ไม่มีในข้อมูล
- ห้ามแนะนำให้ซื้อหรือขาย ห้ามใช้คำว่า "ควรซื้อ" "น่าซื้อ" ให้อธิบายเพียงว่าเข้าเงื่อนไขเด่นอย่างไรจากตัวเลข
- เลือก "highlights" 3–5 ตัวที่เข้าเงื่อนไขเด่นที่สุดจากทุกกลุ่ม อธิบายเหตุผลจากตัวเลขสั้นๆ 1–2 ประโยค
- symbol ต้องตรงกับที่ให้มาทุกตัวอักษร

ตอบเป็น JSON เท่านั้น รูปแบบ:
{"headline":"หัวข้อสั้น ไม่เกิน 70 ตัวอักษร","summary":"สรุปภาพรวม 3–4 ประโยค","highlights":[{"symbol":"...","reason":"..."}],"risks":["ข้อควรระวัง 2–3 ข้อ"]}`;

  const t0 = Date.now();
  for (const model of GEMINI_MODELS) for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() - t0 > 90_000) return null;   // งบเวลารวม — เหลือเวลาบันทึกสรุปจากกฎก่อนครบ 150 วิ
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        signal: AbortSignal.timeout(30_000),   // Gemini ค้างได้ — ตัดทิ้งแล้วไปรุ่นถัดไป ไม่ให้ทั้งฟังก์ชันเกินเวลา
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 4096 },
        }),
      });
      if (!res.ok) {
        console.warn(model, res.status, (await res.text()).slice(0, 200));
        if ((res.status === 503 || res.status === 429) && attempt === 0) { await sleep(4000); continue; }  // คนใช้เยอะ รอแล้วลองซ้ำ
        break;                                                                                         // รุ่นนี้ใช้ไม่ได้ ไปรุ่นถัดไป
      }
      const j = await res.json();
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      const out = JSON.parse(text.replace(/^```json\s*|```$/g, "").trim());
      if (out && out.summary) return { ...out, model };
      break;
    } catch (e) { console.warn(model, String(e)); break; }
  }
  return null;
}

/* สรุปจากกฎ — ใช้เมื่อไม่มี AI */
function ruleSummary(market: Market, b: any, groups: any) {
  const mood = b.median === null || b.median === 0 ? "ทรงตัว" : b.median > 0.5 ? "บวกชัดเจน" : b.median > 0 ? "บวกเล็กน้อย"
    : b.median > -0.5 ? "ลบเล็กน้อย" : "ลบชัดเจน";
  const trend = b.above200 === null ? "" : b.above200 >= 60 ? "ภาพใหญ่ยังเป็นขาขึ้น" : b.above200 >= 40 ? "ภาพใหญ่ก้ำกึ่ง" : "ภาพใหญ่ยังอ่อนแอ";
  const top = groups.top?.items?.slice(0, 3) ?? [];
  return {
    headline: `${MARKET_TH[market]}วันนี้${mood} · ขึ้น ${b.up} ลง ${b.down}`,
    summary: `ตัวกลางเปลี่ยนแปลง ${b.median ?? "-"}% มีหลักทรัพย์ยืนเหนือเส้นค่าเฉลี่ย 200 วัน ${b.above200 ?? "-"}% ${trend}` +
      (b.bestSectors?.length ? ` กลุ่มที่แข็งแรงสุดคือ ${b.bestSectors.map((x: any) => x.s).join(", ")}` : "") +
      (top.length ? ` ตัวที่คะแนนรวมสูงสุดได้แก่ ${top.map((x: any) => `${x.name} (${x.score})`).join(", ")}` : ""),
    highlights: top.map((x: any) => ({ symbol: x.symbol, reason: `คะแนนรวม ${x.score} · RSI ${x.rsi ?? "-"} · 3 เดือน ${x.m3 ?? "-"}%` })),
    risks: [GEMINI_KEY ? "Gemini ไม่ตอบในรอบนี้ — สรุปนี้สร้างจากกฎอัตโนมัติ" : "สรุปนี้สร้างจากกฎอัตโนมัติ (ยังไม่ได้ตั้งค่า Gemini)",
      "คะแนนอิงข้อมูลย้อนหลัง ไม่ได้รวมข่าวล่าสุด"],
    model: "rules",
  };
}


/* ---------------- งานหลัก ---------------- */
const bkkDate = () => new Date(Date.now() + 7 * 3600_000);
async function runMarket(market: Market) {
  const crypto = market === "crypto";
  const rows = await tvScan(market);
  rows.forEach((r) => { r._p = pillars(r, crypto); r._score = score(r._p); });
  const groups = pick(rows, crypto);
  const breadth = breadthOf(rows);
  const ai = (await askGemini(market, breadth, groups)) ?? ruleSummary(market, breadth, groups);
  // ตัวที่ AI เลือก — ผูกเหตุผลกลับไปหาข้อมูลจริง ตัดตัวที่ AI อ้างชื่อผิดทิ้ง
  const all = new Map<string, any>();
  Object.values(groups).forEach((g: any) => g.items.forEach((x: any) => all.set(x.symbol, x)));
  const picks = (ai.highlights ?? []).filter((h: any) => all.has(h.symbol)).slice(0, 5)
    .map((h: any) => ({ ...all.get(h.symbol), reason: String(h.reason ?? "").slice(0, 400) }));
  const row = {
    scan_date: bkkDate().toISOString().slice(0, 10), market,
    headline: String(ai.headline ?? "").slice(0, 160), summary: String(ai.summary ?? "").slice(0, 2000),
    risks: (ai.risks ?? []).slice(0, 4).map((x: any) => String(x).slice(0, 300)),
    picks, groups, breadth, model: ai.model, scanned: rows.length,
  };
  const { error } = await db.from("daily_scans").upsert(row, { onConflict: "scan_date,market" });
  if (error) throw error;

  return { market, scanned: rows.length, picks: picks.length, model: ai.model };
}

async function authorized(req: Request) {
  const s = req.headers.get("x-cron-secret");
  if (s) { const { data } = await db.rpc("check_cron_secret", { s }); if (data === true) return "cron"; }
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (jwt && jwt !== SB_ANON) {
    const { data: u } = await db.auth.getUser(jwt);
    if (u?.user) {
      const { data: a } = await db.from("admins").select("user_id").eq("user_id", u.user.id).maybeSingle();
      if (a) return "admin";
    }
  }
  return null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const who = await authorized(req);
  if (!who) return json({ error: "unauthorized" }, 401);

  let markets: Market[] | undefined;
  try { const b = await req.json(); if (Array.isArray(b?.markets)) markets = b.markets; } catch { /* ไม่มี body */ }
  const valid: Market[] = ["thailand", "america", "crypto"];
  if (!markets) {
    const dow = bkkDate().getUTCDay();                       // 0 = อาทิตย์
    markets = dow === 0 || dow === 6 ? ["crypto"] : valid;   // เสาร์-อาทิตย์ ตลาดหุ้นปิด
  }
  markets = markets.filter((m) => valid.includes(m));

  const results = [];
  for (const m of markets) {
    try { results.push(await runMarket(m)); }
    catch (e) { console.error(m, e); results.push({ market: m, error: String((e as Error)?.message ?? e) }); }
  }
  return json({ by: who, results });
});
