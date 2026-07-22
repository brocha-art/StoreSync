-- Limpieza de la tienda de prueba local (inverso de seed_tienda_prueba.sql).
-- Borra en cascada tienda, catálogo, eventos; purga la cola y los secretos.

delete from artists where name = 'Artista Prueba Local';
delete from vault.secrets where name like '%prueba-local.myshopify.com';
select pgmq.purge_queue('sync_jobs');
