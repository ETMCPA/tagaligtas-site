import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("PAYMONGO_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// PayMongo signature header: "t=<timestamp>,te=<test sig>,li=<live sig>" ; HMAC-SHA256 of `${t}.${payload}`.
async function verifySignature(payload: string, header: string, secret: string) {
  const parts: Record<string, string> = {};
  for (const kv of header.split(",")) {
    const idx = kv.indexOf("=");
    if (idx > 0) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const t = parts["t"];
  const sig = parts["te"] || parts["li"];
  if (!t || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  return timingSafeEqual(hex(mac), sig);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();
  const header = req.headers.get("paymongo-signature") ?? "";

  if (!WEBHOOK_SECRET || !(await verifySignature(raw, header, WEBHOOK_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const type = event?.data?.attributes?.type ?? "";
  const resource = event?.data?.attributes?.data ?? {};
  const attr = resource?.attributes ?? {};
  const order_no = attr?.metadata?.order_no ?? attr?.reference_number ?? attr?.payment_intent?.attributes?.metadata?.order_no ?? null;

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
  await supa.from("payments").insert({
    order_no,
    rail: "paymongo",
    reference: resource?.id ?? null,
    amount: attr?.amount ? Number(attr.amount) / 100 : null,
    verified: true,
    raw: event,
  });

  const paid = type === "checkout_session.payment.paid" || type === "payment.paid";
  if (order_no && paid) {
    // Only release on the exact expected amount (₱5,600 = 560000 centavos); otherwise flag for manual review.
    const amountOk = Number(attr?.amount) === 560000;
    await supa.from("orders")
      .update({ status: amountOk ? "paid_confirmed" : "manual_review", updated_at: new Date().toISOString() })
      .eq("order_no", order_no);
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
