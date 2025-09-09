-- Add waiting_on_stack_run_id column to stack_runs table
-- This is needed for parent-child stack run relationships
ALTER TABLE stack_runs 
ADD COLUMN IF NOT EXISTS waiting_on_stack_run_id INTEGER REFERENCES stack_runs(id);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_stack_runs_waiting_on 
ON stack_runs(waiting_on_stack_run_id);

-- Create index for parent_stack_run_id for better performance
CREATE INDEX IF NOT EXISTS idx_stack_runs_parent_stack 
ON stack_runs(parent_stack_run_id);