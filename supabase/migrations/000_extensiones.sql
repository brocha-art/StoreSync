-- 000 — Extensiones requeridas (paso 1 del orden de ejecución)
-- Vault (supabase_vault) ya viene activo en Supabase: no se crea aquí (Decisión 2).
-- Idempotente: create extension if not exists.

create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net;
