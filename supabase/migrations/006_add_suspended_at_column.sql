-- Add suspended_at column to task_runs table
-- This column is required by the deno-executor for tracking task suspension times

ALTER TABLE task_runs 
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;

-- Add index for performance on suspended_at queries
CREATE INDEX IF NOT EXISTS idx_task_runs_suspended_at ON task_runs(suspended_at);

-- Add comment for documentation
COMMENT ON COLUMN task_runs.suspended_at IS 'Timestamp when the task was suspended for external calls';
