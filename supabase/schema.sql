-- WIWY initial database foundation
-- Run in the Supabase SQL Editor for the WIWY project only.
-- This schema is a starting point; app authentication/sync code is not yet wired.

create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Chicago',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_profile_id uuid,
  role text not null default 'Member' check (role in ('Admin','Manager','Member')),
  created_at timestamptz not null default now(),
  unique(workspace_id,user_id)
);

create table if not exists public.member_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  display_name text not null,
  color text not null default '#789a80',
  birth_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_memberships
  add constraint workspace_memberships_profile_fk
  foreign key (member_profile_id) references public.member_profiles(id) on delete set null;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  assignee_profile_id uuid references public.member_profiles(id) on delete set null,
  recurrence jsonb not null default '{"type":"once"}'::jsonb,
  start_time time,
  end_time time,
  notes text not null default '',
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_operations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  label text not null,
  sort_order integer not null default 0,
  is_required boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.task_occurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  occurrence_date date not null,
  assignee_profile_id uuid references public.member_profiles(id) on delete set null,
  status text not null default 'not_started' check (status in ('not_started','in_progress','completed','skipped')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(task_id,occurrence_date)
);

create table if not exists public.task_operation_completions (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references public.task_occurrences(id) on delete cascade,
  operation_id uuid not null references public.task_operations(id) on delete cascade,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  unique(occurrence_id,operation_id)
);

create table if not exists public.workspace_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  assigned_profile_id uuid references public.member_profiles(id) on delete set null,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meal_date date not null,
  meal_type text not null default 'dinner',
  name text not null,
  notes text not null default '',
  recipe jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.grocery_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  category text not null default 'General',
  quantity text not null default '',
  is_completed boolean not null default false,
  linked_meal_id uuid references public.meals(id) on delete set null,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.away_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  member_profile_id uuid references public.member_profiles(id) on delete cascade,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.activity_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_profile_id uuid references public.member_profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Membership helper: checks whether the current authenticated user belongs to a workspace.
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = target_workspace and wm.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
  );
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.member_profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.task_operations enable row level security;
alter table public.task_occurrences enable row level security;
alter table public.task_operation_completions enable row level security;
alter table public.workspace_events enable row level security;
alter table public.meals enable row level security;
alter table public.grocery_items enable row level security;
alter table public.away_periods enable row level security;
alter table public.activity_ledger enable row level security;

-- Workspace-level policies. Creation/invitation workflows will add stricter role-specific policies later.
create policy "members can view workspaces" on public.workspaces for select using (public.is_workspace_member(id));
create policy "authenticated users can create workspaces" on public.workspaces for insert with check (auth.uid() = created_by);
create policy "admins can update workspaces" on public.workspaces for update using (public.has_workspace_role(id,array['Admin'])) with check (public.has_workspace_role(id,array['Admin']));

create policy "members can view memberships" on public.workspace_memberships for select using (public.is_workspace_member(workspace_id));
create policy "admins can manage memberships" on public.workspace_memberships for all using (public.has_workspace_role(workspace_id,array['Admin'])) with check (public.has_workspace_role(workspace_id,array['Admin']));

create policy "members can view profiles" on public.member_profiles for select using (public.is_workspace_member(workspace_id));
create policy "managers can manage profiles" on public.member_profiles for all using (public.has_workspace_role(workspace_id,array['Admin','Manager'])) with check (public.has_workspace_role(workspace_id,array['Admin','Manager']));

create policy "members can view tasks" on public.tasks for select using (public.is_workspace_member(workspace_id));
create policy "members can manage tasks" on public.tasks for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "members can view task operations" on public.task_operations for select using (exists(select 1 from public.tasks t where t.id=task_id and public.is_workspace_member(t.workspace_id)));
create policy "members can manage task operations" on public.task_operations for all using (exists(select 1 from public.tasks t where t.id=task_id and public.is_workspace_member(t.workspace_id))) with check (exists(select 1 from public.tasks t where t.id=task_id and public.is_workspace_member(t.workspace_id)));

create policy "members can view occurrences" on public.task_occurrences for select using (public.is_workspace_member(workspace_id));
create policy "members can manage occurrences" on public.task_occurrences for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "members can view operation completions" on public.task_operation_completions for select using (exists(select 1 from public.task_occurrences o where o.id=occurrence_id and public.is_workspace_member(o.workspace_id)));
create policy "members can manage operation completions" on public.task_operation_completions for all using (exists(select 1 from public.task_occurrences o where o.id=occurrence_id and public.is_workspace_member(o.workspace_id))) with check (exists(select 1 from public.task_occurrences o where o.id=occurrence_id and public.is_workspace_member(o.workspace_id)));

create policy "members can view events" on public.workspace_events for select using (public.is_workspace_member(workspace_id));
create policy "members can manage events" on public.workspace_events for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "members can view meals" on public.meals for select using (public.is_workspace_member(workspace_id));
create policy "members can manage meals" on public.meals for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "members can view groceries" on public.grocery_items for select using (public.is_workspace_member(workspace_id));
create policy "members can manage groceries" on public.grocery_items for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "members can view away periods" on public.away_periods for select using (public.is_workspace_member(workspace_id));
create policy "managers can manage away periods" on public.away_periods for all using (public.has_workspace_role(workspace_id,array['Admin','Manager'])) with check (public.has_workspace_role(workspace_id,array['Admin','Manager']));

create policy "members can view ledger" on public.activity_ledger for select using (public.is_workspace_member(workspace_id));
create policy "members can append ledger" on public.activity_ledger for insert with check (public.is_workspace_member(workspace_id));

-- Important follow-up before production: invitation acceptance and workspace bootstrap need
-- SECURITY DEFINER RPCs so the first admin can be created without weakening membership RLS.
