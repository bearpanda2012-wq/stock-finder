/**
 * trade-signals — สัญญาณเข้าซื้อตามระบบ + ติดตามผลจริง
 *
 * ทำงานหลัง daily-scan ทุกเช้า (pg_cron 08:40 น. เวลาไทย) หรือแอดมินสั่งเอง
 *  1) ติดตามสัญญาณที่ยังเปิดอยู่ด้วยแท่งราคาล่าสุด → เข้าแล้ว / ถึงเป้า / โดนตัดขาดทุน / หมดอายุ
 *  2) ออกสัญญาณใหม่จากหุ้นที่ daily-scan คัดไว้วันนี้ ตามกติกาตายตัว (ไม่ใช่การทำนาย)
 *
 * กติกา (ทุกระยะอิง ATR = ความผันผวนเฉลี่ยต่อวัน)
 *  - pullback : ราคา > SMA200, SMA50 > SMA200, RSI 40–58, สัญญาณเทคนิคบวก → รอซื้อโซน [ปิด − 0.5 ATR, ปิด]
 *  - breakout : ห่างจุดสูงสุด 52 สัปดาห์ ≤ 3%, วอลุ่ม ≥ 1.5 เท่า, RSI < 72 → ซื้อเมื่อขึ้นเหนือ [ปิด, ปิด + 0.3 ATR]
 *  - rebound  : RSI < 32 + แท่งเทียนกลับตัวขาขึ้น (หุ้นต้องคุณภาพ ≥ 55) → โซน [ปิด − 0.3 ATR, ปิด]
 *  ตัดขาดทุน = ขอบล่างโซน − 1.5 ATR · เป้า 1 = 2R · เป้า 2 = 3.5R · อายุสัญญาณ 7 วัน (คริปโต 3 วัน)
 *  ถ้าวันเดียวแตะทั้งจุดตัดขาดทุนและเป้า นับเป็นขาดทุน (มองแง่ร้ายไว้ก่อน) · ถือเกิน 30 วันปิดที่ราคาปิด
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
type Market = "thailand" | "america" | "crypto";
type Row = Record<string, any>;

const COLS = ["name", "description", "close", "high", "low", "ATR", "RSI", "SMA50", "SMA200",
  "Recommend.All", "relative_volume_10d_calc", "price_52_week_high",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const LIVE_FIELDS = ["close", "high", "low", "ATR", "RSI", "SMA50", "SMA200", "Recommend.All", "relative_volume_10d_calc",
  "Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const BULL = ["Candle.3WhiteSoldiers", "Candle.MorningStar", "Candle.Engulfing.Bullish", "Candle.Hammer"];
const nz = (v: any) => (v === null || v === undefined || Number.isNaN(+v) ? null : +v);
const rp = (v: number) => { const a = Math.abs(v); const d = a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8; return Math.round(v * 10 ** d) / 10 ** d; };
// ช่วงราคาของตลาดหลักทรัพย์ฯ (SET) — ราคาต้องเป็นทวีคูณของช่วงนี้ถึงจะส่งคำสั่งได้จริง
const setTick = (v: number) => v < 2 ? 0.01 : v < 5 ? 0.02 : v < 10 ? 0.05 : v < 25 ? 0.1 : v < 100 ? 0.25 : v < 200 ? 0.5 : v < 400 ? 1 : 2;
const px = (m: Market, v: number, dir: "near" | "down" | "up" = "near") => {
  if (m !== "thailand") return rp(v);
  const t = setTick(v), f = dir === "down" ? Math.floor : dir === "up" ? Math.ceil : Math.round;
  return Math.round(f(v / t) * t * 100) / 100;
};
const addDays = (d: string, n: number) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function bars(market: Market, tickers: string[]): Promise<Map<string, Row>> {
  const m = new Map<string, Row>();
  if (!tickers.length) return m;
  const prev = market === "crypto", cols = prev ? [...COLS, ...LIVE_FIELDS.map((c) => c + "[1]")] : COLS;
  const res = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (stock-finder signals)" },
    body: JSON.stringify({ columns: cols, symbols: { tickers }, range: [0, tickers.length], options: { lang: "en" } }),
  });
  if (!res.ok) throw new Error(`TradingView HTTP ${res.status}`);
  const j = await res.json();
  for (const d of j.data ?? []) {
    const o: Row = { symbol: d.s }; cols.forEach((c, i) => (o[c] = d.d[i]));
    // คริปโตซื้อขายตลอด แท่ง [0] ตอน 08:40 น. เพิ่งเริ่มได้ 1 ชม.กว่า → ใช้แท่งที่ปิดแล้ว ([1]) ทั้งการออกและตรวจผล
    if (prev) LIVE_FIELDS.forEach((c) => { const x = o[c + "[1]"]; if (x !== undefined && x !== null) o[c] = x; });
    m.set(d.s, o);
  }
  return m;
}

/* 1) ติดตามสัญญาณที่เปิดอยู่ */
async function track(market: Market, today: string) {
  const { data: open } = await db.from("trade_signals").select("*").eq("market", market).in("status", ["open", "entered"]);
  if (!open?.length) return 0;
  const B = await bars(market, [...new Set(open.map((o: any) => o.symbol as string))]);
  let n = 0;
  for (const s of open as any[]) {
    if (s.signal_date >= today) continue;                      // ออกวันนี้ ยังไม่มีแท่งใหม่
    const b = B.get(s.symbol); if (!b) continue;
    const H = nz(b.high), L = nz(b.low), C = nz(b.close); if (H === null || L === null || C === null) continue;
    const u: any = { last_price: rp(C), updated_at: new Date().toISOString() };
    if (s.status === "open") {
      const hit = s.setup === "breakout" ? H >= +s.entry_low : L <= +s.entry_high;
      if (hit) {
        // ราคาเข้าแบบไม่เข้าข้างตัวเอง: breakout ได้ขอบบน, แบบรอย่อได้ขอบบนของช่วงที่ซื้อได้จริง
        u.entry_price = s.setup === "breakout" ? +s.entry_high : Math.max(+s.entry_low, Math.min(+s.entry_high, H));
        u.status = "entered"; u.entered_on = today; s.status = "entered"; s.entry_price = u.entry_price;
      } else if (today > s.valid_until) { u.status = "expired"; u.closed_on = today; }
    }
    if (s.status === "entered") {
      const e = +s.entry_price;
      const close = (px: number, st: string) => {
        u.status = st; u.exit_price = rp(px); u.closed_on = today; u.result_pct = Math.round(((px - e) / e) * 10000) / 100;
      };
      if (L <= +s.stop) close(+s.stop, "stopped");
      else if (H >= +s.target1) close(+s.target1, "target");
      else if (today > addDays(s.signal_date, 30)) close(C, "timeout");
    }
    await db.from("trade_signals").update(u).eq("id", s.id); n++;
  }
  return n;
}

