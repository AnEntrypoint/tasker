-- Create task_functions table
CREATE TABLE IF NOT EXISTS public.task_functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, -- Define column first
  code TEXT NOT NULL,
  description TEXT
);

-- Add UNIQUE constraint separately
ALTER TABLE public.task_functions
ADD CONSTRAINT task_functions_name_unique UNIQUE (name);

-- Create keystore table
CREATE TABLE IF NOT EXISTS public.keystore (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT DEFAULT 'global',
  owner_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(name, scope, owner_id) 
);

-- Create index for keystore name lookup
CREATE INDEX IF NOT EXISTS idx_keystore_name ON keystore (name);