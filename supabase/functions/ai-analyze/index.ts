/**
 * ai-analyze — บทวิเคราะห์รายตัวจาก Gemini สำหรับแผงรายละเอียดหุ้น
 *
 * - ต้องเข้าสู่ระบบ (verify_jwt) · หุ้นสหรัฐฯ/คริปโต เฉพาะ Pro/Lifetime/แอดมิน (เหมือนสิทธิ์ดูหน้าเว็บ)
 * - แคชวันละครั้งต่อหุ้นในตาราง ai_notes → คนถัดไปที่เปิดหุ้นเดียวกันได้ผลทันทีและไม่เปลืองโควตา Gemini
 * - สร้างใหม่ได้ไม่เกิน 30 ครั้ง/คน/วัน (อ่านของที่แคชไว้ไม่จำกัด)
 * - ดึงตัวเลขเองจาก TradingView ไม่รับตัวเลขจากเบราว์เซอร์ (กันการแต่งข้อมูลส่งมา)
 * - แผนเทรด (โซนเข้า/ตัดขาดทุน/เป้า) คำนวณด้วยกติกาตายตัว AI แค่อธิบาย ไม่ได้กำหนดตัวเลขเอง
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ??
  Object.entries(Deno.env.toObject()).find(([k, v]) => /gemini/i.test(k) && !/model/i.test(k) && v)?.[1] ?? "";
// บทวิเคราะห์สั้น ใช้รุ่น Lite ก่อน (เร็ว ไม่ค่อยติดคิว) แล้วค่อยรุ่นใหญ่
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"]
  .filter(Boolean) as string[];
const DAILY_LIMIT = 30;
type Market = "thailand" | "america" | "crypto";
const MK: Record<Market, string> = { thailand: "หุ้นไทย", america: "หุ้นสหรัฐฯ", crypto: "คริปโต" };

const BASE = ["name", "description", "close", "change", "ATR", "RSI", "SMA50", "SMA200",
  "Recommend.All", "relative_volume_10d_calc", "price_52_week_high", "price_52_week_low",
  "Perf.W", "Perf.1M", "Perf.3M", "Perf.YTD", "Perf.Y",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const STOCK_EXTRA = ["sector", "industry", "market_cap_basic", "price_earnings_ttm", "price_book_fq", "return_on_equity",
  "net_margin_ttm", "debt_to_equity", "dividends_yield_current", "total_revenue_yoy_growth_ttm",
  "earnings_per_share_diluted_yoy_growth_ttm", "free_cash_flow_margin_ttm", "piotroski_f_score_ttm"];
// ค่าของแท่งวันก่อน — ใช้เมื่อแท่งวันนี้ยังไม่ปิด (ตรงกับ PLAN_FIELDS ในหน้าเว็บ)
const PLAN_FIELDS = ["close", "ATR", "RSI", "SMA50", "SMA200", "Recommend.All", "relative_volume_10d_calc",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const colsFor = (crypto: boolean) => [...BASE, ...(crypto ? [] : STOCK_EXTRA), ...PLAN_FIELDS.map((f) => f + "[1]")];
const BULL = ["Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const nz = (v: any) => (v === null || v === undefined || Number.isNaN(+v) ? null : +v);
const r2 = (v: any, d = 2) => (nz(v) === null ? null : Math.round(+v * 10 ** d) / 10 ** d);
/* แท่งอ้างอิง = แท่งรายวันล่าสุดที่ปิดแล้ว (กติกาเดียวกับ planBasis() ในหน้าเว็บ)
   day = รหัสรอบของแท่งอ้างอิง ใช้เป็นกุญแจแคช → บทวิเคราะห์กับตารางในแอปใช้ตัวเลขชุดเดียวกันเสมอ */
const PLAN_MKT: Record<string, [string, number, number]> = { thailand: ["Asia/Bangkok", 10, 16.75], america: ["America/New_York", 9.5, 16.25] };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
function tzParts(tz: string, t: number) {
  const o: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(t)).forEach((p) => (o[p.type] = p.value));
  return { date: `${o.year}-${o.month}-${o.day}`, h: (+o.hour % 24) + +o.minute / 60, wd: o.weekday };
}
function planBasis(m: Market, t = Date.now()) {
  if (m === "crypto") return { prev: true, day: new Date(t).toISOString().slice(0, 10) };
  const [tz, open, close] = PLAN_MKT[m], p = tzParts(tz, t);
  return { prev: WEEKDAYS.includes(p.wd) && p.h >= open && p.h < close, day: tzParts(tz, t + (24 - close) * 3600_000).date };
}

