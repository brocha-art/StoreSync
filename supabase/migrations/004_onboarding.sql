-- 004 — Alta transaccional de tienda (paso 5): secretos a Vault + fila en shops
-- La validación de los 6 requisitos de §2.2 ocurre ANTES, en TypeScript
-- (src/services/onboarding.ts). Esta función solo persiste — todo-o-nada:
-- si algo falla no queda ni tienda ni secreto huérfano (misma transacción).
--
-- Re-onboarding = rotación de credenciales (§10: una tienda en needs_reauth
-- vuelve a operar SOLO cuando llega un token nuevo por onboarding).
-- vault.update_secret conserva los uuid → las referencias de shops no cambian.

create or replace function create_shop_with_secrets(
  p_artist_id         uuid,
  p_shop_domain       text,
  p_access_token      text,
  p_webhook_secret    text,
  p_location_id       text,
  p_inventory_tracked boolean
) returns table (shop_id uuid, created boolean)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_shop shops%rowtype;
  v_token_sid uuid;
  v_whsec_sid uuid;
begin
  select * into v_shop from shops s where s.shop_domain = p_shop_domain;

  if found then
    -- Rotación: actualizar secretos en el mismo slot de Vault
    perform vault.update_secret(v_shop.access_token_secret_id, p_access_token);
    perform vault.update_secret(v_shop.webhook_secret_id, p_webhook_secret);

    update shops s set
      location_id       = p_location_id,
      inventory_tracked = p_inventory_tracked,
      status            = 'active'
    where s.id = v_shop.id;

    insert into audit_log (shop_id, entity, entity_id, action, detail)
    values (v_shop.id, 'shop', v_shop.id::text, 'credentials_rotated',
            jsonb_build_object('shop_domain', p_shop_domain, 'location_id', p_location_id));

    shop_id := v_shop.id;
    created := false;
    return next;
    return;
  end if;

  v_token_sid := vault.create_secret(
    p_access_token,
    'shop_token_' || p_shop_domain,
    'Admin API token para ' || p_shop_domain);

  v_whsec_sid := vault.create_secret(
    p_webhook_secret,
    'shop_whsec_' || p_shop_domain,
    'Webhook secret para ' || p_shop_domain);

  insert into shops (artist_id, shop_domain, access_token_secret_id,
                     webhook_secret_id, location_id, inventory_tracked)
  values (p_artist_id, p_shop_domain, v_token_sid, v_whsec_sid,
          p_location_id, p_inventory_tracked)
  returning id into shop_id;

  insert into audit_log (shop_id, entity, entity_id, action, detail)
  values (shop_id, 'shop', shop_id::text, 'onboarded',
          jsonb_build_object('shop_domain', p_shop_domain, 'location_id', p_location_id));

  created := true;
  return next;
end;
$$;

revoke all on function create_shop_with_secrets(uuid, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function create_shop_with_secrets(uuid, text, text, text, text, boolean)
  to service_role;
