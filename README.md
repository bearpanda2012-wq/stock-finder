# ค้นหาหุ้นอัจฉริยะ

สกรีนเนอร์หุ้นไทย (SET/mai) หุ้นสหรัฐฯ และคริปโต — ไฟล์ HTML เดียวจบ ไม่ต้องมีเซิร์ฟเวอร์ ไม่ต้อง build

## โครงสร้างโฟลเดอร์

```
stock-finder/
├── index.html              ← เว็บแอป (ไฟล์เดียวจบ) — นี่คือไฟล์ที่ GitHub Pages เสิร์ฟ
├── README.md
├── .gitignore
├── supabase/
│   └── schema.sql          ← ตารางฐานข้อมูลสำหรับระบบสมาชิก (ไม่ใช้ก็ได้)
├── proxy/                  ← ใช้เฉพาะตอนติด CORS
│   ├── worker.js           Cloudflare Worker ทำหน้าที่ proxy
│   └── wrangler.toml       ตั้งค่าสำหรับ deploy ด้วย CLI
└── cowork/
    └── stock-finder.html   เวอร์ชันเดิมที่รันเป็น artifact ใน Claude Cowork (ใช้ MCP + AI)
```

`index.html` กับ `cowork/stock-finder.html` เป็นคนละเวอร์ชันกัน อ่านหัวข้อ "สองเวอร์ชันต่างกันยังไง" ด้านล่าง

## ความสามารถ

- **สลับตลาด** หุ้นไทย / หุ้นสหรัฐฯ / คริปโต
- **ค้นหาด้วยชื่อ** — `PTT`, `ปตท`, `AAPL NVDA TSLA`, `bitcoin` (ใส่หลายตัวคั่นเว้นวรรคได้ · สลับตลาดให้อัตโนมัติเมื่อเจอในตลาดอื่น)
- **ค้นหาด้วยเงื่อนไขภาษาไทย** — `ปันผลเกิน 5% และ P/E ต่ำกว่า 12`, `รายได้โต 15% ROE เกิน 20`, `RSI ต่ำกว่า 35`
- **กลยุทธ์สำเร็จรูป** 7 แบบสำหรับหุ้น + 4 แบบสำหรับคริปโต
- **ตัวกรองละเอียด** 14 ตัวแปร กรอกช่วงต่ำสุด–สูงสุด
- **คะแนน 0–100** จาก 5 องค์ประกอบ (คุณค่า / คุณภาพ / เติบโต / โมเมนตัม / เทคนิค) ปรับน้ำหนักเองได้ จำค่าไว้ข้ามครั้ง
- **แผงรายตัว** — กราฟเรดาร์, สัญญาณเทคนิค 5 กรอบเวลา, ข่าว/เหตุการณ์, ราคาเป้าหมายนักวิเคราะห์, ข้อมูลบริษัท, ที่มาของคะแนน

## เปิดดูในเครื่องก่อน

เปิด `index.html` ด้วยเบราว์เซอร์ตรงๆ ได้เลย หรือถ้าอยากเลี่ยงปัญหา `file://` ให้รันเซิร์ฟเวอร์เล็กๆ:

```bash
cd stock-finder
python3 -m http.server 8000
# เปิด http://localhost:8000
```

## ขึ้น GitHub Pages

```bash
cd stock-finder
git init
git add .
git commit -m "stock finder"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

จากนั้นไปที่ **Settings → Pages → Source: Deploy from a branch → main / (root)** รอสักครู่แล้วเปิด `https://<user>.github.io/<repo>/`

## ถ้าตารางว่างเปล่า / ขึ้นว่าถูกบล็อกโดย CORS

`index.html` เรียก TradingView public scanner ตรงจากเบราว์เซอร์ ถ้า TradingView ไม่ยอมให้เรียกข้ามโดเมน ให้วาง proxy คั่นกลาง:

**วิธีที่ 1 — ผ่านหน้าเว็บ Cloudflare (ง่ายสุด)**

1. ไป dash.cloudflare.com → Workers & Pages → Create → Worker
2. วางเนื้อหาไฟล์ `proxy/worker.js` ทับโค้ดตัวอย่าง
3. แก้ค่า `ALLOW` ในไฟล์ให้เป็นโดเมน GitHub Pages ของคุณ แล้วกด Deploy
4. คัดลอก URL ที่ได้ เช่น `https://tv-proxy.yourname.workers.dev`

**วิธีที่ 2 — ผ่าน CLI**

```bash
cd proxy
npx wrangler deploy
```

จากนั้นแก้ใน `index.html` บรรทัดเดียว:

```js
const TV = "https://scanner.tradingview.com";
// เปลี่ยนเป็น
const TV = "https://tv-proxy.yourname.workers.dev";
```

## สองเวอร์ชันต่างกันยังไง

| | `index.html` (เว็บ) | `cowork/stock-finder.html` |
|---|---|---|
| รันที่ไหน | เบราว์เซอร์ / GitHub Pages | Claude Cowork เท่านั้น |
| ดึงข้อมูล | เรียก TradingView ตรง | ผ่าน MCP ของ Cowork |
| แปลคำค้นภาษาไทย | กฎที่เขียนไว้ในโค้ด | โมเดลภาษา (ยืดหยุ่นกว่า) |
| บทวิเคราะห์รายตัว | ไล่ที่มาของคะแนน + เตือนความเสี่ยง | บทวิเคราะห์เขียนโดย AI |
| สรุปภาพรวมผลคัดกรอง | ค่ากลางทางสถิติ | สรุปเป็นภาษาโดย AI |

