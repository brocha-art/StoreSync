import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente service_role: SOLO server-side (scripts, workers, Edge Functions).
 * Jamás en un navegador, jamás en la respuesta al consumidor externo (§11).
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) {
    throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
