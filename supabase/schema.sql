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
