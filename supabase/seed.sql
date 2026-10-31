-- Local development seed: login users + one empty tenant. NO business data (owner will import real files later).
-- owner@cre-os.local / password123  (platform admin + workspace owner)
-- colleague@cre-os.local / password123 (editor, sees only assigned accounts)
-- other@cre-os.local / password123 (owner of a second tenant; used for isolation tests)

do $$
declare
  u_owner uuid := '00000000-0000-4000-8000-000000000001';
  u_col   uuid := '00000000-0000-4000-8000-000000000002';
  u_other uuid := '00000000-0000-4000-8000-000000000003';
  ws1 uuid := '10000000-0000-4000-8000-000000000001';
  ws2 uuid := '10000000-0000-4000-8000-000000000002';
  r record;
begin
  for r in select * from (values (u_owner,'owner@cre-os.local'),(u_col,'colleague@cre-os.local'),(u_other,'other@cre-os.local')) as t(id,email) loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', r.id, 'authenticated', 'authenticated', r.email,
            extensions.crypt('password123', extensions.gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), r.id, r.id::text, jsonb_build_object('sub', r.id::text, 'email', r.email), 'email', now(), now(), now());
  end loop;

  insert into mudar.platform_admin(user_id) values (u_owner);
  insert into mudar.workspace(id, name, slug) values (ws1, 'Tenant One (Pune occupier services)', 'tenant-one'),
                                                      (ws2, 'Tenant Two', 'tenant-two');
  insert into mudar.membership(workspace_id, user_id, role, allowed_classifications, see_all_accounts, display_name) values
    (ws1, u_owner, 'owner', array['public','permitted_personal','corporate_confidential','licensed_restricted']::mudar.classification[], true, 'Owner'),
    (ws1, u_col, 'editor', array['public','permitted_personal','corporate_confidential']::mudar.classification[], false, 'Colleague'),
    (ws2, u_other, 'owner', array['public','permitted_personal','corporate_confidential','licensed_restricted']::mudar.classification[], true, 'Other owner');
end $$;
