-- 006 — Programación del worker inbound vía pg_cron + pg_net (Decisión 4)
--
-- El job NO se agenda dentro de la migración: la URL de la función es por
-- entorno. Se expone una función de ops (service_role only) que agenda o
-- reagenda de forma idempotente (cron.schedule con el mismo jobname reemplaza).
--
-- El token JAMÁS queda en texto plano en el comando agendado: el comando lo
-- lee del Vault EN CADA ejecución. Se usa un token DEDICADO del worker
-- (WORKER_SYNC_TOKEN), no la service key: el formato de las keys de Supabase
-- varía por proyecto (JWT legacy vs sb_secret_…) y acoplarse a él produce
-- 401 silenciosos entre el cron y la función.
--
-- Uso por entorno (una vez):
--   1. supabase secrets set WORKER_SYNC_TOKEN=<token aleatorio>
--   2. select vault.create_secret('<mismo token>', 'worker_sync_token',
--                                 'Invocación del worker via pg_cron');
--   3. select schedule_worker_cron('https://<proyecto>.supabase.co/functions/v1/worker-sync');
-- Para detener: select cron.unschedule('drain-sync-jobs');

create or replace function schedule_worker_cron(
  p_function_url text,
  p_secret_name  text default 'worker_sync_token',
  p_schedule     text default '* * * * *'
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmd text;
begin
  if not exists (select 1 from vault.secrets where name = p_secret_name) then
    raise exception 'No existe el secreto "%" en Vault: crearlo antes con vault.create_secret', p_secret_name;
  end if;

  v_cmd := format(
    $cmd$select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = %L)),
      body := '{}'::jsonb);$cmd$,
    p_function_url, p_secret_name);

  return cron.schedule('drain-sync-jobs', p_schedule, v_cmd);
end;
$$;

revoke all on function schedule_worker_cron(text, text, text) from public, anon, authenticated;
grant execute on function schedule_worker_cron(text, text, text) to service_role;
