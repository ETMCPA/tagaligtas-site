import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
// Mask an email for client display: e***o@e***e.com
function maskEmail(e: string | null): string | null {
  if (!e) return null;
  const [u, d] = e.split("@");
  if (!d) return null;
  const mu = u.length <= 2 ? u[0] + "*" : u[0] + "***" + u[u.length - 1];
  const dp = d.split(".");
  const md = (dp[0]?.[0] ?? "") + "***" + (dp[0]?.slice(-1) ?? "");
  return `${mu}@${md}.${dp.slice(1).join(".")}`;
}

// Read-only, token-gated status for the client's Track-your-order page.
// RLS stays CLOSED to anon; this service-role function is the only read path.
// A wrong/absent token and a non-existent order both return the same 404.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const { order_no, token } = await req.json().catch(() => ({}));
    const on = String(order_no ?? "").trim();
    const tk = String(token ?? "").trim();
    if (!/^[A-Za-z0-9._-]{4,64}$/.test(on) || tk.length < 16 || tk.length > 128) {
      return json({ error: "invalid request" }, 400);
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: order, error } = await supa.from("orders")
      .select("order_no, status, product, amount_due, due_date, email, courier, tracking_no, status_token")
      .eq("order_no", on).maybeSingle();
    if (error) return json({ error: "server error" }, 500);
    if (!order || !order.status_token || order.status_token !== tk) return json({ error: "not found" }, 404);

    const { data: events } = await supa.from("order_events")
      .select("to_status, at, note").eq("order_no", on).order("at", { ascending: true });

    return json({
      order_no: order.order_no,
      status: order.status,
      product: order.product ?? "Executive Summary",
      amount: order.amount_due ?? null,
      due_date: order.due_date ?? null,
      email_masked: maskEmail(order.email),
      courier: order.courier ?? null,
      tracking_no: order.tracking_no ?? null,
      events: events ?? [],
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
