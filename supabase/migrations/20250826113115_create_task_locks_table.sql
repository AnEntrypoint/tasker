-- Create task_locks table for database-based coordination
CREATE TABLE IF NOT EXISTS task_locks (
    id SERIAL PRIMARY KEY,
    task_run_id INTEGER NOT NULL UNIQUE,
    locked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    locked_by TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Add index for fast lookups
CREATE INDEX IF NOT EXISTS idx_task_locks_task_run_id ON task_locks(task_run_id);

-- Add foreign key constraint to task_runs table
ALTER TABLE task_locks
ADD CONSTRAINT fk_task_locks_task_run_id
FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE;