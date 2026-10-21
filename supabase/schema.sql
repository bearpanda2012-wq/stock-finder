-- ============================================================
--  stock-finder — โครงฐานข้อมูลสำหรับระบบสมาชิก
--  วิธีใช้: Supabase Dashboard → SQL Editor → วางทั้งไฟล์ → Run
-- ============================================================

-- ---------- 1) โปรไฟล์ + ระดับสมาชิก ----------
create table if not exists public.profiles (
  id              uuid primary key references auth.users on delete cascade,
  email           text,
  display_name    text,
  tier            text not null default 'free' check (tier in ('free','pro','lifetime')),
  tier_expires_at timestamptz,
  created_at      timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- อ่านได้เฉพาะโปรไฟล์ตัวเอง
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- แก้ได้แค่ชื่อที่แสดง (ห้ามอัปเกรด tier เอง — ต้องผ่าน service role เท่านั้น)
drop policy if exists "update own name" on public.profiles;
create policy "update own name" on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    and tier = (select p.tier from public.profiles p where p.id = auth.uid())
  );

-- สร้างโปรไฟล์อัตโนมัติเมื่อมีคนสมัคร
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------- 2) รายการเฝ้าดู ----------
create table if not exists public.watchlist (
  id         bigserial primary key,
  user_id    uuid not null references auth.users on delete cascade,
  symbol     text not null,              -- เช่น SET:PTT, NASDAQ:AAPL, BINANCE:BTCUSD
  name       text,
  market     text,
  note       text,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

alter table public.watchlist enable row level security;

drop policy if exists "own watchlist" on public.watchlist;
create policy "own watchlist" on public.watchlist
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists watchlist_user_idx on public.watchlist (user_id, created_at desc);


-- ---------- 3) ชุดคัดกรองที่บันทึกไว้ ----------
create table if not exists public.saved_screens (
  id         bigserial primary key,
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null,
  market     text,
  filters    jsonb not null default '[]'::jsonb,
  weights    jsonb not null default '{}'::jsonb,
  sector     text,
  created_at timestamptz not null default now()
);

alter table public.saved_screens enable row level security;

drop policy if exists "own screens" on public.saved_screens;
create policy "own screens" on public.saved_screens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------- 4) ตั้งค่าส่วนตัว (ซิงก์ข้ามเครื่อง) ----------
create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users on delete cascade,
  cfg        jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ============================================================
--  การอัปเกรดสมาชิก
--  ห้ามให้ผู้ใช้แก้ tier เอง — ต้องเรียกจากฝั่งเซิร์ฟเวอร์ด้วย service_role key
--  เช่น Stripe webhook → Supabase Edge Function → รันคำสั่งนี้
--
--    update public.profiles
--       set tier = 'pro',
--           tier_expires_at = now() + interval '1 month'
--     where email = 'someone@example.com';
--
--  ตั้งเป็น pro ให้ตัวเองตอนทดสอบ (รันใน SQL Editor ซึ่งใช้สิทธิ์ service role):
--    update public.profiles set tier='pro' where email='you@example.com';
-- ============================================================


-- ============================================================
--  ส่วนที่ 5) ระบบแอดมิน + หน้าจัดการสมาชิก
-- ============================================================

-- แยกตารางแอดมินออกมา เพื่อไม่ให้ policy ของ profiles วนซ้ำตัวเอง
create table if not exists public.admins (
  user_id    uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

-- SECURITY DEFINER จึงข้าม RLS ได้ ไม่เกิด infinite recursion
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admins a where a.user_id = (select auth.uid())); $$;

revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated;

-- อ่านระดับของตัวเองโดยไม่ผ่าน RLS — ใช้ใน policy ป้องกันการแก้ tier ตัวเอง
create or replace function public.my_tier()
returns text language sql stable security definer set search_path = ''
as $$ select p.tier from public.profiles p where p.id = (select auth.uid()); $$;

revoke execute on function public.my_tier() from public, anon;
grant  execute on function public.my_tier() to authenticated;

drop policy if exists "read admins" on public.admins;
create policy "read admins" on public.admins
  for select to authenticated
  using ((select auth.uid()) = user_id or public.is_admin());

drop policy if exists "admin read all profiles" on public.profiles;
create policy "admin read all profiles" on public.profiles
  for select to authenticated using (public.is_admin());

