-- Add missing waiting_on_stack_run_id column to stack_runs table
ALTER TABLE IF EXISTS stack_runs 
ADD COLUMN IF NOT EXISTS waiting_on_stack_run_id UUID REFERENCES stack_runs(id);

-- Add an index for efficient querying
CREATE INDEX IF NOT EXISTS stack_runs_waiting_on_stack_run_id_idx ON stack_runs(waiting_on_stack_run_id);

-- Add missing resume_payload column
ALTER TABLE IF EXISTS stack_runs 
ADD COLUMN IF NOT EXISTS resume_payload JSONB; 