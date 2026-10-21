/**
 * notify — อีเมลแจ้งเตือนผ่าน Resend
 *
 *  mode "health"  (pg_cron 09:00 น.) ตรวจว่างานเช้าสำเร็จครบ ถ้ามีปัญหาส่งอีเมลหาแอดมินทุกคน
 *  mode "signals" (pg_cron 09:05 น.) ส่งสรุปรายการที่เข้าเงื่อนไข/เปลี่ยนสถานะวันนี้ ให้สมาชิกที่เปิดรับเอง
 *  mode "test"    (แอดมินกดในแอป) ส่งอีเมลทดสอบหาตัวเอง เพื่อเช็กว่าตั้งค่า Resend ถูก
 *  GET ?unsub=<token>  ยกเลิกรับอีเมล (ลิงก์ท้ายอีเมล ไม่ต้องล็อกอิน)
 *
 * Secrets: RESEND_API_KEY (จำเป็น) · ALERT_FROM (ไม่ใส่ก็ได้) · APP_URL (ไม่ใส่ก็ได้)
 *   ALERT_FROM ค่าเริ่มต้น onboarding@resend.dev ส่งได้เฉพาะอีเมลเจ้าของบัญชี Resend
 *   ถ้าจะส่งให้สมาชิก ต้องยืนยันโดเมนของตัวเองใน Resend แล้วตั้ง ALERT_FROM เป็นอีเมลโดเมนนั้น
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESEND = Deno.env.get("RESEND_API_KEY") ??
  Object.entries(Deno.env.toObject()).find(([k, v]) => /resend/i.test(k) && v)?.[1] ?? "";
const FROM = Deno.env.get("ALERT_FROM") || "ค้นหาหุ้นอัจฉริยะ <onboarding@resend.dev>";
const APP = Deno.env.get("APP_URL") || "https://bearpanda2012-wq.github.io/stock-finder/";
type Market = "thailand" | "america" | "crypto";
const MK: Record<Market, string> = { thailand: "หุ้นไทย", america: "หุ้นสหรัฐฯ", crypto: "คริปโต" };
const SETUP: Record<string, string> = { pullback: "ย่อในขาขึ้น", breakout: "ทะลุจุดสูงสุด", rebound: "เด้งจากขายมากเกิน" };
const ST: Record<string, string> = { open: "รอถึงโซน", entered: "ถึงโซนแล้ว", target: "ถึงระดับอ้างอิง", stopped: "ต่ำกว่าจุดหยุด", expired: "หมดอายุ", timeout: "ครบเวลา" };

const bkk = () => new Date(Date.now() + 7 * 3600_000);
const today = () => bkk().toISOString().slice(0, 10);
const weekend = () => [0, 6].includes(bkk().getUTCDay());
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fp = (v: any) => (v === null || v === undefined ? "—" : (+v).toLocaleString("en-US", { maximumFractionDigits: +v >= 100 ? 2 : +v >= 1 ? 3 : 6 }));

async function send(to: string, subject: string, html: string, unsub?: string) {
  if (!RESEND) throw new Error("ยังไม่ได้ตั้งค่า RESEND_API_KEY");
  const headers: Record<string, string> = {};
  if (unsub) { headers["List-Unsubscribe"] = `<${unsub}>`; headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, headers }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const shell = (title: string, body: string, foot = "") => `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Tahoma,Arial,sans-serif;color:#0f1b33">
<div style="max-width:640px;margin:0 auto;padding:20px">
<div style="background:#0f1b33;color:#fff;border-radius:12px 12px 0 0;padding:14px 18px;font-weight:bold">ค้นหาหุ้นอัจฉริยะ</div>
<div style="background:#fff;border:1px solid #e3e8f0;border-top:0;border-radius:0 0 12px 12px;padding:18px">
<h2 style="margin:0 0 10px;font-size:18px">${title}</h2>${body}
<p style="margin:18px 0 0"><a href="${APP}" style="background:#2156d9;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">เปิดแอป</a></p>
</div>
<p style="font-size:11px;color:#5b6780;line-height:1.6">เครื่องมือคัดกรองหลักทรัพย์ตามเงื่อนไขเพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน ผลในอดีตไม่รับประกันอนาคต ${foot}</p>
</div></body></html>`;

async function adminEmails() {
  const { data: a } = await db.from("admins").select("user_id");
  const ids = (a ?? []).map((x: any) => x.user_id);
  if (!ids.length) return [];
  const { data: p } = await db.from("profiles").select("email").in("id", ids);
  return (p ?? []).map((x: any) => x.email).filter(Boolean) as string[];
}

/* ---------- health ---------- */
async function health() {
  const d = today(), want: Market[] = weekend() ? ["crypto"] : ["thailand", "america", "crypto"];
  const problems: string[] = [], warns: string[] = [];
  const { data: scans } = await db.from("daily_scans").select("market,model,scanned").eq("scan_date", d);
  for (const m of want) {
    const s = (scans ?? []).find((x: any) => x.market === m);
    if (!s) problems.push(`ไม่มีผลสแกน${MK[m]}ของวันนี้`);
    else if (s.model === "rules") warns.push(`${MK[m]}: Gemini ไม่ตอบ ใช้สรุปจากกฎแทน`);
    else if ((s.scanned ?? 0) < 50) warns.push(`${MK[m]}: สแกนได้แค่ ${s.scanned} ตัว (ปกติ 100+)`);
  }
  const { data: h } = await db.rpc("cron_health", { since: "3 hours" });
  for (const j of h?.jobs ?? []) if (!/^notify/.test(j.job) && !["succeeded", "running"].includes(j.status)) problems.push(`งานตั้งเวลา ${j.job} ล้มเหลว: ${j.msg ?? ""}`);
  for (const e of h?.http_errors ?? []) problems.push(`เรียกฟังก์ชันไม่สำเร็จ (HTTP ${e.status ?? "—"}${e.timed_out ? " หมดเวลา" : ""}) ${e.err ?? ""}`);
  const ran = (h?.jobs ?? []).some((j: any) => j.job === "daily-trade-signals");
  if (!ran) warns.push("ไม่พบการทำงานของ daily-trade-signals ใน 3 ชม.ที่ผ่านมา");

  if (!problems.length && !warns.length) return { ok: true, sent: 0 };
  const li = (xs: string[], c: string) => xs.map((x) => `<li style="color:${c};margin:4px 0">${esc(x)}</li>`).join("");
  const html = shell(problems.length ? "งานเช้ามีปัญหา" : "งานเช้าสำเร็จ แต่มีข้อสังเกต",
    `<ul style="padding-left:18px">${li(problems, "#c8402f")}${li(warns, "#9a6700")}</ul>
     <p style="font-size:13px;color:#5b6780">แก้ได้โดยให้แอดมินกด "⟳ สแกนตอนนี้" ในแอป หรือดู log ที่ Supabase → Edge Functions</p>`);
  const to = await adminEmails(); let sent = 0;
  for (const e of to) { try { await send(e, `${problems.length ? "⚠️" : "ℹ️"} ค้นหาหุ้นอัจฉริยะ: สถานะงานเช้า ${d}`, html); sent++; } catch (x) { console.error(e, x); } }
  return { ok: false, problems, warns, sent };
}