drop policy if exists "admin update any profile" on public.profiles;
create policy "admin update any profile" on public.profiles
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- แทนที่ policy เดิมที่อ่าน profiles ซ้อนตัวเอง (จะเกิด recursion ตอน UPDATE)
drop policy if exists "update own name" on public.profiles;
create policy "update own name" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id and tier = public.my_tier());

alter table public.profiles add column if not exists tier_updated_at timestamptz;

-- ตั้งแอดมินคนแรก (เปลี่ยนอีเมลตามต้องการ)
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'you@example.com'
-- on conflict (user_id) do nothing;


-- ============================================================
--  ส่วนที่ 6) AI สแกนประจำวัน
--  Edge Function: supabase/functions/daily-scan/index.ts (deploy แบบ verify_jwt = false
--  เพราะฟังก์ชันตรวจสิทธิ์เอง: x-cron-secret จาก Vault หรือ JWT ของแอดมิน)
-- ============================================================
create table if not exists public.daily_scans (
  id bigserial primary key, scan_date date not null,
  market text not null check (market in ('thailand','america','crypto')),
  headline text, summary text,
  risks jsonb not null default '[]'::jsonb, picks jsonb not null default '[]'::jsonb,
  groups jsonb not null default '{}'::jsonb, breadth jsonb not null default '{}'::jsonb,
  model text, scanned int, created_at timestamptz not null default now(),
  unique (scan_date, market)
);
alter table public.daily_scans enable row level security;
create index if not exists daily_scans_market_date_idx on public.daily_scans (market, scan_date desc);

create or replace function public.has_paid()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles p where p.id = (select auth.uid())
        and p.tier in ('pro','lifetime') and (p.tier_expires_at is null or p.tier_expires_at > now())); $$;
revoke execute on function public.has_paid() from public, anon;
grant  execute on function public.has_paid() to authenticated;

drop policy if exists "daily thai public" on public.daily_scans;
create policy "daily thai public" on public.daily_scans
  for select to anon, authenticated using (market = 'thailand');
drop policy if exists "daily paid markets" on public.daily_scans;
create policy "daily paid markets" on public.daily_scans
  for select to authenticated using (public.has_paid() or public.is_admin());

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'daily_scan_cron_secret') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'daily_scan_cron_secret');
  end if; end $$;

create or replace function public.check_cron_secret(s text)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select decrypted_secret = s from vault.decrypted_secrets
        where name = 'daily_scan_cron_secret' limit 1), false); $$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant  execute on function public.check_cron_secret(text) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ยิงแยกทีละตลาด (แต่ละคำขอมีเวลา 150 วิ ถ้ารวม 3 ตลาดพร้อม Gemini จะเกินเวลา) · เสาร์-อาทิตย์สแกนเฉพาะคริปโต
create or replace function public.trigger_daily_scan(markets text[] default null)
returns bigint language plpgsql security definer set search_path = ''
as $$ declare rid bigint; m text; dow int; begin
  if markets is null then
    dow := extract(isodow from (now() at time zone 'Asia/Bangkok'));
    markets := case when dow in (6,7) then array['crypto'] else array['thailand','america','crypto'] end;
  end if;
  foreach m in array markets loop
    select net.http_post(
      url := 'https://imfoelpjryfhiqnxzvcx.supabase.co/functions/v1/daily-scan',   -- ← เปลี่ยนถ้าย้ายโปรเจกต์
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
        (select decrypted_secret from vault.decrypted_secrets where name='daily_scan_cron_secret')),
      body := jsonb_build_object('markets', array[m]),
      timeout_milliseconds := 150000) into rid;
  end loop;
  return rid; end $$;
revoke execute on function public.trigger_daily_scan(text[]) from public, anon, authenticated;

-- ทุกวัน 01:30 UTC = 08:30 น. เวลาไทย
select cron.unschedule(jobid) from cron.job where jobname = 'daily-ai-scan';
select cron.schedule('daily-ai-scan', '30 1 * * *', $$ select public.trigger_daily_scan(); $$);


