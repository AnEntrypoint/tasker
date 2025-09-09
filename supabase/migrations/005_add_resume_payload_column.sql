-- Add resume_payload column to stack_runs table
ALTER TABLE stack_runs ADD COLUMN IF NOT EXISTS resume_payload JSONB;