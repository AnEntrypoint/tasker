-- Add waiting_on_stack_run_id column to stack_runs table
ALTER TABLE stack_runs 
ADD COLUMN IF NOT EXISTS waiting_on_stack_run_id UUID REFERENCES stack_runs(id);

COMMENT ON COLUMN stack_runs.waiting_on_stack_run_id IS 'Reference to a child stack run that this run is waiting for'; 