/* 2) ออกสัญญาณใหม่จากหุ้นที่ daily-scan คัดไว้วันนี้ */
async function issue(market: Market, today: string) {
  const crypto = market === "crypto";
  const { data: scan } = await db.from("daily_scans").select("groups").eq("market", market).eq("scan_date", today).maybeSingle();
  if (!scan) return 0;
  const cand = new Map<string, any>();
  Object.values(scan.groups ?? {}).forEach((g: any) => (g.items ?? []).forEach((x: any) => cand.set(x.symbol, x)));
  const { data: still } = await db.from("trade_signals").select("symbol").eq("market", market).in("status", ["open", "entered"]);
  const skip = new Set((still ?? []).map((x: any) => x.symbol));
  const B = await bars(market, [...cand.keys()].filter((s) => !skip.has(s)));
  const out: any[] = [];
  for (const [sym, r] of B) {
    const meta = cand.get(sym); const score = +meta.score || 0, quality = meta.p?.quality ?? null;
    const c = nz(r.close), atr = nz(r.ATR), rsi = nz(r.RSI), s200 = nz(r.SMA200), s50 = nz(r.SMA50);
    if (c === null || !atr || atr <= 0 || rsi === null) continue;
    if (atr / c > (crypto ? 0.12 : 0.08)) continue;                         // ผันผวนเกินไป
    const rec = nz(r["Recommend.All"]) ?? 0, rvol = nz(r.relative_volume_10d_calc) ?? 0;
    const hi52 = nz(r.price_52_week_high), bull = BULL.find((k) => r[k] === 1);
    let setup = "", lo = 0, hi = 0, why = "";
    if (s200 && s50 && c > s200 && s50 > s200 && rsi >= 40 && rsi <= 58 && rec > 0 && score >= 60) {
      setup = "pullback"; hi = c; lo = c - 0.5 * atr;
      why = `แนวโน้มขาขึ้น (เหนือ SMA200 และ SMA50 > SMA200) กำลังย่อตัว RSI ${rsi.toFixed(0)} · คะแนนรวม ${score}`;
    } else if (hi52 && c >= hi52 * 0.97 && rvol >= 1.5 && rsi < 72 && rec > 0.1 && score >= 55) {
      setup = "breakout"; lo = c; hi = c + 0.3 * atr;
      why = `ใกล้จุดสูงสุด 52 สัปดาห์ (${rp(hi52)}) วอลุ่ม ${rvol.toFixed(1)} เท่าของค่าเฉลี่ย · คะแนนรวม ${score}`;
    } else if (rsi < 32 && bull && (crypto || (quality ?? 0) >= 55)) {
      setup = "rebound"; hi = c; lo = c - 0.3 * atr;
      why = `ขายมากเกินไป RSI ${rsi.toFixed(0)} และเกิดแท่งเทียน ${bull.replace("Candle.", "")} · คะแนนรวม ${score}`;
    } else continue;
    const stop = lo - 1.5 * atr, risk = hi - stop;
    if (stop <= 0 || risk <= 0) continue;
    out.push({
      signal_date: today, market, symbol: sym, name: meta.name ?? r.name, descr: meta.desc ?? r.description ?? null, setup,
      ref_price: px(market, c), entry_low: px(market, lo, "down"), entry_high: px(market, hi, "up"), stop: px(market, stop, "down"),
      target1: px(market, hi + 2 * risk), target2: px(market, hi + 3.5 * risk),
      valid_until: addDays(today, crypto ? 3 : 7), score, reason: why, last_price: rp(c),
    });
  }
  const pick = out.sort((a, b) => b.score - a.score).slice(0, 5);
  if (pick.length) {
    const { error } = await db.from("trade_signals").upsert(pick, { onConflict: "signal_date,market,symbol", ignoreDuplicates: true });
    if (error) throw error;
  }
  return pick.length;
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
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  let markets: Market[] = ["thailand", "america", "crypto"];
  try { const b = await req.json(); if (Array.isArray(b?.markets)) markets = b.markets; } catch { /* ไม่มี body */ }
  const today = bkkToday(), results = [];
  for (const m of markets) {
    try { const tracked = await track(m, today); const issued = await issue(m, today); results.push({ market: m, tracked, issued }); }
    catch (e) { console.error(m, e); results.push({ market: m, error: String((e as Error)?.message ?? e) }); }
  }
  return json({ today, results });
});
