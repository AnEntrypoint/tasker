-- Create stack_runs table for ephemeral call queueing
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create the stack_runs table if it doesn't exist
CREATE TABLE IF NOT EXISTS stack_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_stack_run_id UUID REFERENCES stack_runs(id),
  parent_task_run_id UUID,
  service_name TEXT NOT NULL,
  method_name TEXT NOT NULL,
  args JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  result JSONB,
  error TEXT,
  vm_state JSONB,
  resume_payload JSONB,
  waiting_on_stack_run_id UUID REFERENCES stack_runs(id)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_stack_runs_status ON stack_runs(status);
CREATE INDEX IF NOT EXISTS idx_stack_runs_created_at ON stack_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_stack_runs_parent_task_run_id ON stack_runs(parent_task_run_id);
CREATE INDEX IF NOT EXISTS idx_stack_runs_waiting_on_stack_run_id ON stack_runs(waiting_on_stack_run_id);

-- Create task_runs table if it doesn't exist
CREATE TABLE IF NOT EXISTS task_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_name TEXT NOT NULL,
  input JSONB,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  suspended_at TIMESTAMP WITH TIME ZONE,
  resumed_at TIMESTAMP WITH TIME ZONE,
  result JSONB,
  error JSONB,
  logs JSONB[],
  waiting_on_stack_run_id UUID REFERENCES stack_runs(id)
);

-- Create indexes for task_runs
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_created_at ON task_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_name ON task_runs(task_name);
CREATE INDEX IF NOT EXISTS idx_task_runs_waiting_on_stack_run_id ON task_runs(waiting_on_stack_run_id);

-- Create a function to notify the stack processor when a new stack run is created
CREATE OR REPLACE FUNCTION notify_stack_processor() RETURNS TRIGGER AS $$
BEGIN
  PERFORM http((
    'POST',
    CASE 
      WHEN current_setting('server_version_num')::integer >= 120000 THEN 
        (SELECT setting FROM pg_settings WHERE name = 'supabase_url')
      ELSE 
        'http://127.0.0.1:8000'
    END || '/functions/v1/stack-processor',
    ARRAY[
      ('Content-Type', 'application/json'),
      ('Authorization', 'Bearer ' || 
        CASE 
          WHEN current_setting('server_version_num')::integer >= 120000 THEN 
            (SELECT setting FROM pg_settings WHERE name = 'supabase.anon_key')
          ELSE 
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
        END
      )
    ],
    '{"trigger":"database_insert","stackRunId":"' || NEW.id || '"}'
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
DROP TRIGGER IF EXISTS stack_run_insert_trigger ON stack_runs;
CREATE TRIGGER stack_run_insert_trigger
AFTER INSERT ON stack_runs
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION notify_stack_processor(); 