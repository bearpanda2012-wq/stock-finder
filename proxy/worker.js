/**
 * Cloudflare Worker — proxy สำหรับ TradingView scanner
 * ใช้เมื่อเปิด index.html บน GitHub Pages แล้วติด CORS
 *
 * วิธีใช้
 *  1. ไป dash.cloudflare.com → Workers & Pages → Create → Worker
 *  2. วางไฟล์นี้ทับโค้ดตัวอย่าง แล้ว Deploy  (หรือ: cd proxy && npx wrangler deploy)
 *  3. คัดลอก URL ที่ได้ (เช่น https://tv-proxy.<ชื่อคุณ>.workers.dev)
 *  4. ใน index.html แก้บรรทัด  const TV = "https://scanner.tradingview.com";
 *     เป็น                      const TV = "https://tv-proxy.<ชื่อคุณ>.workers.dev";
 *  5. แก้ ALLOW ด้านล่างให้เป็นโดเมน GitHub Pages ของคุณ
 *
 * Worker นี้ส่งต่อเฉพาะ path /<market>/scan ไปยัง TradingView เท่านั้น
 */

const ALLOW = [
  "https://YOUR-USERNAME.github.io",   // ← เปลี่ยนเป็นโดเมนของคุณ
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

const UPSTREAM = "https://scanner.tradingview.com";
const PATH_OK = /^\/[a-z0-9_-]+\/scan$/i;

function cors(origin) {
  const allowed = ALLOW.includes(origin) ? origin : ALLOW[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "POST" || !PATH_OK.test(url.pathname)) {
      return new Response("Not found", { status: 404, headers: cors(origin) });
    }

    let body;
    try {
      body = await request.text();
      JSON.parse(body);                 // ตรวจว่าเป็น JSON จริง
      if (body.length > 20000) throw new Error("payload too large");
    } catch (e) {
      return new Response("Bad request", { status: 400, headers: cors(origin) });
    }

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; stock-finder/1.0)"
      },
      body,
      cf: { cacheTtl: 30, cacheEverything: true }
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors(origin),
        "Content-Type": "application/json;charset=UTF-8",
        "Cache-Control": "public, max-age=30"
      }
    });
  }
};
