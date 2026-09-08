-- ============================================================================
--  Admin — one migration, safe to re-run
--
--  Run this once in the Supabase SQL editor, then make yourself an admin:
--
--    select public.grant_admin('you@example.com');
--
--  Not a plain UPDATE: the guard in section 4 refuses any change to is_admin
--  that does not come from an admin function, and the SQL editor is not
--  running as service_role, so the obvious
--
--    update public.user_profiles set is_admin = true where email = '...';
--
--  is refused by the very trigger that exists to stop a user promoting
--  themselves from the browser console. grant_admin() is the way in, and it
--  is revoked from every role a browser can reach.
--
--  Until an account has that flag the Admin item stays hidden and every
--  function below refuses, so running this changes nothing on its own.
--
--  Why a flag on a real account rather than a separate password: this is a
--  static site. Anything the page could check is something the visitor
--  already has a copy of. A flag inherits the account's password rules,
--  email confirmation and whatever MFA is turned on.
--
--  Everything here is `security definer` because its whole job is to see past
--  row-level security — so each function re-checks the caller on its first
--  line, and refusing is an exception rather than an empty result.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
--  1. Profile columns
--
--  user_profiles existed only to hold requires_password_reset and settings,
--  so it has no idea who anybody is. The admin list needs an address and a
--  name, kept in step with auth.users by the signup trigger below.
-- ---------------------------------------------------------------------------
alter table public.user_profiles
    add column if not exists email      text,
    add column if not exists full_name  text,
    add column if not exists is_admin   boolean not null default false;

create unique index if not exists idx_user_profiles_email
    on public.user_profiles (lower(email)) where email is not null;

-- Accounts that predate this migration have no profile row at all, or one
-- with no address on it.
insert into public.user_profiles (user_id, email, full_name)
select u.id, u.email,
       coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
                split_part(u.email, '@', 1))
  from auth.users u
on conflict (user_id) do nothing;

update public.user_profiles p
   set email      = u.email,
       full_name  = coalesce(p.full_name,
                             nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
                             split_part(u.email, '@', 1))
  from auth.users u
 where u.id = p.user_id
   and (p.email is null or p.full_name is null);

-- ---------------------------------------------------------------------------
--  2. Tables
-- ---------------------------------------------------------------------------

-- Global switches. One row per setting, so adding one needs no migration.
create table if not exists public.app_settings (
    key         text primary key,
    value       jsonb not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid references auth.users(id) on delete set null
);

insert into public.app_settings (key, value) values
    ('signups_enabled', '{"enabled": true}'::jsonb),
    ('invite_only',     '{"enabled": false}'::jsonb)
on conflict (key) do nothing;

-- Blocking an address does two things, and both are needed. This table stops
-- a NEW account being created with it (the trigger below reads it); the admin
-- API separately sets banned_until on any existing account, which is what
-- stops them signing in. One without the other leaves a way through.
create table if not exists public.banned_emails (
    email      text primary key check (email = lower(email)),
    reason     text,
    banned_at  timestamptz not null default now(),
    banned_by  uuid references auth.users(id) on delete set null
);

-- Who may register while invite_only is on.
create table if not exists public.allowed_emails (
    email     text primary key check (email = lower(email)),
    note      text,
    added_at  timestamptz not null default now(),
    added_by  uuid references auth.users(id) on delete set null
);

-- Every admin action, append-only. An admin panel without this is a panel
-- where nobody can say afterwards what was done, or by whom.
create table if not exists public.admin_audit (
    id            uuid primary key default gen_random_uuid(),
    actor_id      uuid references auth.users(id) on delete set null,
    actor_email   text not null default '',
    action        text not null,
    target_email  text,
    target_id     uuid,
    detail        jsonb not null default '{}'::jsonb,
    at            timestamptz not null default now()
);

create index if not exists idx_admin_audit_at on public.admin_audit (at desc);

alter table public.app_settings   enable row level security;
alter table public.banned_emails  enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.admin_audit    enable row level security;

-- ---------------------------------------------------------------------------
--  3. Is the caller an admin?
--
--  In its own schema, not public: policies call it, and the REST API must not
--  expose a function that answers questions about other people's accounts.
-- ---------------------------------------------------------------------------
create schema if not exists et;
revoke all on schema et from public, anon, authenticated;
grant usage on schema et to postgres, service_role;

create or replace function et.is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select coalesce((select p.is_admin from public.user_profiles p
                      where p.user_id = uid), false);
