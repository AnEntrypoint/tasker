import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

config({ export: true });

// Environment setup
const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL') || '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';

// If the URL is the edge functions URL, use the REST API URL instead for local dev
const SUPABASE_URL = extSupabaseUrl.includes('127.0.0.1:8000')
    ? 'http://localhost:54321'
    : extSupabaseUrl || (supabaseUrl.includes('127.0.0.1:8000') ? 'http://localhost:54321' : supabaseUrl);

const SUPABASE_ANON_KEY = Deno.env.get('EXT_SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

export const supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
});

export { SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_ROLE_KEY };