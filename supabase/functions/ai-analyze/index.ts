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

const COLS = ["name", "description", "sector", "industry", "close", "change", "ATR", "RSI", "SMA50", "SMA200",
  "Recommend.All", "relative_volume_10d_calc", "price_52_week_high", "price_52_week_low",
  "Perf.1M", "Perf.3M", "Perf.YTD", "Perf.Y", "market_cap_basic", "market_cap_calc",
  "price_earnings_ttm", "price_book_fq", "return_on_equity", "net_margin_ttm", "debt_to_equity",
  "dividends_yield_current", "total_revenue_yoy_growth_ttm", "earnings_per_share_diluted_yoy_growth_ttm",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const BULL = ["Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const nz = (v: any) => (v === null || v === undefined || Number.isNaN(+v) ? null : +v);
const r2 = (v: any, d = 2) => (nz(v) === null ? null : Math.round(+v * 10 ** d) / 10 ** d);
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
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
  const bull = BULL.find((k) => r[k] === 1);
  let setup = "", lo = 0, hi = 0;
  if (s200 && s50 && c > s200 && s50 > s200 && rsi >= 40 && rsi <= 58 && rec > 0) { setup = "ย่อในขาขึ้น"; hi = c; lo = c - 0.5 * atr; }
  else if (hi52 && c >= hi52 * 0.97 && rvol >= 1.5 && rsi < 72 && rec > 0.1) { setup = "ทะลุจุดสูงสุด"; lo = c; hi = c + 0.3 * atr; }
  else if (rsi < 32 && bull) { setup = "เด้งจากขายมากเกิน"; hi = c; lo = c - 0.3 * atr; }
  else return null;
  const stop = lo - 1.5 * atr, risk = hi - stop;
  return { setup, entry: [px(lo, "down"), px(hi, "up")], stop: px(stop, "down"), target1: px(hi + 2 * risk), target2: px(hi + 3.5 * risk) };
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

  const d = today();
  const { data: hit } = await db.from("ai_notes").select("analysis,model,note_date").eq("symbol", symbol).eq("note_date", d).maybeSingle();
  if (hit) return json({ symbol, date: hit.note_date, model: hit.model, analysis: hit.analysis, cached: true });

  const { count } = await db.from("ai_notes").select("id", { count: "exact", head: true }).eq("created_by", uid).eq("note_date", d);
  if ((count ?? 0) >= DAILY_LIMIT) return json({ error: `ใช้ครบ ${DAILY_LIMIT} ครั้งของวันนี้แล้ว (หุ้นที่มีคนวิเคราะห์ไว้แล้วยังเปิดดูได้)` }, 429);
  if (!GEMINI_KEY) return json({ error: "ยังไม่ได้ตั้งค่า Gemini" }, 503);

  // ตัวเลขจาก TradingView
  const res = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (stock-finder ai)" },
    body: JSON.stringify({ columns: COLS, symbols: { tickers: [symbol] }, range: [0, 1], options: { lang: "en" } }),
  });
  if (!res.ok) return json({ error: `ดึงข้อมูลราคาไม่สำเร็จ (${res.status})` }, 502);
  const row = (await res.json()).data?.[0]; if (!row) return json({ error: "ไม่พบหุ้นนี้" }, 404);
  const r: any = {}; COLS.forEach((c, i) => (r[c] = row.d[i]));
  const crypto = market === "crypto"; MKT = market;
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
  const p = plan(r, crypto);

  const prompt = `คุณคือนักวิเคราะห์ที่เขียนบทวิเคราะห์สั้นเป็นภาษาไทยให้นักลงทุนรายย่อย
หลักทรัพย์: ${facts.name} (${symbol}) · ตลาด: ${MK[market]}
ข้อมูลล่าสุด (ค่าที่ลงท้าย _pct เป็นร้อยละแล้ว): ${JSON.stringify(facts)}
แผนเทรดที่ระบบคำนวณด้วยกติกาตายตัวจาก ATR: ${p ? JSON.stringify(p) : "ไม่มี — ยังไม่เข้าเงื่อนไขรูปแบบใด"}

กติกา
- ใช้เฉพาะตัวเลขข้างบน ห้ามแต่งข่าว เหตุการณ์ งบการเงิน หรือราคาเป้าหมายอื่นที่ไม่มีในข้อมูล
- ห้ามสั่งซื้อหรือขาย ห้ามรับประกันผล ห้ามเปลี่ยนตัวเลขของแผนเทรด
- plan_comment: อธิบายว่าแผนนี้สมเหตุสมผลหรือมีจุดต้องระวังอะไร (ถ้าไม่มีแผน ให้บอกว่าควรรอสัญญาณอะไร)

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
  return json({ symbol, date: d, model: g.model, analysis, cached: false });
});
