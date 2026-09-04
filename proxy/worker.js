/**
 * Cloudflare Worker — proxy สำหรับ stock-finder
 *
 * ทำหน้าที่ 2 อย่าง
 *  1. /<market>/scan          → ส่งต่อไป scanner.tradingview.com (ใช้เมื่อเรียกตรงแล้วติด CORS)
 *  2. /fetch?url=<encoded>    → ส่งต่อไปเว็บในรายการอนุญาต (set.or.th, settrade.com)
 *                                เว็บพวกนี้ไม่เปิด CORS จึงต้องผ่าน proxy เท่านั้น
 *
 * วิธีใช้
 *  1. ไป dash.cloudflare.com → Workers & Pages → Create → Worker
 *  2. วางไฟล์นี้ทับโค้ดตัวอย่าง แล้ว Deploy  (หรือ: cd proxy && npx wrangler deploy)
 *  3. คัดลอก URL ที่ได้ เช่น https://tv-proxy.<ชื่อคุณ>.workers.dev
 *  4. เปิดแอป → ปุ่ม ⚙ ปรับแต่ง → ช่อง "Proxy URL" → วาง URL แล้วโหลดหน้าใหม่
 *  5. แก้ ALLOW ด้านล่างให้เป็นโดเมน GitHub Pages ของคุณ
 */

const ALLOW = [
  "https://YOUR-USERNAME.github.io",   // ← เปลี่ยนเป็นโดเมนของคุณ
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "null"                                // เปิดไฟล์ตรงๆ จากเครื่อง (file://)
];

const TV = "https://scanner.tradingview.com";
const SCAN_PATH = /^\/[a-z0-9_-]+\/scan$/i;

