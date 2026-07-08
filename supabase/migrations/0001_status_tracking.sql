-- STATUS TRACKING — "Track your order" (status.html + get-status Edge Function)
-- Apply to project aodkheohhbzcgvzhjekx. NOT YET APPLIED — awaiting ETM approval (deploy gate).

-- 1) Order fields the tracker needs.
alter table public.orders
  add column if not exists product     text default 'Executive Summary',
  add column if not exists due_date     date,               -- payment date + 5 days (Executive Summary ETA)
  add column if not exists status_token text,               -- magic-link token (in the confirmation/thank-you email)
  add column if not exists courier      text,               -- 'lbc' | 'fedex' | 'philpost' (physical service, optional)
  add column if not exists tracking_no  text;                -- real courier tracking number (proof of service)

-- 2) Append-only milestone log ("scans") that powers the courier-style timeline.
create table if not exists public.order_events (
  id          bigint generated always as identity primary key,
  order_no    text references public.orders(order_no),
  from_status text,
  to_status   text not null,
  actor       text default 'system',   -- system | operator | webhook
  note        text,
  at          timestamptz not null default now()
);
create index if not exists order_events_order_no_idx on public.order_events(order_no, at);

-- 3) RLS closed to anon on the events table (matches orders/payments).
--    Reads happen ONLY through the token-gated get-status function (service role).
alter table public.order_events enable row level security;

-- Deploy checklist (after approval):
--   a) apply this migration
--   b) deploy the get-status Edge Function (verify_jwt:false; it does its own token gating)
--   c) have create-order generate + store status_token, and return it so the confirmation/
--      thank-you email can embed  status.html?order=<order_no>&t=<status_token>
--   d) operator/webhook writes an order_events row on every state change (the "scans")
--   e) set due_date = payment date + 5 days when payment is confirmed
