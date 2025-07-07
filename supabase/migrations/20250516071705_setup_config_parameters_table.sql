-- Enable the http extension
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- Create the config_parameters table
CREATE TABLE public.config_parameters (
    name text PRIMARY KEY,
    value text
);

-- Insert the supabase_anon_key
-- IMPORTANT: Replace 'YOUR_ACTUAL_ANON_KEY' with the correct Supabase anon key
INSERT INTO public.config_parameters (name, value)
VALUES ('supabase_anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