เอา `cowork/stock-finder.html` ไปเปิดในเบราว์เซอร์ปกติจะได้หน้าเปล่า เพราะไม่มีสะพาน `window.cowork` — เก็บไว้เป็นต้นฉบับอ้างอิงเฉยๆ

## ระบบสมาชิก

**ต่อกับ Supabase เรียบร้อยแล้ว ใช้งานได้ทันที** — โปรเจกต์ `Stock Finder` (ap-northeast-1 / โตเกียว)

ค่าที่ใช้อยู่ใน `index.html` บล็อก `window.SF_SUPABASE`:

```
url:     https://imfoelpjryfhiqnxzvcx.supabase.co
anonKey: sb_publishable_m6vWrk4Gl3ih7CdgqV_Vnw_8Qwmc6Jf
```

publishable key เปิดเผยได้ ปลอดภัยเพราะ Row Level Security คุมว่าใครเห็นแถวไหน

### ตารางในฐานข้อมูล

| ตาราง | ใช้ทำอะไร | RLS |
|---|---|---|
| `profiles` | ระดับสมาชิก + วันหมดอายุ | เห็นเฉพาะของตัวเอง แก้ tier เองไม่ได้ |
| `watchlist` | รายการเฝ้าดู | เจ้าของเท่านั้น |
| `saved_screens` | ชุดคัดกรองที่บันทึกไว้ | เจ้าของเท่านั้น |
| `user_settings` | ตั้งค่าที่ซิงก์ข้ามเครื่อง | เจ้าของเท่านั้น |

สมัครสมาชิกแล้วจะมี trigger สร้างแถวใน `profiles` ให้อัตโนมัติ ระดับเริ่มต้นคือ `free`

ไฟล์ `supabase/schema.sql` เก็บไว้เผื่อต้องสร้างใหม่หรือย้ายโปรเจกต์

### ตั้งค่าอีเมลก่อนใช้จริง

Supabase Dashboard → **Authentication → URL Configuration** ใส่โดเมนของคุณใน Site URL และ Redirect URLs
(ถ้าเปิดจากไฟล์ในเครื่อง ให้เพิ่ม `http://localhost:8000` ด้วย)

อยากให้สมัครแล้วเข้าใช้ได้เลยไม่ต้องยืนยันอีเมล → **Authentication → Providers → Email** แล้วปิด Confirm email

### ระดับสมาชิก

| | ฟรี | Pro / Lifetime |
|---|---|---|
| จำนวนอันดับที่แสดง | 30 | 200 |
| ตลาด | หุ้นไทย | ไทย + สหรัฐฯ + คริปโต |
| รายการเฝ้าดู | 10 ตัว | 200 ตัว |
| ซิงก์ตั้งค่าข้ามเครื่อง | ✓ | ✓ |

แก้เกณฑ์ได้ที่ตัวแปร `TIERS` ใน `index.html`

### อัปเกรดสมาชิก

ผู้ใช้แก้ `tier` ตัวเองไม่ได้ (RLS ปิดไว้) ต้องสั่งจากฝั่งเซิร์ฟเวอร์ — Dashboard → SQL Editor:

```sql
update public.profiles set tier='pro' where email='you@example.com';
```

รับเงินจริง: สร้าง Stripe Payment Link → ใส่ URL ในช่อง `upgradeUrl` → ทำ webhook (Supabase Edge Function)
รับ event `checkout.session.completed` แล้ว `update profiles set tier='pro', tier_expires_at=now()+interval '1 month'`

**สำคัญ:** การจำกัดสิทธิ์ในหน้าเว็บเป็นเรื่อง UX เท่านั้น คนที่แก้โค้ดในเบราว์เซอร์ยังดูข้อมูลได้
เพราะข้อมูลหุ้นมาจาก TradingView ที่เปิดสาธารณะอยู่แล้ว ส่วนข้อมูลส่วนตัวปลอดภัยจริงเพราะ RLS บังคับที่ฐานข้อมูล

## ข้อจำกัด

- ใช้ TradingView public scanner ซึ่งเป็น API ที่ไม่เป็นทางการ — อาจเปลี่ยนหรือถูกปิดได้
- ตัวเลขพื้นฐานของหุ้นต่างประเทศรายงานเป็น USD หน้านี้แปลงราคาเป้าหมายกลับเป็นสกุลท้องถิ่นด้วยอัตราโดยนัย (market cap ÷ จำนวนหุ้น)
- พาดหัวข่าวเป็นลิงก์ออกไปยังแหล่งข่าว ไม่ได้ดึงเนื้อข่าวมาแสดง
- ชื่อไทยรองรับผ่านตารางแปลงชื่อ ~50 รายการใน `index.html` (ตัวแปร `ALIAS`) เพิ่มเองได้

## ข้อควรทราบ

เครื่องมือนี้ใช้ช่วยคัดกรองและศึกษาข้อมูลเท่านั้น ไม่ใช่คำแนะนำการลงทุน ผู้ใช้ควรตรวจสอบข้อมูลจากแหล่งทางการก่อนตัดสินใจ