/* ---------- member digest ---------- */
async function signals() {
  const d = today(), mkts: Market[] = weekend() ? ["crypto"] : ["thailand", "america", "crypto"];
  const { data: fresh } = await db.from("trade_signals").select("*").eq("signal_date", d).in("market", mkts);
  const { data: moved } = await db.from("trade_signals").select("*").in("market", mkts).or(`entered_on.eq.${d},closed_on.eq.${d}`);
  if (!(fresh?.length || moved?.length)) return { sent: 0, note: "วันนี้ไม่มีรายการใหม่หรือเปลี่ยนสถานะ" };

  const { data: prefs } = await db.from("alert_prefs").select("*").eq("email_signals", true);
  if (!prefs?.length) return { sent: 0, note: "ยังไม่มีสมาชิกเปิดรับ" };
  const ids = prefs.map((p: any) => p.user_id);
  const [{ data: profs }, { data: adm }, { data: wl }] = await Promise.all([
    db.from("profiles").select("id,email,tier,tier_expires_at").in("id", ids),
    db.from("admins").select("user_id").in("user_id", ids),
    db.from("watchlist").select("user_id,symbol").in("user_id", ids),
  ]);
  const P = new Map((profs ?? []).map((x: any) => [x.id, x])), A = new Set((adm ?? []).map((x: any) => x.user_id));
  let sent = 0, skipped = 0;
  for (const pr of prefs as any[]) {
    const p: any = P.get(pr.user_id); if (!p?.email) continue;
    const paid = A.has(pr.user_id) || (["pro", "lifetime"].includes(p.tier) && (!p.tier_expires_at || new Date(p.tier_expires_at) > new Date()));
    const allow = new Set((pr.markets as Market[]).filter((m) => paid || m === "thailand"));
    const mine = pr.watch_only ? new Set((wl ?? []).filter((w: any) => w.user_id === pr.user_id).map((w: any) => w.symbol)) : null;
    const ok = (r: any) => allow.has(r.market) && (!mine || mine.has(r.symbol));
    const nf = (fresh ?? []).filter(ok), nm = (moved ?? []).filter(ok);
    if (!nf.length && !nm.length) { skipped++; continue; }
    // กันส่งซ้ำวันเดียวกัน
    const { data: lg, error: le } = await db.from("alert_log").insert({ kind: "digest", user_id: pr.user_id, ref: d }).select("id");
    if (le || !lg?.length) { skipped++; continue; }

    const row = (r: any, showSt: boolean) => `<tr>
      <td style="padding:6px;border-bottom:1px solid #eef1f6"><b>${esc(r.name || r.symbol)}</b><br><span style="font-size:11px;color:#5b6780">${esc(MK[r.market as Market])} · ${esc(SETUP[r.setup] || r.setup)}</span></td>
      <td style="padding:6px;border-bottom:1px solid #eef1f6;white-space:nowrap">${fp(r.entry_low)} – ${fp(r.entry_high)}</td>
      <td style="padding:6px;border-bottom:1px solid #eef1f6;white-space:nowrap;color:#c8402f">${fp(r.stop)}</td>
      <td style="padding:6px;border-bottom:1px solid #eef1f6;white-space:nowrap;color:#0d8a5f">${fp(r.target1)}</td>
      ${showSt ? `<td style="padding:6px;border-bottom:1px solid #eef1f6">${esc(ST[r.status] || r.status)}${r.result_pct !== null && r.result_pct !== undefined ? ` (${+r.result_pct > 0 ? "+" : ""}${r.result_pct}%)` : ""}</td>` : ""}</tr>`;
    const th = (st: boolean) => `<tr style="text-align:left;font-size:12px;color:#5b6780"><th style="padding:6px">หลักทรัพย์</th><th style="padding:6px">โซนราคา</th><th style="padding:6px">จุดหยุดอ้างอิง</th><th style="padding:6px">ระดับอ้างอิง 1</th>${st ? '<th style="padding:6px">สถานะ</th>' : ""}</tr>`;
    const body = (nf.length ? `<h3 style="font-size:15px;margin:14px 0 4px">เข้าเงื่อนไขใหม่วันนี้ (${nf.length})</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px">${th(false)}${nf.map((r) => row(r, false)).join("")}</table>` : "") +
      (nm.length ? `<h3 style="font-size:15px;margin:16px 0 4px">เปลี่ยนสถานะ (${nm.length})</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px">${th(true)}${nm.map((r) => row(r, true)).join("")}</table>` : "");
    const unsub = `${SB_URL}/functions/v1/notify?unsub=${pr.unsub_token}`;
    try {
      await send(p.email, `สรุปการคัดกรองประจำวัน ${d} · ${nf.length} รายการใหม่`, shell(`สรุปการคัดกรอง ${d}`, body,
        `· <a href="${unsub}" style="color:#5b6780">ยกเลิกรับอีเมล</a>`), unsub);
      sent++;
    } catch (e) {
      console.error(p.email, e);
      await db.from("alert_log").delete().eq("kind", "digest").eq("user_id", pr.user_id).eq("ref", d);   // ส่งไม่ได้ ให้รอบหน้าลองใหม่
    }
  }
  return { sent, skipped };
}