// โฮสต์ที่อนุญาตให้ /fetch ส่งต่อไปได้เท่านั้น
const HOSTS = new Set(["www.set.or.th", "set.or.th", "www.settrade.com", "settrade.com",
                       "th.investing.com", "www.investing.com"]);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HDR = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "th,en-US;q=0.9,en;q=0.8"
};
const dec = s => String(s||"")
  .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"')
  .replace(/&#0?39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&#x27;/g,"'").replace(/<[^>]+>/g," ").replace(/\s{2,}/g," ").trim();

/* หา URL หน้าข่าวของหุ้นบน Investing.com จากตัวย่อ/ชื่อบริษัท */
async function investingSlug(symbol, name){
  const tryQueries = [symbol, name].filter(Boolean);
  for(const q of tryQueries){
    try{
      const res = await fetch("https://th.investing.com/search/service/searchTopBar", {
        method:"POST",
        headers:{ ...HDR, "Content-Type":"application/x-www-form-urlencoded",
                  "X-Requested-With":"XMLHttpRequest", "Referer":"https://th.investing.com/" },
        body:"search_text=" + encodeURIComponent(q)
      });
      if(!res.ok) continue;
      const j = await res.json();
      const quotes = (j && j.quotes) || [];
      const hit = quotes.find(x => String(x.symbol||"").toUpperCase() === String(symbol).toUpperCase()) || quotes[0];
      if(hit && hit.link) return "https://th.investing.com" + hit.link;
    }catch(e){}
  }
  return null;
}

/* ดึงพาดหัวข่าวภาษาไทยจากหน้า news ของ Investing.com */
async function investingNews(symbol, name){
  const base = await investingSlug(symbol, name);
  if(!base) return { error:"ไม่พบหุ้นนี้บน Investing.com", items:[] };
  const url = base.replace(/\/$/,"") + "-news";
  const res = await fetch(url, { headers:{ ...HDR, "Referer":"https://th.investing.com/" } });
  if(!res.ok) return { error:"โหลดหน้าข่าวไม่สำเร็จ (HTTP "+res.status+")", url, items:[] };
  const html = await res.text();

  const items = [], seen = new Set();
  // การ์ดข่าวรูปแบบปัจจุบัน
  const re = /<a[^>]*data-test="article-title-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while((m = re.exec(html)) && items.length < 12){
    const href = m[1].startsWith("http") ? m[1] : "https://th.investing.com" + m[1];
    const title = dec(m[2]);
    if(!title || seen.has(href)) continue;
    seen.add(href);
    // หาวันที่ใกล้ๆ ลิงก์
    const tail = html.slice(m.index, m.index + 2600);
    const dt = (tail.match(/datetime="([^"]+)"/) || [])[1] ||
               (tail.match(/data-test="article-publish-date"[^>]*>([^<]+)</) || [])[1] || "";
    const src = (tail.match(/data-test="news-provider-name"[^>]*>([^<]+)</) || [])[1] || "Investing.com";
    const desc = dec((tail.match(/data-test="article-description"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    items.push({ title, url: href, when: dt, source: dec(src), summary: desc.slice(0,200) });
  }
  // สำรอง: ลิงก์ข่าวทั่วไป เผื่อ markup เปลี่ยน
  if(!items.length){
    const re2 = /<a[^>]+href="(\/news\/[^"]+)"[^>]*>([^<]{25,160})<\/a>/g;
    while((m = re2.exec(html)) && items.length < 12){
      const href = "https://th.investing.com" + m[1];
      const title = dec(m[2]);
      if(!title || seen.has(href)) continue;
      seen.add(href);
      items.push({ title, url: href, when:"", source:"Investing.com", summary:"" });
    }
  }
  return { url, count: items.length, items };
}

function cors(origin) {
  const allowed = ALLOW.includes(origin) ? origin : ALLOW[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { ...cors(origin), "Content-Type": "application/json;charset=UTF-8" }
});

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(origin) });

    /* ---------- 1) TradingView scanner ---------- */
    if (request.method === "POST" && SCAN_PATH.test(url.pathname)) {
      let body;
      try {
        body = await request.text();
        JSON.parse(body);
        if (body.length > 20000) throw new Error("payload too large");
      } catch (e) {
        return json({ error: "bad request" }, 400, origin);
      }
      const up = await fetch(TV + url.pathname + url.search, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; stock-finder/1.0)"
        },
        body,
        cf: { cacheTtl: 30, cacheEverything: true }
      });
      return new Response(up.body, {
        status: up.status,
        headers: { ...cors(origin), "Content-Type": "application/json;charset=UTF-8",
                   "Cache-Control": "public, max-age=30" }
      });
    }

    /* ---------- 2) ข่าวภาษาไทยจาก Investing.com ---------- */
    if (request.method === "GET" && url.pathname === "/news") {
      const symbol = (url.searchParams.get("symbol") || "").slice(0, 20);
      const name = (url.searchParams.get("name") || "").slice(0, 80);
      if (!symbol) return json({ error: "ต้องระบุ symbol", items: [] }, 400, origin);
      try {
        const out = await investingNews(symbol, name);
        return json(out, 200, origin);
      } catch (e) {
        return json({ error: String(e && e.message || e), items: [] }, 200, origin);
      }
    }

    /* ---------- 3) ส่งต่อไปเว็บไทย (SET / SETTRADE) ---------- */
    if (request.method === "GET" && url.pathname === "/fetch") {
      const target = url.searchParams.get("url") || "";
      let t;
      try { t = new URL(target) } catch (e) { return json({ error: "bad url" }, 400, origin) }
      if (t.protocol !== "https:" || !HOSTS.has(t.hostname))
        return json({ error: "host not allowed", host: t.hostname }, 403, origin);

      const up = await fetch(t.toString(), {
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "th,en;q=0.9",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Referer": `https://${t.hostname}/`
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      const text = await up.text();
      return new Response(text, {
        status: up.status,
        headers: { ...cors(origin),
          "Content-Type": up.headers.get("Content-Type") || "application/json;charset=UTF-8",
          "Cache-Control": "public, max-age=300" }
      });
    }

    return json({ error: "not found" }, 404, origin);
  }
};