-- ============================================================
--  ส่วนที่ 7) สัญญาณเข้าซื้อตามระบบ (Edge Function: trade-signals)
-- ============================================================
create table if not exists public.trade_signals (
  id bigserial primary key, signal_date date not null,
  market text not null check (market in ('thailand','america','crypto')),
  symbol text not null, name text, descr text, setup text not null,
  ref_price numeric not null, entry_low numeric not null, entry_high numeric not null,
  stop numeric not null, target1 numeric not null, target2 numeric, valid_until date not null,
  score int, reason text,
  status text not null default 'open' check (status in ('open','entered','target','stopped','expired','timeout')),
  entry_price numeric, entered_on date, exit_price numeric, closed_on date, result_pct numeric, last_price numeric,
  updated_at timestamptz not null default now(), unique (signal_date, market, symbol)
);
alter table public.trade_signals enable row level security;
drop policy if exists "signals thai public" on public.trade_signals;
create policy "signals thai public" on public.trade_signals for select to anon, authenticated using (market = 'thailand');
drop policy if exists "signals paid markets" on public.trade_signals;
create policy "signals paid markets" on public.trade_signals for select to authenticated using (public.has_paid() or public.is_admin());

create or replace function public.trigger_trade_signals()
returns bigint language plpgsql security definer set search_path = ''
as $$ declare rid bigint; begin
  select net.http_post(
    url := 'https://imfoelpjryfhiqnxzvcx.supabase.co/functions/v1/trade-signals',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='daily_scan_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000) into rid;
  return rid; end $$;
revoke execute on function public.trigger_trade_signals() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'daily-trade-signals';
select cron.schedule('daily-trade-signals', '40 1 * * *', $$ select public.trigger_trade_signals(); $$);


-- ============================================================
-- 8) บทวิเคราะห์ AI รายตัว (Edge Function ai-analyze)
--    แคชวันละ 1 ครั้งต่อหุ้น · เขียน/อ่านผ่าน service role เท่านั้น (ไม่มี policy ให้ฝั่งเบราว์เซอร์)
-- ============================================================
create table if not exists public.ai_notes (
  id          bigserial primary key,
  symbol      text not null,
  market      text not null,
  note_date   date not null,
  analysis    jsonb not null,
  model       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (symbol, note_date)
);
create index if not exists ai_notes_user_day_idx on public.ai_notes (created_by, note_date);
alter table public.ai_notes enable row level security;


-- ============================================================
-- 9) ล็อกช่องสิทธิ์สมาชิก — ผู้ใช้แก้ได้แค่ display_name (tier / วันหมดอายุ แก้ได้เฉพาะแอดมินหรือ service role)
-- ============================================================
create or replace function public.lock_profile_fields()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    new.id := old.id; new.email := old.email; new.tier := old.tier;
    new.tier_expires_at := old.tier_expires_at; new.tier_updated_at := old.tier_updated_at; new.created_at := old.created_at;
  end if;
  return new;
end $$;
revoke execute on function public.lock_profile_fields() from public, anon, authenticated;
drop trigger if exists lock_profile_fields on public.profiles;
create trigger lock_profile_fields before update on public.profiles
  for each row execute function public.lock_profile_fields();


-- ============================================================
-- 10) อีเมลแจ้งเตือน (Edge Function notify · ส่งผ่าน Resend)
-- ============================================================
create table if not exists public.alert_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_signals boolean not null default false,          -- PDPA: ค่าเริ่มต้นปิด ผู้ใช้เปิดเอง
  markets text[] not null default array['thailand'],
  watch_only boolean not null default false,
  unsub_token uuid not null default gen_random_uuid(),
  consented_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.alert_prefs enable row level security;
drop policy if exists "own alert prefs" on public.alert_prefs;
create policy "own alert prefs" on public.alert_prefs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.alert_prefs_guard()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin
  if tg_op = 'UPDATE' then new.unsub_token := old.unsub_token; end if;
  if new.email_signals and (tg_op = 'INSERT' or not old.email_signals) then new.consented_at := now(); end if;
  new.markets := array(select m from unnest(new.markets) m where m in ('thailand','america','crypto'));
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.alert_prefs_guard() from public, anon, authenticated;
drop trigger if exists alert_prefs_guard on public.alert_prefs;
create trigger alert_prefs_guard before insert or update on public.alert_prefs
  for each row execute function public.alert_prefs_guard();

create table if not exists public.alert_log (
  id bigserial primary key, kind text not null,
  user_id uuid references auth.users(id) on delete cascade, ref text not null,
  sent_at timestamptz not null default now(), unique (kind, user_id, ref)
);
alter table public.alert_log enable row level security;

