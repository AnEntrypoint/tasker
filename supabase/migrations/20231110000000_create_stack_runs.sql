-- Database schema for task execution

-- Enable RLS on all tables
alter table if exists public.task_functions enable row level security;

-- Create task_runs table if it doesn't exist
create table if not exists public.task_runs (
    id uuid primary key default gen_random_uuid(),
    task_function_id uuid references public.task_functions(id) on delete set null,
    task_name text not null,
    input jsonb,
    status text not null default 'queued',
    result jsonb,
    error jsonb,
    log_entries jsonb,
    parent_run_id uuid references public.task_runs(id),
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now(),
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    waiting_on_stack_run_id uuid
);

-- Create stack_runs table for VM execution slices
create table if not exists public.stack_runs (
    id uuid primary key default gen_random_uuid(),
    parent_stack_run_id uuid references public.stack_runs(id) on delete set null deferrable initially deferred,
    parent_task_run_id uuid references public.task_runs(id) on delete cascade,
    service_name text not null,
    method_name text not null,
    args jsonb,
    resume_payload jsonb,
    status text not null default 'pending_execution',
    result jsonb,
    error jsonb,
    vm_state jsonb,
    call_site_id text,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now(),
    started_at timestamp with time zone,
    ended_at timestamp with time zone
);

-- Add indexes for efficient querying
create index if not exists idx_task_runs_status on public.task_runs(status);
create index if not exists idx_task_runs_created_at on public.task_runs(created_at);
create index if not exists idx_stack_runs_status on public.stack_runs(status);
create index if not exists idx_stack_runs_created_at on public.stack_runs(created_at);

-- Create the extension for HTTP requests if not exists
create extension if not exists "http" with schema extensions;

-- Create a function to process the next pending stack_run
create or replace function process_next_stack_run()
returns trigger as $$
declare
    stack_run_id uuid;
begin
    -- Only trigger on new pending execution or status change to pending
    if TG_OP = 'INSERT' or (TG_OP = 'UPDATE' and NEW.status = 'pending_execution') then
        stack_run_id := NEW.id;
        
        -- Send request to the quickjs edge function
        perform extensions.http_post(
            concat(
                current_setting('app.settings.supabase_url', TRUE), 
                '/functions/v1/quickjs'
            ),
            jsonb_build_object('stackRunId', stack_run_id),
            'application/json',
            jsonb_build_object(
                'Authorization', concat('Bearer ', current_setting('app.settings.service_role_key', TRUE)),
                'Content-Type', 'application/json'
            ),
            60000 -- 60s timeout
        );
        
        return NEW;
    end if;
    
    return NEW;
end;
$$ language plpgsql security definer;

-- Create the trigger on stack_runs table
drop trigger if exists tr_process_stack_run on public.stack_runs;
create trigger tr_process_stack_run
after insert or update of status
on public.stack_runs
for each row
when (NEW.status = 'pending_execution')
execute function process_next_stack_run();

-- Enable RLS and set permissions
alter table if exists public.task_runs enable row level security;
alter table if exists public.stack_runs enable row level security;

-- Allow service role full access
create policy "Service role can do all on task_runs"
on public.task_runs for all to service_role using (true);

create policy "Service role can do all on stack_runs"
on public.stack_runs for all to service_role using (true);

-- Create keystore table if not exists
create table if not exists public.keystore (
    id uuid primary key default gen_random_uuid(),
    scope text not null,
    key_name text not null,
    key_value text not null,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now(),
    unique(scope, key_name)
);

-- Enable RLS on keystore
alter table if exists public.keystore enable row level security;

-- Allow service role full access to keystore
create policy "Service role can do all on keystore"
on public.keystore for all to service_role using (true); 