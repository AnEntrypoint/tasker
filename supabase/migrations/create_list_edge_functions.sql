-- Create a database function to list edge functions
CREATE OR REPLACE FUNCTION public.list_edge_functions()
RETURNS TABLE (name text) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    DISTINCT function_name::text
  FROM 
    supabase_functions.migrations
  WHERE 
    function_name IS NOT NULL
  ORDER BY 
    function_name;
END;
$$; 