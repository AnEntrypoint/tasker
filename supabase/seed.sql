-- Seed the keystore table with necessary initial values
INSERT INTO public.keystore (scope, name, value) 
VALUES ('global', 'GAPI_ADMIN_EMAIL', 'admin@coas.co.za')
ON CONFLICT (scope, name) 
DO UPDATE SET value = EXCLUDED.value; 