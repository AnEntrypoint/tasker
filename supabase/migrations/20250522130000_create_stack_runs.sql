-- Create stack_runs table if it doesn't exist
CREATE TABLE IF NOT EXISTS stack_runs (
  id UUID PRIMARY KEY,
  parent_task_run_id UUID REFERENCES task_runs(id) ON DELETE CASCADE,
  parent_stack_run_id UUID REFERENCES stack_runs(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  method_name TEXT NOT NULL,
  args JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB,
  error JSONB,
  vm_state JSONB
);

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS stack_runs_status_idx ON stack_runs(status);
CREATE INDEX IF NOT EXISTS stack_runs_created_at_idx ON stack_runs(created_at);
CREATE INDEX IF NOT EXISTS stack_runs_parent_task_run_id_idx ON stack_runs(parent_task_run_id);
CREATE INDEX IF NOT EXISTS stack_runs_parent_stack_run_id_idx ON stack_runs(parent_stack_run_id);

-- Add RLS policies
ALTER TABLE stack_runs ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY stack_runs_service_role_policy ON stack_runs
  USING (true)
  WITH CHECK (true); 