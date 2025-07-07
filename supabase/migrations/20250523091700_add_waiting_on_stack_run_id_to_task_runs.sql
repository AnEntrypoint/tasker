-- Add waiting_on_stack_run_id column to task_runs table
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS waiting_on_stack_run_id uuid REFERENCES stack_runs(id); 