$$;

-- These four tables are admin-only. The policies exist so a direct REST read
-- with an admin's own token works too, and so nothing is RLS-enabled with no
-- policy at all — which would silently deny everything.
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings
    for select using (et.is_admin((select auth.uid())));

drop policy if exists banned_emails_admin on public.banned_emails;
create policy banned_emails_admin on public.banned_emails
    for select using (et.is_admin((select auth.uid())));

drop policy if exists allowed_emails_admin on public.allowed_emails;
create policy allowed_emails_admin on public.allowed_emails
    for select using (et.is_admin((select auth.uid())));

drop policy if exists admin_audit_admin on public.admin_audit;
create policy admin_audit_admin on public.admin_audit
    for select using (et.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
--  4. is_admin cannot be self-granted
--
--  "Users can manage own profile" lets you update your own user_profiles row,
--  which is right for your settings — and would let anybody run
--
--    update user_profiles set is_admin = true where user_id = auth.uid()
--
--  from the browser console. RLS is row-level, not column-level, so the
--  policy cannot express "every column but this one". A trigger can.
-- ---------------------------------------------------------------------------
create or replace function public.guard_admin_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    -- The coalesce is load-bearing. current_setting(name, true) is NULL when
    -- the setting has never been set, and `NULL <> 'yes'` is NULL rather than
    -- true — so without it this `if` never fires and the guard permits
    -- everything it exists to refuse.
    if new.is_admin is distinct from old.is_admin
       and coalesce(current_setting('expensetracker.granting_admin', true), 'no') <> 'yes'
       and coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'is_admin can only be changed by an administrator.'
            using errcode = 'insufficient_privilege';
    end if;
    return new;
end $$;

drop trigger if exists on_profile_admin_guard on public.user_profiles;
create trigger on_profile_admin_guard
    before update on public.user_profiles
    for each row execute function public.guard_admin_flag();

-- ---------------------------------------------------------------------------
--  4b. Bootstrapping the first admin
--
--  The guard above is deliberately strict, which leaves nobody able to grant
--  the first flag: admin_set_profile() requires you to be an admin already,
--  and a plain UPDATE from the SQL editor is refused because that session is
--  not service_role either.
--
--  This is the way in. It sets the same transaction-local marker
--  admin_set_profile() uses, and it is REVOKEd from anon and authenticated,
--  so it exists only for whoever can already open the SQL editor — who owns
--  the database and could drop the trigger anyway.
--
--  Use it once, for yourself. Everybody after that is promoted from the
--  panel, where it is audited.
-- ---------------------------------------------------------------------------
create or replace function public.grant_admin(p_email text, p_admin boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare addr text := lower(trim(p_email)); touched int;
begin
    perform set_config('expensetracker.granting_admin', 'yes', true);

    update public.user_profiles
       set is_admin = p_admin, updated_at = now()
     where lower(email) = addr;
    get diagnostics touched = row_count;

    perform set_config('expensetracker.granting_admin', 'no', true);

    if touched = 0 then
        return 'No profile with that address. Has that account signed up yet? ' ||
               'If it signed up before this migration, section 1 backfills it — ' ||
               'check: select email from public.user_profiles;';
    end if;

    return addr || ' is ' || case when p_admin then 'now an administrator.'
                                  else 'no longer an administrator.' end;
end $$;

-- Never reachable from the browser: PostgREST exposes public functions to
-- anon and authenticated by default, and this one bypasses the guard.
revoke all on function public.grant_admin(text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
--  5. Signup gate
--
--  Authoritative, because it runs inside the transaction that creates the
--  user: raising here means no auth.users row and no profile.
--
--  This replaces create_default_expense_types(), which did the last third of
--  the job. Two AFTER INSERT triggers on auth.users would each insert the
--  default types, so the old one is dropped rather than left alongside.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    addr text := lower(new.email);
begin
    if exists (select 1 from public.banned_emails where email = addr) then
        raise exception 'This email address is blocked.' using errcode = 'check_violation';
    end if;

    if not coalesce((select (value->>'enabled')::boolean
                       from public.app_settings where key = 'signups_enabled'), true) then
        raise exception 'New accounts are closed.' using errcode = 'check_violation';
    end if;

    if coalesce((select (value->>'enabled')::boolean
                   from public.app_settings where key = 'invite_only'), false)
       and not exists (select 1 from public.allowed_emails where email = addr) then
        raise exception 'This app is invite only.' using errcode = 'check_violation';
    end if;

    insert into public.user_profiles (user_id, email, full_name)
    values (new.id, addr,
            coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                     split_part(new.email, '@', 1)))
    on conflict (user_id) do update
       set email = excluded.email,
           full_name = coalesce(public.user_profiles.full_name, excluded.full_name);

    insert into public.expense_types (user_id, name)
    values (new.id, 'Food'), (new.id, 'Transportation'), (new.id, 'Entertainment'),
           (new.id, 'Utilities'), (new.id, 'Shopping'), (new.id, 'Healthcare'),
           (new.id, 'Education'), (new.id, 'Other')
    on conflict (user_id, name) do nothing;

    return new;
end $$;

drop trigger if exists create_default_types_trigger on auth.users;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
--  6. Admin reads and writes
-- ---------------------------------------------------------------------------

create or replace function public.admin_log(
    p_action text, p_target_email text default null,
    p_target_id uuid default null, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    insert into public.admin_audit (actor_id, actor_email, action, target_email, target_id, detail)
    values (me, coalesce((select email from public.user_profiles where user_id = me), ''),
            p_action, p_target_email, p_target_id, coalesce(p_detail, '{}'::jsonb));
end $$;

create or replace function public.admin_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    return jsonb_build_object(
        'users',           (select count(*) from public.user_profiles),
        'admins',          (select count(*) from public.user_profiles where is_admin),
        'banned',          (select count(*) from public.banned_emails),
        'allowed',         (select count(*) from public.allowed_emails),
        'expenses',        (select count(*) from public.expenses),
        'spend',           (select coalesce(sum(amount), 0) from public.expenses),
        'expenses_30d',    (select count(*) from public.expenses
                             where created_at > now() - interval '30 days'),
        'new_users_30d',   (select count(*) from public.user_profiles
                             where created_at > now() - interval '30 days'),
        'signups_enabled', coalesce((select (value->>'enabled')::boolean
                                       from public.app_settings where key = 'signups_enabled'), true),
        'invite_only',     coalesce((select (value->>'enabled')::boolean
                                       from public.app_settings where key = 'invite_only'), false)
    );
end $$;

create or replace function public.admin_users(
    p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); q text; out jsonb;
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    q := '%' || lower(trim(coalesce(p_search, ''))) || '%';

    select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
      into out
      from (
        select p.user_id, p.email, p.full_name, p.is_admin, p.created_at,
               exists (select 1 from public.banned_emails b where b.email = p.email) as banned,
               (select count(*) from public.expenses e where e.user_id = p.user_id) as expenses,
               (select coalesce(sum(e.amount), 0) from public.expenses e
                 where e.user_id = p.user_id) as spend,
               (select max(e.created_at) from public.expenses e where e.user_id = p.user_id) as last_write
          from public.user_profiles p
         where p_search is null or trim(p_search) = ''
            or lower(coalesce(p.email, '')) like q
            or lower(coalesce(p.full_name, '')) like q
         order by p.created_at desc
         limit greatest(1, least(coalesce(p_limit, 50), 200))
        offset greatest(0, coalesce(p_offset, 0))
      ) t;

    return out;
end $$;

-- Everything about one person, which is the "see their log" half of the ask.
-- Read-only: an admin can look at somebody's spending without being able to
-- quietly rewrite it, and looking is not audited because listing users
-- already is — auditing every scroll would bury the actions that matter.
create or replace function public.admin_user_detail(p_user uuid, p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;

    return jsonb_build_object(
        'profile', (select row_to_json(p)::jsonb from public.user_profiles p
                     where p.user_id = p_user),
        'totals',  (select jsonb_build_object(
                      'count',    count(*),
                      'spend',    coalesce(sum(amount), 0),
                      'billed',   coalesce(sum(amount) filter (where billed), 0),
                      'unbilled', coalesce(sum(amount) filter (where not billed), 0),
                      'first',    min(date), 'last', max(date))
                     from public.expenses where user_id = p_user),
        'types',   (select coalesce(jsonb_agg(jsonb_build_object(
                      'name', t.name, 'total', t.total) order by t.total desc), '[]'::jsonb)
                     from (select e.type as name, sum(e.amount) as total
                             from public.expenses e where e.user_id = p_user
                            group by e.type order by sum(e.amount) desc limit 8) t),
        'budgets', (select coalesce(jsonb_agg(jsonb_build_object(
                      'year', b.budget_year, 'month', b.budget_month,
                      'billed', b.monthly_billed_budget,
                      'unbilled', b.monthly_unbilled_budget)
                      order by b.budget_year desc, b.budget_month desc), '[]'::jsonb)
                     from (select * from public.user_budgets where user_id = p_user
                            order by budget_year desc, budget_month desc limit 6) b),
        'expenses', (select coalesce(jsonb_agg(row_to_json(e)::jsonb
                       order by e.date desc, e.created_at desc), '[]'::jsonb)
                      from (select id, amount, type, note, date, billed, created_at
                              from public.expenses where user_id = p_user
                             order by date desc, created_at desc
                             limit greatest(1, least(coalesce(p_limit, 50), 500))) e)
    );
end $$;

create or replace function public.admin_set_profile(
    p_user uuid, p_full_name text default null, p_is_admin boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target_email text;
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    select email into target_email from public.user_profiles where user_id = p_user;
    if not found then raise exception 'No such person.'; end if;

    -- Taking your own rights away locks you out of this panel with no way
    -- back except SQL, so it is refused rather than confirmed.
    if p_user = me and p_is_admin = false then
        raise exception 'You cannot remove your own admin rights.';
    end if;

    -- Transaction local, so it is gone the moment this returns and cannot be
    -- left switched on for anything else.
    perform set_config('expensetracker.granting_admin', 'yes', true);

    update public.user_profiles set
        full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
        is_admin  = coalesce(p_is_admin, is_admin),
        updated_at = now()
     where user_id = p_user;

    perform set_config('expensetracker.granting_admin', 'no', true);

    perform public.admin_log('profile_edited', target_email, p_user,
        jsonb_build_object('full_name', p_full_name, 'is_admin', p_is_admin));

    return (select row_to_json(p)::jsonb from public.user_profiles p where p.user_id = p_user);
end $$;

create or replace function public.admin_set_setting(p_key text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    if p_key not in ('signups_enabled', 'invite_only') then
        raise exception 'Unknown setting %.', p_key;
    end if;

    insert into public.app_settings (key, value, updated_at, updated_by)
    values (p_key, jsonb_build_object('enabled', p_enabled), now(), me)
    on conflict (key) do update
        set value = excluded.value, updated_at = now(), updated_by = me;

    perform public.admin_log('setting_changed', null, null,
        jsonb_build_object('key', p_key, 'enabled', p_enabled));

    return jsonb_build_object('key', p_key, 'enabled', p_enabled);
end $$;

create or replace function public.admin_allow_email(p_email text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); addr text := lower(trim(p_email));
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    if addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'That is not an email address.';
    end if;

    insert into public.allowed_emails (email, note, added_by)
    values (addr, nullif(trim(p_note), ''), me)
    on conflict (email) do update set note = excluded.note, added_by = me;

    perform public.admin_log('email_allowed', addr, null, '{}'::jsonb);
end $$;

create or replace function public.admin_disallow_email(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); addr text := lower(trim(p_email));
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    delete from public.allowed_emails where email = addr;
    perform public.admin_log('email_disallowed', addr, null, '{}'::jsonb);
end $$;

create or replace function public.admin_lists()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    return jsonb_build_object(
        'banned',  (select coalesce(jsonb_agg(jsonb_build_object(
                      'email', b.email, 'reason', b.reason, 'at', b.banned_at,
                      'by', (select email from public.user_profiles p where p.user_id = b.banned_by),
                      'has_account', exists (select 1 from public.user_profiles p
                                              where p.email = b.email))
                      order by b.banned_at desc), '[]'::jsonb) from public.banned_emails b),
        'allowed', (select coalesce(jsonb_agg(jsonb_build_object(
                      'email', a.email, 'note', a.note, 'at', a.added_at,
                      'signed_up', exists (select 1 from public.user_profiles p
                                            where p.email = a.email))
                      order by a.added_at desc), '[]'::jsonb) from public.allowed_emails a)
    );
end $$;

create or replace function public.admin_audit_log(p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
    if not et.is_admin(me) then raise exception 'Not an administrator.'; end if;
    return (select coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.at desc), '[]'::jsonb)
              from (select actor_email, action, target_email, detail, at
                      from public.admin_audit order by at desc
                     limit greatest(1, least(coalesce(p_limit, 200), 1000))) a);
end $$;
