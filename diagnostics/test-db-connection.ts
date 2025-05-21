/**
 * Database Connectivity Test
 * 
 * This script tests connection to the Supabase database both through
 * the wrapped edge function and directly with the Supabase client.
 * It helps identify where the database connectivity is breaking down.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.31.0';

const env = config();

// Configuration
const API_BASE = "http://127.0.0.1:8000/functions/v1";
const ANON_KEY = env.SUPABASE_ANON_KEY || 'your-anon-key';
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || 'your-service-role-key';
const SUPABASE_URL = env.SUPABASE_URL || 'http://127.0.0.1:8000';

async function testDatabaseConnectivity() {
  console.log("=== Database Connectivity Test ===\n");
  
  try {
    // Test 1: Direct Supabase client with Anon Key
    console.log("Test 1: Direct Supabase client with Anon Key");
    
    try {
      const supabaseAnon = createClient(SUPABASE_URL, ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        }
      });
      
      console.log("Attempting to query task_runs table...");
      const { data: anonData, error: anonError } = await supabaseAnon
        .from('task_runs')
        .select('count(*)')
        .limit(1);
      
      if (anonError) {
        console.error("❌ Anon key query failed:", anonError.message);
      } else {
        console.log("✅ Anon key query successful:", anonData);
      }
    } catch (error) {
      console.error("❌ Anon key client error:", error instanceof Error ? error.message : String(error));
    }
    
    // Test 2: Direct Supabase client with Service Role Key
    console.log("\nTest 2: Direct Supabase client with Service Role Key");
    
    try {
      const supabaseService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        }
      });
      
      console.log("Attempting to query task_runs table...");
      const { data: serviceData, error: serviceError } = await supabaseService
        .from('task_runs')
        .select('count(*)')
        .limit(1);
      
      if (serviceError) {
        console.error("❌ Service role key query failed:", serviceError.message);
      } else {
        console.log("✅ Service role key query successful:", serviceData);
      }
    } catch (error) {
      console.error("❌ Service role client error:", error instanceof Error ? error.message : String(error));
    }
    
    // Test 3: Check if supabase edge function is running
    console.log("\nTest 3: Testing Wrapped Supabase Edge Function");
    
    try {
      const pingResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({
          ping: true
        })
      });
      
      if (pingResponse.ok) {
        const pingResult = await pingResponse.json();
        console.log("✅ Wrapped Supabase function is accessible:", pingResult);
      } else {
        console.error(`❌ Wrapped Supabase function not accessible: ${pingResponse.status}`);
        try {
          const errorText = await pingResponse.text();
          console.error("Error details:", errorText);
        } catch (e) {
          console.error("Could not read error response");
        }
      }
    } catch (error) {
      console.error("❌ Wrapped Supabase request error:", error instanceof Error ? error.message : String(error));
    }
    
    // Test 4: Try accessing tables through the wrapped function
    console.log("\nTest 4: Testing Table Access Through Wrapped Function");
    
    try {
      const tableResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({
          chain: [
            { type: "call", property: "rpc", args: ["list_tables", {}] }
          ]
        })
      });
      
      if (tableResponse.ok) {
        const tableResult = await tableResponse.json();
        console.log("✅ Table list query successful:", tableResult.data);
      } else {
        console.error(`❌ Table list query failed: ${tableResponse.status}`);
        try {
          const errorText = await tableResponse.text();
          console.error("Error details:", errorText);
        } catch (e) {
          console.error("Could not read error response");
        }
      }
    } catch (error) {
      console.error("❌ Table list request error:", error instanceof Error ? error.message : String(error));
    }
    
    // Test 5: Check the stack-processor edge function
    console.log("\nTest 5: Testing Stack Processor Edge Function");
    
    try {
      const procResponse = await fetch(`${API_BASE}/stack-processor`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({ action: "ping" })
      });
      
      if (procResponse.ok) {
        const procResult = await procResponse.json();
        console.log("✅ Stack processor is accessible:", procResult);
      } else {
        console.error(`❌ Stack processor not accessible: ${procResponse.status}`);
        try {
          const errorText = await procResponse.text();
          console.error("Error details:", errorText);
        } catch (e) {
          console.error("Could not read error response");
        }
      }
    } catch (error) {
      console.error("❌ Stack processor request error:", error instanceof Error ? error.message : String(error));
    }
    
    // Summary
    console.log("\n=== Connectivity Test Summary ===");
    console.log("If direct Supabase client tests pass but wrapped function tests fail:");
    console.log("- The wrappedsupabase edge function may be misconfigured or not deployed");
    console.log("- Check edge function logs for errors related to database access");
    
    console.log("\nIf all tests fail:");
    console.log("- Supabase project may be paused or unreachable");
    console.log("- Environment variables may be incorrect");
    console.log("- Network connectivity issues may be preventing access");
    
    console.log("\nIf stack processor tests pass but database tests fail:");
    console.log("- The stack processor is running but can't access the database");
    console.log("- This would explain tasks getting 'stuck' - they can start but not complete");
    
  } catch (error) {
    console.error("Overall test error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the test immediately
testDatabaseConnectivity(); 