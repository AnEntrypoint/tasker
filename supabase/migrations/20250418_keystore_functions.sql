-- Create functions for secure keystore access
-- Get a value from the keystore
CREATE OR REPLACE FUNCTION get_keystore_value(p_key_name TEXT, p_namespace TEXT DEFAULT 'global')
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_value TEXT;
BEGIN
  SELECT value INTO v_value
  FROM keystore
  WHERE name = p_key_name AND scope = p_namespace
  LIMIT 1;
  
  RETURN v_value;
END;
$$;

-- Set a value in the keystore
CREATE OR REPLACE FUNCTION set_keystore_value(p_key_name TEXT, p_namespace TEXT, p_value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Try to update first
  UPDATE keystore
  SET value = p_value, updated_at = now()
  WHERE name = p_key_name AND scope = p_namespace;
  
  -- If no rows were updated, insert
  IF NOT FOUND THEN
    BEGIN
      INSERT INTO keystore (name, scope, value)
      VALUES (p_key_name, p_namespace, p_value);
      EXCEPTION WHEN unique_violation THEN
        -- Handle race condition - try update again
        UPDATE keystore
        SET value = p_value, updated_at = now()
        WHERE name = p_key_name AND scope = p_namespace;
    END;
  END IF;
  
  RETURN TRUE;
END;
$$;

-- List all keys in a namespace
CREATE OR REPLACE FUNCTION list_keystore_keys(p_namespace TEXT DEFAULT 'global')
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_keys TEXT[];
BEGIN
  SELECT array_agg(name) INTO v_keys
  FROM keystore
  WHERE scope = p_namespace;
  
  RETURN v_keys;
END;
$$;

-- List all namespaces
CREATE OR REPLACE FUNCTION list_keystore_namespaces()
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_namespaces TEXT[];
BEGIN
  SELECT array_agg(DISTINCT scope) INTO v_namespaces
  FROM keystore
  WHERE scope IS NOT NULL;
  
  IF v_namespaces IS NULL THEN
    RETURN ARRAY['global', 'openai']::TEXT[];
  END IF;
  
  RETURN v_namespaces;
END;
$$; 