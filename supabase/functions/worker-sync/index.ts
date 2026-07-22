// Worker inbound (Decisión 4): drena la cola pgmq 'sync_jobs' que llena el
// receptor de webhooks. Lo invoca pg_cron cada minuto (migración 006) o un
// operador vía curl con el service key.
//
// Auth: verify_jwt=false + token DEDICADO (WORKER_SYNC_TOKEN) comparado en
// tiempo constante — con verify_jwt un JWT anon válido también pasaría, y
// nadie más que el sistema debe poder drenar la cola. Se usa un token propio
// (no la service key) porque el formato de keys de Supabase varía por proyecto
// (JWT legacy vs sb_secret_…) y acoplarse a él produce 401 silenciosos: el
// token nuestro va en `supabase secrets set WORKER_SYNC_TOKEN=…` y en el
// Vault ('worker_sync_token') para que el cron lo lea (migración 006).
//
// Semántica at-least-once => effectively-once:
// - Si el worker muere tras procesar y antes de archivar, el mensaje reaparece
//   al vencer el vt; webhook_events.processed_at evita re-aplicar.
// - Aun si se re-aplicara: los handlers son upserts y el inventario es un set
//   absoluto vía apply_inventory_change — re-procesar es inocuo.
// - read_ct > 5 => dead letter: archivar + sync_events(dead_letter) + log
//   (canal real de alerta pendiente: docs/PENDIENTES.md #5).

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2";
import { procesarEvento } from "./handlers.ts";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Token de invocación propio — fail-closed: sin token configurado, nadie entra.
const WORKER_TOKEN = Deno.env.get("WORKER_SYNC_TOKEN") ?? "";

const VT_SECONDS = 60; // invisible mientras se procesa (Decisión 4)
const BATCH = 10;
const MAX_READS = 5; // read_ct > 5 => dead letter (Decisión 4)

interface SyncJobMessage {
  webhook_event_id: string;
  shop_id: string;
  topic: string;
}

function bearerOk(header: string | null): boolean {
  if (WORKER_TOKEN.length === 0) {
    console.error("WORKER_SYNC_TOKEN no configurado: rechazando toda invocación (fail-closed)");
    return false;
  }
  const token = header?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(WORKER_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function entityForTopic(topic: string): "product" | "inventory" | "order" {
  if (topic.startsWith("inventory_levels/")) return "inventory";
  if (topic.startsWith("orders/") || topic.startsWith("fulfillments/")) return "order";
  return "product";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!bearerOk(req.headers.get("Authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const { data: msgs, error: readErr } = await supabase.rpc("pgmq_read", {
    queue_name: "sync_jobs",
    vt: VT_SECONDS,
    qty: BATCH,
  });
  if (readErr) {
    console.error(`pgmq_read falló: ${readErr.message}`);
    return Response.json({ error: "pgmq_read" }, { status: 500 });
  }

  let ok = 0;
  let failed = 0;
  let dead = 0;

  for (const m of msgs ?? []) {
    const msg = m.message as SyncJobMessage;
    try {
      const { data: evt, error } = await supabase
        .from("webhook_events")
        .select("id, shop_id, topic, payload, processed_at")
        .eq("id", msg.webhook_event_id)
        .single();
      if (error || !evt) throw new Error(`webhook_event ${msg.webhook_event_id} no encontrado`);

      let detail: Record<string, unknown> = { reproceso_omitido: true };
      if (!evt.processed_at) {
        detail = await procesarEvento(supabase, evt.shop_id, evt.topic, evt.payload);
        await supabase
          .from("webhook_events")
          .update({ processed_at: new Date().toISOString() })
          .eq("id", evt.id);
      }

      await supabase.from("sync_events").insert({
        shop_id: msg.shop_id,
        direction: "inbound",
        entity: entityForTopic(msg.topic),
        status: "success",
        attempts: m.read_ct,
        payload: { webhook_event_id: msg.webhook_event_id, topic: msg.topic, ...detail },
      });
      await supabase.rpc("pgmq_archive", { queue_name: "sync_jobs", msg_id: m.msg_id });
      ok++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const isDead = m.read_ct > MAX_READS;
      failed++;

      await supabase.from("sync_events").insert({
        shop_id: msg.shop_id,
        direction: "inbound",
        entity: entityForTopic(msg.topic),
        status: isDead ? "dead_letter" : "failed",
        error: errMsg,
        attempts: m.read_ct,
        payload: { webhook_event_id: msg.webhook_event_id, topic: msg.topic },
      });

      if (isDead) {
        dead++;
        await supabase.rpc("pgmq_archive", { queue_name: "sync_jobs", msg_id: m.msg_id });
        // "Alertar" (§10): hoy log del runtime; canal real en PENDIENTES #5
        console.error(`DEAD LETTER sync_jobs msg=${m.msg_id} topic=${msg.topic}: ${errMsg}`);
      }
      // Si no es dead letter: pgmq re-entrega al vencer el vt (backoff natural)
    }
  }

  return Response.json({
    drenados: (msgs ?? []).length,
    procesados: ok,
    fallidos: failed,
    dead_letter: dead,
  });
});