create or replace function public.cron_health(since interval default interval '3 hours')
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'jobs', coalesce((select jsonb_agg(jsonb_build_object('job', j.jobname, 'status', d.status,
              'msg', left(d.return_message, 200), 'at', d.start_time) order by d.start_time)
            from cron.job_run_details d join cron.job j on j.jobid = d.jobid
            where d.start_time > now() - since), '[]'::jsonb),
    'http_errors', coalesce((select jsonb_agg(jsonb_build_object('status', r.status_code, 'timed_out', r.timed_out,
              'err', left(coalesce(r.error_msg, r.content::text), 200), 'at', r.created))
            from net._http_response r
            where r.created > now() - since and (r.status_code is null or r.status_code >= 400)), '[]'::jsonb));
$$;
revoke execute on function public.cron_health(interval) from public, anon, authenticated;
grant execute on function public.cron_health(interval) to service_role;

create or replace function public.trigger_notify(mode text)
returns bigint language plpgsql security definer set search_path = ''
as $$ declare rid bigint; begin
  select net.http_post(
    url := 'https://imfoelpjryfhiqnxzvcx.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='daily_scan_cron_secret')),
    body := jsonb_build_object('mode', mode), timeout_milliseconds := 120000) into rid;
  return rid; end $$;
revoke execute on function public.trigger_notify(text) from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('notify-health','notify-signals');
select cron.schedule('notify-health', '0 2 * * *', $$ select public.trigger_notify('health'); $$);    -- 09:00 น.
select cron.schedule('notify-signals', '5 2 * * *', $$ select public.trigger_notify('signals'); $$);  -- 09:05 น.


-- ============================================================
-- 11) ชำระเงิน PromptPay ผ่าน Omise (Edge Function pay · verify_jwt = false)
-- ============================================================
create table if not exists public.plans (
  code text primary key, label text not null,
  tier text not null check (tier in ('pro','lifetime')),
  days int,                                                -- null = ตลอดชีพ
  price_thb int not null check (price_thb >= 20),          -- PromptPay ขั้นต่ำ 20 บาท
  note text, active boolean not null default true, sort int not null default 0
);
alter table public.plans enable row level security;
drop policy if exists "plans public" on public.plans;
create policy "plans public" on public.plans for select to anon, authenticated using (active);
drop policy if exists "plans admin" on public.plans;
create policy "plans admin" on public.plans for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into public.plans (code,label,tier,days,price_thb,note,sort) values
  ('pro_month','Pro รายเดือน','pro',30,199,'ทุกตลาด · บทวิเคราะห์ AI · อีเมลแจ้งเตือน',1),
  ('pro_year','Pro รายปี','pro',365,1990,'ประหยัดกว่ารายเดือน ~2 เดือน',2),
  ('lifetime','Lifetime','lifetime',null,4990,'จ่ายครั้งเดียว ใช้ได้ตลอด',3)
on conflict (code) do nothing;

create table if not exists public.payments (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null references public.plans(code),
  amount_satang int not null, provider text not null default 'omise', charge_id text unique,
  status text not null default 'pending' check (status in ('pending','paid','failed','expired')),
  applied boolean not null default false, livemode boolean,
  created_at timestamptz not null default now(), paid_at timestamptz
);
alter table public.payments enable row level security;
drop policy if exists "own payments" on public.payments;
create policy "own payments" on public.payments for select to authenticated using ((select auth.uid()) = user_id or public.is_admin());
create index if not exists payments_user_idx on public.payments (user_id, created_at desc);

create or replace function public.apply_payment(p_charge text)
returns text language plpgsql security definer set search_path = ''
as $$
declare pay record; pl record; cur record;
begin
  update public.payments set status = 'paid', applied = true, paid_at = now()
    where charge_id = p_charge and applied = false returning * into pay;
  if not found then return 'already'; end if;
  select * into pl from public.plans where code = pay.plan_code;
  select tier, tier_expires_at into cur from public.profiles where id = pay.user_id;
  if pl.tier = 'lifetime' then
    update public.profiles set tier = 'lifetime', tier_expires_at = null, tier_updated_at = now() where id = pay.user_id;
  elsif cur.tier = 'lifetime' or (cur.tier = 'pro' and cur.tier_expires_at is null) then
    null;
  else
    update public.profiles set tier = 'pro',
      tier_expires_at = greatest(coalesce(cur.tier_expires_at, now()), now()) + make_interval(days => pl.days),
      tier_updated_at = now() where id = pay.user_id;
  end if;
  return 'applied';
end $$;
revoke execute on function public.apply_payment(text) from public, anon, authenticated;
grant execute on function public.apply_payment(text) to service_role;
