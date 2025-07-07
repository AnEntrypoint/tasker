-- Add suspended_at column to task_runs table
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS suspended_at timestamptz; 