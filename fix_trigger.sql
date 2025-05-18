-- Create the trigger_stack_processor function
CREATE OR REPLACE FUNCTION trigger_stack_processor()
RETURNS TRIGGER AS $$
DECLARE
  anon_key text;
  response text;
BEGIN
  -- Get the anon key from the config_parameters table
  SELECT value INTO anon_key FROM config_parameters WHERE name = 'supabase_anon_key';
  
  -- Log the trigger execution
  RAISE NOTICE 'Stack runs trigger executing for ID: %', NEW.id;
  
  -- Call the stack processor
  BEGIN
    PERFORM http_post(
      'http://127.0.0.1:8000/functions/v1/stack-processor',
      json_build_object('stackRunId', NEW.id)::text,
      'application/json',
      jsonb_build_object('Authorization', 'Bearer ' || anon_key, 'apikey', anon_key)
    );
    
    RAISE NOTICE 'Stack processor called successfully for ID: %', NEW.id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Error calling stack processor for ID: %, error: %', NEW.id, SQLERRM;
  END;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop the existing trigger if it exists
DROP TRIGGER IF EXISTS stack_runs_after_insert_trigger ON stack_runs;

-- Create the trigger
CREATE TRIGGER stack_runs_after_insert_trigger
AFTER INSERT ON stack_runs
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION trigger_stack_processor();
