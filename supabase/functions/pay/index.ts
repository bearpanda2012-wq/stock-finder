/**
 * pay — ชำระค่าสมาชิกด้วย PromptPay ผ่าน Omise
 *
 *  POST {plan}     (ผู้ใช้ล็อกอิน) สร้าง charge + QR · ราคาอ่านจากตาราง plans ฝั่งเซิร์ฟเวอร์ ไม่เชื่อราคาจากเบราว์เซอร์
 *  POST {check}    (ผู้ใช้ล็อกอิน) ถามสถานะ charge ของตัวเองจาก Omise → ถ้าจ่ายแล้วเปิดสิทธิ์ทันที
 *  POST webhook    (Omise เรียก) {key:"charge.complete", data:{id}} → ดึง charge จาก Omise อีกครั้งก่อนเชื่อ
 *
 * ต้อง deploy แบบ verify_jwt = false เพราะ Omise เรียก webhook โดยไม่มี JWT (ฟังก์ชันตรวจสิทธิ์เอง)
 * Secret: OMISE_SECRET_KEY (skey_test_... สำหรับทดสอบ / skey_... ของจริง)
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SKEY = Deno.env.get("OMISE_SECRET_KEY") ??
  Object.entries(Deno.env.toObject()).find(([k, v]) => /omise/i.test(k) && /secret|skey/i.test(k) && v)?.[1] ?? "";
const AUTH = "Basic " + btoa(SKEY + ":");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function omise(path: string, form?: Record<string, string>) {
  const res = await fetch("https://api.omise.co" + path, {
    method: form ? "POST" : "GET", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: AUTH, "Omise-Version": "2019-05-29", ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const j = await res.json();
  if (!res.ok || j.object === "error") throw new Error(`Omise: ${j.message || res.status}`);
  return j;
}

/* charge จาก Omise คือความจริงเดียว — เปิดสิทธิ์เมื่อสถานะ successful และจำนวนเงินตรงกับที่บันทึกไว้ */
async function settle(chargeId: string) {
  const ch = await omise(`/charges/${encodeURIComponent(chargeId)}`);
  const { data: p } = await db.from("payments").select("*").eq("charge_id", ch.id).maybeSingle();
  if (!p) return { status: "unknown" };
  if (ch.status === "successful" && ch.paid && +ch.amount === +p.amount_satang && String(ch.currency).toUpperCase() === "THB") {
    const { data: r, error } = await db.rpc("apply_payment", { p_charge: ch.id });
    if (error) throw error;
    return { status: "paid", applied: r };
  }
  if (ch.status === "failed" || ch.status === "expired") {
    await db.from("payments").update({ status: ch.status }).eq("charge_id", ch.id).eq("status", "pending");
    return { status: ch.status, reason: ch.failure_message ?? null };
  }
  return { status: "pending" };
}

async function userOf(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user ?? null;
}

async function qrDataUrl(uri: string) {
  // ดึงรูป QR ผ่านเซิร์ฟเวอร์ แล้วส่งเป็น data URL (ไม่ต้องให้เบราว์เซอร์เรียก api.omise.co เอง)
  const r = await fetch(uri, { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return uri;
  const svg = new Uint8Array(await r.arrayBuffer());
  let bin = ""; svg.forEach((b) => (bin += String.fromCharCode(b)));
  return "data:image/svg+xml;base64," + btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }

  // ---- webhook จาก Omise (ไม่เชื่อข้อมูลใน payload ดึงใหม่จาก API ด้วย secret key ทุกครั้ง) ----
  if (body?.object === "event") {
    if (!SKEY) return json({ ok: false }, 503);
    const id = body?.data?.id;
    if (body.key === "charge.complete" && typeof id === "string" && /^chrg_[a-z0-9_]+$/i.test(id)) {
      try { return json({ ok: true, ...(await settle(id)) }); } catch (e) { console.error(e); return json({ ok: false }, 500); }
    }
    return json({ ok: true, ignored: body.key });
  }

  const user = await userOf(req);
  if (!user) return json({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!SKEY) return json({ error: "ระบบชำระเงินยังไม่เปิดใช้ — ติดต่อผู้ดูแล", code: "not_configured" }, 503);

  try {
    // ---- ตรวจสถานะ ----
    if (body.check) {
      const { data: p } = await db.from("payments").select("charge_id,status").eq("charge_id", String(body.check)).eq("user_id", user.id).maybeSingle();
      if (!p) return json({ error: "ไม่พบรายการ" }, 404);
      if (p.status === "paid") return json({ status: "paid" });
      return json(await settle(p.charge_id));
    }

    // ---- สร้างรายการใหม่ ----
    const { data: plan } = await db.from("plans").select("*").eq("code", String(body.plan ?? "")).eq("active", true).maybeSingle();
    if (!plan) return json({ error: "ไม่พบแพ็กเกจ" }, 400);
    const { data: prof } = await db.from("profiles").select("tier,tier_expires_at").eq("id", user.id).maybeSingle();
    if (prof?.tier === "lifetime") return json({ error: "บัญชีนี้เป็น Lifetime อยู่แล้ว" }, 400);
    // กันสร้าง QR ถี่เกิน: รายการค้างเกิน 5 รายการใน 1 ชม.
    const { count } = await db.from("payments").select("id", { count: "exact", head: true })
      .eq("user_id", user.id).eq("status", "pending").gte("created_at", new Date(Date.now() - 3600_000).toISOString());
    if ((count ?? 0) >= 5) return json({ error: "สร้างรายการชำระเงินถี่เกินไป รอสักครู่แล้วลองใหม่" }, 429);

    const amount = plan.price_thb * 100;
    const exp = new Date(Date.now() + 15 * 60_000).toISOString();   // QR ใช้ได้ 15 นาที
    const ch = await omise("/charges", {
      amount: String(amount), currency: "THB", "source[type]": "promptpay", expires_at: exp,
      description: `${plan.label} · ${user.email ?? user.id}`,
      "metadata[user_id]": user.id, "metadata[plan]": plan.code,
    });
    const { error } = await db.from("payments").insert({
      user_id: user.id, plan_code: plan.code, amount_satang: amount, charge_id: ch.id, livemode: !!ch.livemode,
    });
    if (error) throw error;
    const uri = ch.source?.scannable_code?.image?.download_uri;
    return json({
      charge_id: ch.id, amount: plan.price_thb, label: plan.label, expires_at: ch.expires_at ?? exp,
      livemode: !!ch.livemode, qr: uri ? await qrDataUrl(uri) : null,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 502);
  }
});
