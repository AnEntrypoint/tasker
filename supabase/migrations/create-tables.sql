-- Create task_runs table to store user-initiated tasks
CREATE TABLE IF NOT EXISTS task_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_function_id UUID,
  task_name TEXT NOT NULL,
  input JSONB,
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  error JSONB,
  logs JSONB,
  aggregated_results JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

-- Create stack_runs table to store ephemeral module calls
CREATE TABLE IF NOT EXISTS stack_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_run_id UUID,
  module_name TEXT NOT NULL,
  method_name TEXT NOT NULL,
  args JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  error JSONB,
  vm_state JSONB,
  resume_payload JSONB,
  child_stack_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs (status);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_name ON task_runs (task_name);
CREATE INDEX IF NOT EXISTS idx_task_runs_created_at ON task_runs (created_at);

CREATE INDEX IF NOT EXISTS idx_stack_runs_status ON stack_runs (status);
CREATE INDEX IF NOT EXISTS idx_stack_runs_parent_run_id ON stack_runs (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_stack_runs_created_at ON stack_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_stack_runs_module_method ON stack_runs (module_name, method_name);

-- Create a function to process stack runs when they're completed
CREATE OR REPLACE FUNCTION process_completed_stack_run()
RETURNS TRIGGER AS $$
BEGIN
  -- If a stack run is completed or failed, trigger processing
  IF (NEW.status = 'completed' OR NEW.status = 'failed') AND 
     (OLD.status != 'completed' AND OLD.status != 'failed') THEN
    
    -- Call the stack-processor edge function
    PERFORM http_post(
      current_setting('app.settings.supabase_url') || '/functions/v1/stack-processor/cleanup',
      json_build_object('stack_run_id', NEW.id),
      'application/json'
    );
    
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to automatically process completed stack runs
CREATE OR REPLACE TRIGGER trigger_process_completed_stack_run
AFTER UPDATE ON stack_runs
FOR EACH ROW
EXECUTE FUNCTION process_completed_stack_run();

-- Create a function to process pending stack runs
CREATE OR REPLACE FUNCTION process_pending_stack_run()
RETURNS TRIGGER AS $$
BEGIN
  -- If a stack run is created with pending status, trigger processing
  IF NEW.status = 'pending' THEN
    
    -- Call the stack-processor edge function
    PERFORM http_post(
      current_setting('app.settings.supabase_url') || '/functions/v1/stack-processor',
      json_build_object('stack_run_id', NEW.id),
      'application/json'
    );
    
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to automatically process pending stack runs
CREATE OR REPLACE TRIGGER trigger_process_pending_stack_run
AFTER INSERT ON stack_runs
FOR EACH ROW
EXECUTE FUNCTION process_pending_stack_run(); 