/* ---------- auth / http ---------- */
async function who(req: Request) {
  const s = req.headers.get("x-cron-secret");
  if (s) { const { data } = await db.rpc("check_cron_secret", { s }); if (data === true) return { role: "cron" }; }
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (jwt && jwt !== SB_ANON) {
    const { data: u } = await db.auth.getUser(jwt);
    if (u?.user) {
      const { data: a } = await db.from("admins").select("user_id").eq("user_id", u.user.id).maybeSingle();
      if (a) return { role: "admin", email: u.user.email ?? "" };
    }
  }
  return null;
}
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const page = (msg: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:Tahoma,sans-serif;background:#f3f5f9;display:grid;place-items:center;min-height:90vh">
<div style="background:#fff;border:1px solid #e3e8f0;border-radius:12px;padding:24px;max-width:420px;text-align:center">
<h2 style="margin-top:0">ค้นหาหุ้นอัจฉริยะ</h2><p>${msg}</p><p><a href="${APP}">กลับไปที่แอป</a></p></div></body>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url), tok = url.searchParams.get("unsub");
  if (tok) {
    if (!/^[0-9a-f-]{36}$/i.test(tok)) return page("ลิงก์ไม่ถูกต้อง");
    const { data } = await db.from("alert_prefs").update({ email_signals: false }).eq("unsub_token", tok).select("user_id");
    return page(data?.length ? "ยกเลิกรับอีเมลแจ้งเตือนเรียบร้อยแล้ว เปิดรับใหม่ได้ทุกเมื่อในเมนูสมาชิก" : "ไม่พบการสมัครรับอีเมลนี้ หรือยกเลิกไปแล้ว");
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const w = await who(req); if (!w) return json({ error: "unauthorized" }, 401);
  let mode = ""; try { mode = String((await req.json())?.mode ?? ""); } catch { /* */ }
  try {
    if (mode === "health") return json(await health());
    if (mode === "signals") return json(await signals());
    if (mode === "test") {
      if (w.role !== "admin" || !w.email) return json({ error: "เฉพาะแอดมิน" }, 403);
      await send(w.email, "ทดสอบอีเมลแจ้งเตือน · ค้นหาหุ้นอัจฉริยะ", shell("ตั้งค่าอีเมลสำเร็จ", "<p>ถ้าเห็นอีเมลนี้ แปลว่าระบบส่งอีเมลแจ้งเตือนทำงานแล้ว</p>"));
      return json({ ok: true, to: w.email });
    }
    return json({ error: "mode ไม่ถูกต้อง" }, 400);
  } catch (e) { console.error(e); return json({ error: String((e as Error)?.message ?? e) }, 500); }
});
