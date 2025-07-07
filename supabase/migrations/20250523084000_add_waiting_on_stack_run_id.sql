-- Add waiting_on_stack_run_id column to stack_runs table
ALTER TABLE stack_runs 
ADD COLUMN IF NOT EXISTS waiting_on_stack_run_id UUID REFERENCES stack_runs(id) ON DELETE SET NULL;

-- Add index for efficient querying of waiting relationships
CREATE INDEX IF NOT EXISTS stack_runs_waiting_on_stack_run_id_idx ON stack_runs(waiting_on_stack_run_id);

-- Add comment for documentation
COMMENT ON COLUMN stack_runs.waiting_on_stack_run_id IS 'ID of the stack run this stack run is waiting for to complete'; 