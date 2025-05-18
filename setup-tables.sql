-- Create task_functions table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.task_functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create stack_runs table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.stack_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_task_run_id UUID,
  service_name TEXT NOT NULL,
  method_name TEXT NOT NULL,
  args JSONB,
  vm_state JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for efficient querying
CREATE INDEX IF NOT EXISTS stack_runs_status_idx ON public.stack_runs (status);
CREATE INDEX IF NOT EXISTS stack_runs_created_at_idx ON public.stack_runs (created_at);

-- Create task_runs table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.task_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  args JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create triggers for the stack processor
CREATE OR REPLACE FUNCTION process_stack_run() RETURNS TRIGGER AS $$
BEGIN
  PERFORM http_post(
    'http://127.0.0.1:8000/functions/v1/stack-processor',
    json_build_object('stack_run_id', NEW.id)::text,
    'application/json'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop the trigger if it exists
DROP TRIGGER IF EXISTS stack_run_inserted_trigger ON stack_runs;

-- Create the trigger
CREATE TRIGGER stack_run_inserted_trigger
AFTER INSERT ON stack_runs
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION process_stack_run(); 