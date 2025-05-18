-- supabase/migrations/00000000000000_initial_schema.sql
-- Fresh initial schema for task execution system

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

-- Function to automatically update 'updated_at' timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- task_functions: Stores definitions of executable tasks
CREATE TABLE IF NOT EXISTS public.task_functions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL,
    schema JSONB, 
    description TEXT,
    version TEXT DEFAULT 'latest',
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create trigger for updating timestamps
CREATE TRIGGER trigger_update_task_functions_updated_at
BEFORE UPDATE ON public.task_functions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- task_runs: Tracks overall task execution
CREATE TABLE IF NOT EXISTS public.task_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_function_id UUID REFERENCES public.task_functions(id) ON DELETE SET NULL,
    task_name TEXT NOT NULL,
    input JSONB,
    status TEXT NOT NULL DEFAULT 'queued',
    result JSONB,
    error JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);

-- Create trigger for updating timestamps
CREATE TRIGGER trigger_update_task_runs_updated_at
BEFORE UPDATE ON public.task_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- keystore: For API keys and other secrets
CREATE TABLE IF NOT EXISTS public.keystore (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE (scope, name)
);

-- Create trigger for updating timestamps
CREATE TRIGGER trigger_update_keystore_updated_at
BEFORE UPDATE ON public.keystore
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS for all tables
ALTER TABLE public.task_functions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keystore ENABLE ROW LEVEL SECURITY;

-- Create policies for service role access
CREATE POLICY "Allow full access to service_role on task_functions" 
ON public.task_functions FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow anon read access to task_functions" 
ON public.task_functions FOR SELECT TO anon USING (true);

CREATE POLICY "Allow full access to service_role on task_runs" 
ON public.task_runs FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow full access to service_role on keystore" 
ON public.keystore FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_task_functions_name ON public.task_functions(name);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON public.task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_created_at ON public.task_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_keystore_scope_name ON public.keystore(scope, name); 