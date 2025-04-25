// Test the live WrappedSupabase service
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables
const env = config();

const supabase = createServiceProxy('supabase', {
  baseUrl: `${env.EXT_SUPABASE_URL}/functions/v1/wrappedsupabase`,
  headers: {
    'Authorization': `Bearer ${env.EXT_SUPABASE_ANON_KEY}`,
    //'apikey': env.EXT_SUPABASE_ANON_KEY
  }
});

async function runTests() {
  console.log('=== Testing Live WrappedSupabase Service ===');
  
  try {
    // Test 1: Select from public table
    console.log('\nTest 1: Select from public table');
    const selectResult = await supabase.from('test_table').select('*');
    console.log('Select result:', selectResult);
    
    // Test 2: Insert into public table
    console.log('\nTest 2: Insert into public table');
    const insertResult = await supabase.from('test_table').insert([{ 
      name: 'Test User', 
      created_at: new Date().toISOString() 
    }]);
    console.log('Insert result:', insertResult);
    
    // Test 3: Auth sign up and sign in
    console.log('\nTest 3: Auth sign up and sign in');
    const email = `user${Date.now()}@example.com`;
    const password = 'password123';
    
    const signUpResult = await supabase.auth.signUp({ email, password });
    console.log('Sign up result:', signUpResult);
    
    const signInResult = await supabase.auth.signInWithPassword({ email, password });
    console.log('Sign in result:', signInResult);
    
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

await runTests();