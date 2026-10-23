/* Service Worker — ทำให้ติดตั้งเป็นแอปได้ และเปิดหน้าได้แม้เน็ตหลุด
 *
 * กลยุทธ์
 *  - หน้าเว็บ (index.html)  : เน็ตก่อน → ได้เวอร์ชันล่าสุดเสมอ, เน็ตหลุดค่อยใช้ของในแคช
 *  - ไลบรารีจาก CDN / ไอคอน : แคชก่อน แล้วอัปเดตเบื้องหลัง (ไฟล์พวกนี้แทบไม่เปลี่ยน)
 *  - ข้อมูลหุ้น / Supabase / แปลภาษา : ไม่แตะเลย ส่งตรงไปเซิร์ฟเวอร์
 *    (ข้อมูลราคาต้องสดเสมอ และห้ามแคชข้อมูลส่วนตัวหรือ token)
 *
 * ออกเวอร์ชันใหม่: เปลี่ยน VERSION ด้านล่าง → ผู้ใช้จะเห็นแถบ "มีเวอร์ชันใหม่"
 */
const VERSION = "sf-v6";
const SHELL = `${VERSION}-shell`;
const LIBS  = `${VERSION}-libs`;

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];
const CDN_LIBS = [
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"
];
const LIB_HOSTS = new Set(["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(PRECACHE);
    // CDN อาจล่มชั่วคราว อย่าให้การติดตั้งพังเพราะไลบรารีตัวเดียว
    const libs = await caches.open(LIBS);
    await Promise.all(CDN_LIBS.map(u =>
      fetch(u, {mode:"cors"}).then(r => r.ok && libs.put(u, r)).catch(() => {})
    ));
  })());
  // ไม่ skipWaiting ทันที — รอผู้ใช้กด "อัปเดต" จะได้ไม่สลับโค้ดกลางคันตอนกำลังใช้งาน
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION + "-")).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                    // POST ไป TradingView / Supabase ผ่านตรง
  const url = new URL(req.url);

  // 1) เปิดหน้าเว็บ → เน็ตก่อน
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && url.origin === location.origin) {
          const c = await caches.open(SHELL);
          c.put("./index.html", fresh.clone());          // เก็บไว้ใช้ตอนออฟไลน์ (ไม่เก็บ hash/token)
        }
        return fresh;
      } catch (err) {
        const c = await caches.open(SHELL);
        return (await c.match("./index.html")) || (await c.match("./")) ||
          new Response("<h1>ออฟไลน์</h1><p>ต่ออินเทอร์เน็ตแล้วลองใหม่</p>",
            {status: 503, headers: {"Content-Type": "text/html; charset=utf-8"}});
      }
    })());
    return;
  }

  // 2) ไฟล์ของแอปเอง (ไอคอน manifest) → แคชก่อน
  if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(req, SHELL));
    return;
  }

  // 3) ไลบรารีจาก CDN → แคชก่อน
  if (LIB_HOSTS.has(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, LIBS));
    return;
  }

  // 4) อย่างอื่นทั้งหมด (Supabase, Wikipedia, แปลภาษา ฯลฯ) → ไม่ยุ่ง
});

async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const net = fetch(req).then(r => {
    if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone());
    return r;
  }).catch(() => null);
  return hit || (await net) || new Response("", {status: 504});
}
