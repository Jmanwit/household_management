-- WIWY 0.9.6 — secure household invitations and role management
-- Run once in Supabase SQL Editor after the 0.9.5 application files are deployed.
-- This migration does not delete or rewrite household data.

create extension if not exists pgcrypto;

create table if not exists public.workspace_member_permissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  permission_key text not null,
  created_at timestamptz not null default now(),
  unique(workspace_id,user_id,permission_key)
);
alter table public.workspace_member_permissions enable row level security;
drop policy if exists "members can view own permissions" on public.workspace_member_permissions;
create policy "members can view own permissions"
on public.workspace_member_permissions for select
using (user_id=auth.uid() and public.is_workspace_member(workspace_id));

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  member_profile_id uuid not null,
  invite_email text not null,
  invited_role text not null check (invited_role in ('Admin','Manager','Member')),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (member_profile_id,workspace_id)
    references public.member_profiles(id,workspace_id) on delete cascade
);

alter table public.workspace_invitations enable row level security;
drop policy if exists "admins can view workspace invitations" on public.workspace_invitations;
create policy "admins can view workspace invitations"
on public.workspace_invitations for select
using (public.has_workspace_role(workspace_id,array['Admin']));

create or replace function public.wiwy_create_member_invitation(
  target_workspace uuid,
  target_profile uuid,
  target_email text,
  target_role text default 'Member'
) returns text
language plpgsql security definer
set search_path=public,extensions
as $$
declare
  raw_token text;
  clean_email text := lower(trim(target_email));
begin
  if auth.uid() is null then raise exception 'Sign in is required.'; end if;
  if not public.has_workspace_role(target_workspace,array['Admin']) then
    raise exception 'Only a household Admin can invite or link an account.';
  end if;
  if target_role not in ('Admin','Manager','Member') then raise exception 'Invalid household role.'; end if;
  if clean_email is null or clean_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;
  if not exists(select 1 from public.member_profiles p where p.id=target_profile and p.workspace_id=target_workspace) then
    raise exception 'The selected household profile does not exist.';
  end if;
  if exists(select 1 from public.workspace_memberships wm where wm.workspace_id=target_workspace and wm.member_profile_id=target_profile) then
    raise exception 'This household profile is already linked to an account.';
  end if;
  raw_token := encode(gen_random_bytes(32),'hex');
  insert into public.workspace_invitations(workspace_id,member_profile_id,invite_email,invited_role,token_hash,invited_by)
  values(target_workspace,target_profile,clean_email,target_role,encode(digest(raw_token,'sha256'),'hex'),auth.uid());
  return raw_token;
end;
$$;

create or replace function public.wiwy_accept_member_invitation(invitation_token text)
returns jsonb
language plpgsql security definer
set search_path=public,extensions
as $$
declare
  inv public.workspace_invitations%rowtype;
  current_email text;
  new_membership_id uuid;
begin
  if auth.uid() is null then raise exception 'Create or sign in to your WIWY account first.'; end if;
  select lower(email) into current_email from auth.users where id=auth.uid();
  select * into inv from public.workspace_invitations
   where token_hash=encode(digest(invitation_token,'sha256'),'hex')
     and accepted_at is null and expires_at>now()
   for update;
  if not found then raise exception 'This invitation is invalid, expired, or already used.'; end if;
  if current_email is distinct from lower(inv.invite_email) then
    raise exception 'Sign in using the email address this invitation was sent to.';
  end if;
  if exists(select 1 from public.workspace_memberships where workspace_id=inv.workspace_id and user_id=auth.uid()) then
    raise exception 'This account is already a member of this household.';
  end if;
  if exists(select 1 from public.workspace_memberships where workspace_id=inv.workspace_id and member_profile_id=inv.member_profile_id) then
    raise exception 'That household profile has already been linked to another account.';
  end if;
  insert into public.workspace_memberships(workspace_id,user_id,member_profile_id,role)
  values(inv.workspace_id,auth.uid(),inv.member_profile_id,inv.invited_role)
  returning id into new_membership_id;
  if inv.invited_role='Manager' then
    insert into public.workspace_member_permissions(workspace_id,user_id,permission_key)
    select inv.workspace_id,auth.uid(),p.permission_key
    from (values ('tasks.assign_anyone'),('tasks.manage_all')) as p(permission_key)
    where not exists (
      select 1 from public.workspace_member_permissions x
      where x.workspace_id=inv.workspace_id and x.user_id=auth.uid() and x.permission_key=p.permission_key
    );
  end if;
  update public.workspace_invitations set accepted_at=now() where id=inv.id;
  return jsonb_build_object('success',true,'workspace_id',inv.workspace_id,'membership_id',new_membership_id,'role',inv.invited_role);
end;
$$;

create or replace function public.wiwy_set_member_role(
  target_workspace uuid,
  target_user uuid,
  new_role text
) returns jsonb
language plpgsql security definer
set search_path=public
as $$
declare
  old_role text;
  admin_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in is required.'; end if;
  if not public.has_workspace_role(target_workspace,array['Admin']) then
    raise exception 'Only a household Admin can change member roles.';
  end if;
  if new_role not in ('Admin','Manager','Member') then raise exception 'Invalid household role.'; end if;
  select role into old_role from public.workspace_memberships
   where workspace_id=target_workspace and user_id=target_user for update;
  if not found then raise exception 'Household account not found.'; end if;
  if old_role='Admin' and new_role<>'Admin' then
    select count(*) into admin_count from public.workspace_memberships
     where workspace_id=target_workspace and role='Admin';
    if admin_count<=1 then raise exception 'A household must always have at least one Admin.'; end if;
  end if;
  update public.workspace_memberships set role=new_role
   where workspace_id=target_workspace and user_id=target_user;
  if new_role='Manager' then
    insert into public.workspace_member_permissions(workspace_id,user_id,permission_key)
    select target_workspace,target_user,p.permission_key
    from (values ('tasks.assign_anyone'),('tasks.manage_all')) as p(permission_key)
    where not exists (
      select 1 from public.workspace_member_permissions x
      where x.workspace_id=target_workspace and x.user_id=target_user and x.permission_key=p.permission_key
    );
  else
    delete from public.workspace_member_permissions
     where workspace_id=target_workspace and user_id=target_user;
  end if;
  return jsonb_build_object('success',true,'old_role',old_role,'new_role',new_role);
end;
$$;


create or replace function public.wiwy_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  remaining_admins integer;
begin
  if old.role='Admin' then
    if tg_op='DELETE' or (tg_op='UPDATE' and new.role<>'Admin') then
      select count(*) into remaining_admins
        from public.workspace_memberships
        where workspace_id=old.workspace_id
          and role='Admin'
          and user_id<>old.user_id;
      if remaining_admins=0 then
        raise exception 'A household must always retain at least one Admin.';
      end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists wiwy_prevent_last_admin_removal on public.workspace_memberships;
create trigger wiwy_prevent_last_admin_removal
before update of role or delete on public.workspace_memberships
for each row execute function public.wiwy_guard_last_admin();

revoke all on function public.wiwy_guard_last_admin() from public;
revoke all on function public.wiwy_create_member_invitation(uuid,uuid,text,text) from public;
revoke all on function public.wiwy_accept_member_invitation(text) from public;
revoke all on function public.wiwy_set_member_role(uuid,uuid,text) from public;
grant execute on function public.wiwy_create_member_invitation(uuid,uuid,text,text) to authenticated;
grant execute on function public.wiwy_accept_member_invitation(text) to authenticated;
grant execute on function public.wiwy_set_member_role(uuid,uuid,text) to authenticated;