/* คะแนน 5 ด้าน น้ำหนักมาตรฐาน (ตรงกับ pillars()/planScore() ในหน้าเว็บ) */
function band(v: any, lo: number, hi: number, inv = false) {
  const x = nz(v); if (x === null) return null;
  let t = (x - lo) / (hi - lo); t = Math.max(0, Math.min(1, t)); return (inv ? 1 - t : t) * 100;
}
const avg = (a: (number | null)[]) => { const x = a.filter((v): v is number => v !== null && !Number.isNaN(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
function planScore(r: any, crypto: boolean) {
  const rsi = nz(r.RSI), above200 = nz(r.close) !== null && nz(r.SMA200) ? (r.close > r.SMA200 ? 85 : 35) : null;
  let p: Record<string, number | null>;
  if (crypto) {
    const rs = rsi === null ? null : rsi < 30 ? 55 : rsi < 50 ? 70 : rsi < 65 ? 85 : rsi < 75 ? 55 : 25;
    p = { value: null, quality: null, growth: null,
      momentum: avg([band(r["Perf.W"], -15, 15), band(r["Perf.1M"], -30, 40), band(r["Perf.3M"], -50, 80)]),
      tech: avg([band(r["Recommend.All"], -1, 1), rs, above200]) };
  } else {
    const pe = nz(r.price_earnings_ttm), pb = nz(r.price_book_fq), de = nz(r.debt_to_equity);
    const rs = rsi === null ? null : rsi < 30 ? 60 : rsi < 45 ? 70 : rsi < 60 ? 88 : rsi < 70 ? 65 : 30;
    p = {
      value: avg([pe !== null && pe > 0 ? band(pe, 5, 40, true) : pe !== null ? 20 : null,
        pb !== null && pb > 0 ? band(pb, 0.5, 6, true) : null, band(r.dividends_yield_current, 0, 7)]),
      quality: avg([band(r.return_on_equity, 0, 30), band(r.net_margin_ttm, 0, 25), band(r.free_cash_flow_margin_ttm, -5, 25),
        de !== null ? band(de, 0, 2.5, true) : null, band(r.piotroski_f_score_ttm, 3, 9)]),
      growth: avg([band(r.total_revenue_yoy_growth_ttm, -5, 35), band(r.earnings_per_share_diluted_yoy_growth_ttm, -10, 50)]),
      momentum: avg([band(r["Perf.1M"], -12, 15), band(r["Perf.3M"], -20, 30), band(r["Perf.YTD"], -25, 45), band(r["Perf.Y"], -30, 60)]),
      tech: avg([band(r["Recommend.All"], -1, 1), rs, above200, nz(r.SMA50) !== null && nz(r.SMA200) ? (r.SMA50 > r.SMA200 ? 80 : 40) : null]),
    };
  }
  const W: Record<string, number> = { value: 20, quality: 25, growth: 20, momentum: 20, tech: 15 };
  let s = 0, t = 0; for (const k in W) { const v = p[k]; if (v === null) continue; s += v * W[k]; t += W[k]; }
  return { score: t ? Math.round(s / t) : 0, quality: p.quality };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ปัดราคาให้ตรงกับที่แสดงในแอป (หุ้นไทยใช้ช่วงราคา SET)
const setTick = (v: number) => v < 2 ? 0.01 : v < 5 ? 0.02 : v < 10 ? 0.05 : v < 25 ? 0.1 : v < 100 ? 0.25 : v < 200 ? 0.5 : v < 400 ? 1 : 2;
let MKT: Market = "thailand";
const px = (v: number, dir: "near" | "down" | "up" = "near") => {
  if (MKT !== "thailand") { const a = Math.abs(v), d = a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8; return Math.round(v * 10 ** d) / 10 ** d; }
  const t = setTick(v), f = dir === "down" ? Math.floor : dir === "up" ? Math.ceil : Math.round;
  return Math.round(f(v / t) * t * 100) / 100;
};

/* แผนเทรดแบบเดียวกับ trade-signals / หน้าเว็บ */
function plan(r: any, crypto: boolean) {
  const c = nz(r.close), atr = nz(r.ATR), rsi = nz(r.RSI), s200 = nz(r.SMA200), s50 = nz(r.SMA50);
  if (c === null || !atr || rsi === null) return null;
  if (atr / c > (crypto ? 0.12 : 0.08)) return null;
  const rec = nz(r["Recommend.All"]) ?? 0, rvol = nz(r.relative_volume_10d_calc) ?? 0, hi52 = nz(r.price_52_week_high);
  const bull = BULL.find((k) => r[k] === 1), { score, quality } = planScore(r, crypto);
  let setup = "", lo = 0, hi = 0;
  if (s200 && s50 && c > s200 && s50 > s200 && rsi >= 40 && rsi <= 58 && rec > 0 && score >= 60) { setup = "ย่อในขาขึ้น"; hi = c; lo = c - 0.5 * atr; }
  else if (hi52 && c >= hi52 * 0.97 && rvol >= 1.5 && rsi < 72 && rec > 0.1 && score >= 55) { setup = "ทะลุจุดสูงสุด"; lo = c; hi = c + 0.3 * atr; }
  else if (rsi < 32 && bull && (crypto || (quality ?? 0) >= 55)) { setup = "เด้งจากขายมากเกิน"; hi = c; lo = c - 0.3 * atr; }
  else return null;
  const stop = lo - 1.5 * atr, risk = hi - stop;
  return { setup, basis_close: px(c), entry: [px(lo, "down"), px(hi, "up")], stop: px(stop, "down"), reference1: px(hi + 2 * risk), reference2: px(hi + 3.5 * risk) };
}

async function gemini(prompt: string) {
  const t0 = Date.now();
  for (const model of MODELS) for (let i = 0; i < 2; i++) {
    if (Date.now() - t0 > 80_000) return null;          // งบเวลารวม — ตอบผู้ใช้ก่อนหมดเวลา 150 วิ
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        signal: AbortSignal.timeout(25_000),   // Gemini ค้างได้ — ตัดทิ้งแล้วไปรุ่นถัดไป ไม่ให้ทั้งฟังก์ชันเกินเวลา
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, responseMimeType: "application/json", maxOutputTokens: 2048 } }),
      });
      if (!res.ok) {
        console.warn(model, res.status, (await res.text()).slice(0, 160));
        if ((res.status === 503 || res.status === 429) && i === 0) { await sleep(3000); continue; }
        break;
      }
      const j = await res.json();
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      const out = JSON.parse(text.replace(/^```json\s*|```$/g, "").trim());
      if (out?.summary) return { out, model };
      break;
    } catch (e) { console.warn(model, String(e)); break; }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // ผู้ใช้ที่ล็อกอิน (verify_jwt ตรวจลายเซ็นแล้ว ที่นี่แค่ดึงตัวตน)
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(jwt);
  const uid = u?.user?.id; if (!uid) return json({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const symbol = String(body.symbol ?? ""), market = String(body.market ?? "") as Market;
  if (!/^[A-Z0-9_]{1,20}:[A-Z0-9._!\-]{1,30}$/.test(symbol) || !MK[market]) return json({ error: "ข้อมูลหุ้นไม่ถูกต้อง" }, 400);

  // สิทธิ์ตลาด
  if (market !== "thailand") {
    const [{ data: p }, { data: a }] = await Promise.all([
      db.from("profiles").select("tier,tier_expires_at").eq("id", uid).maybeSingle(),
      db.from("admins").select("user_id").eq("user_id", uid).maybeSingle(),
    ]);
    const paid = p && ["pro", "lifetime"].includes(p.tier) && (!p.tier_expires_at || new Date(p.tier_expires_at) > new Date());
    if (!paid && !a) return json({ error: "บทวิเคราะห์หุ้นสหรัฐฯ และคริปโตสำหรับสมาชิก Pro" }, 403);
  }

  const basis = planBasis(market), d = basis.day;
  const { data: hit } = await db.from("ai_notes").select("analysis,model,note_date,created_at").eq("symbol", symbol).eq("note_date", d).maybeSingle();
  if (hit) return json({ symbol, date: hit.note_date, created: hit.created_at, model: hit.model, analysis: hit.analysis, cached: true });

  const { count } = await db.from("ai_notes").select("id", { count: "exact", head: true }).eq("created_by", uid).eq("note_date", d);
  if ((count ?? 0) >= DAILY_LIMIT) return json({ error: `ใช้ครบ ${DAILY_LIMIT} ครั้งของวันนี้แล้ว (หุ้นที่มีคนวิเคราะห์ไว้แล้วยังเปิดดูได้)` }, 429);
  if (!GEMINI_KEY) return json({ error: "ยังไม่ได้ตั้งค่า Gemini" }, 503);

  // ตัวเลขจาก TradingView
  const res = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (stock-finder ai)" },
    body: JSON.stringify({ columns: colsFor(market === "crypto"), symbols: { tickers: [symbol] }, range: [0, 1], options: { lang: "en" } }),
  });
  if (!res.ok) return json({ error: `ดึงข้อมูลราคาไม่สำเร็จ (${res.status})` }, 502);
  const row = (await res.json()).data?.[0]; if (!row) return json({ error: "ไม่พบหุ้นนี้" }, 404);
  const crypto = market === "crypto"; MKT = market;
  const r: any = {}; colsFor(crypto).forEach((c, i) => (r[c] = row.d[i]));
  const v: any = { ...r };                                   // มุมมองแท่งอ้างอิงสำหรับคำนวณโซนราคา
  if (basis.prev) PLAN_FIELDS.forEach((f) => { const x = r[f + "[1]"]; if (x !== undefined && x !== null) v[f] = x; });
  const facts: any = {
    symbol, name: r.description || r.name, sector: r.sector, industry: r.industry,
    price: r2(r.close, 4), chg_today_pct: r2(r.change), rsi14: r2(r.RSI, 1), atr: r2(r.ATR, 4),
    sma50: r2(r.SMA50, 4), sma200: r2(r.SMA200, 4), tv_rating_minus1_to_1: r2(r["Recommend.All"]),
    rel_volume: r2(r.relative_volume_10d_calc), high_52w: r2(r.price_52_week_high, 4), low_52w: r2(r.price_52_week_low, 4),
    perf_1m_pct: r2(r["Perf.1M"]), perf_3m_pct: r2(r["Perf.3M"]), perf_ytd_pct: r2(r["Perf.YTD"]), perf_1y_pct: r2(r["Perf.Y"]),
  };
  if (!crypto) Object.assign(facts, {
    pe: r2(r.price_earnings_ttm), pb: r2(r.price_book_fq), roe_pct: r2(r.return_on_equity), net_margin_pct: r2(r.net_margin_ttm),
    debt_to_equity: r2(r.debt_to_equity), div_yield_pct: r2(r.dividends_yield_current),
    revenue_growth_yoy_pct: r2(r.total_revenue_yoy_growth_ttm), eps_growth_yoy_pct: r2(r.earnings_per_share_diluted_yoy_growth_ttm),
  });
  const p = plan(v, crypto);

  const prompt = `คุณคือนักวิเคราะห์ที่เขียนบทวิเคราะห์สั้นเป็นภาษาไทยให้นักลงทุนรายย่อย
หลักทรัพย์: ${facts.name} (${symbol}) · ตลาด: ${MK[market]}
ข้อมูลล่าสุด (ค่าที่ลงท้าย _pct เป็นร้อยละแล้ว): ${JSON.stringify(facts)}
โซนราคาที่ระบบคำนวณด้วยกติกาตายตัวจาก ATR (อ้างอิงแท่งรายวันที่ปิดแล้ว ราคาปิด basis_close): ${p ? JSON.stringify(p) : "ไม่มี — ยังไม่เข้าเงื่อนไขรูปแบบใด"}

กติกา
- ใช้เฉพาะตัวเลขข้างบน ห้ามแต่งข่าว เหตุการณ์ งบการเงิน หรือราคาเป้าหมายอื่นที่ไม่มีในข้อมูล
- ห้ามแนะนำให้ซื้อหรือขาย ห้ามใช้คำว่า "ควรซื้อ" "น่าซื้อ" ห้ามรับประกันผล ห้ามเปลี่ยนตัวเลขของโซนราคา
- plan_comment: อธิบายว่าโซนราคาตามเงื่อนไขนี้มีจุดที่ต้องระวังอะไร (ถ้าไม่มี ให้บอกว่ายังขาดเงื่อนไขใด)

ตอบเป็น JSON เท่านั้น:
{"summary":"ภาพรวม 2–3 ประโยค","strengths":["จุดแข็ง 2–3 ข้อ"],"risks":["ความเสี่ยง 2–3 ข้อ"],"plan_comment":"1–2 ประโยค"}`;

  const g = await gemini(prompt);
  if (!g) return json({ error: "AI ไม่ตอบในตอนนี้ ลองใหม่อีกสักครู่" }, 503);
  const clip = (x: any, n: number) => String(x ?? "").slice(0, n);
  const analysis = {
    summary: clip(g.out.summary, 800),
    strengths: (g.out.strengths ?? []).slice(0, 4).map((x: any) => clip(x, 300)),
    risks: (g.out.risks ?? []).slice(0, 4).map((x: any) => clip(x, 300)),
    plan_comment: clip(g.out.plan_comment, 500),
  };
  await db.from("ai_notes").upsert({ symbol, market, note_date: d, analysis, model: g.model, created_by: uid },
    { onConflict: "symbol,note_date", ignoreDuplicates: true });
  return json({ symbol, date: d, created: new Date().toISOString(), model: g.model, analysis, cached: false });
});
