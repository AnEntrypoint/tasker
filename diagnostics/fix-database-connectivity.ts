/**
 * Database Connectivity Fix
 * 
 * This script attempts to fix database connectivity issues
 * by updating the wrappedsupabase function configuration.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.31.0';

const env = config();

// Configuration
const ANON_KEY = env.SUPABASE_ANON_KEY || 'your-anon-key';
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || 'your-service-role-key';
const SUPABASE_URL = env.SUPABASE_URL || 'http://127.0.0.1:8000';

// Helper function to load the wrappedsupabase edge function code
async function loadEdgeFunctionCode() {
  console.log("Loading edge function code from wrappedsupabase/index.ts...");
  
  try {
    const functionCode = await Deno.readTextFile("supabase/functions/wrappedsupabase/index.ts");
    return functionCode;
  } catch (error) {
    console.error("Error loading edge function code:", error.message);
    return null;
  }
}

// Helper function to update the edge function code with proper config
function updateEdgeFunctionCode(code) {
  console.log("Analyzing and updating edge function code...");
  
  // Pattern to find the Supabase client creation
  const clientCreationPattern = /createClient\((.+?),\s*(.+?)(?:,\s*(.+?))?\)/;
  
  // Check if the edge function is using environment variables
  if (code.includes("Deno.env.get")) {
    console.log("✅ Edge function is using environment variables");
  } else {
    console.log("❌ Edge function is not using environment variables");
    
    // Update the code to use environment variables
    const updated = code.replace(
      clientCreationPattern,
      'createClient(Deno.env.get("SUPABASE_URL") || $1, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || $2, { auth: { persistSession: false, autoRefreshToken: false } })'
    );
    
    if (updated !== code) {
      console.log("Updated code to use environment variables");
      code = updated;
    } else {
      console.log("Could not update client creation pattern");
    }
  }
  
  // Check for proper client options
  if (!code.includes("persistSession: false") || !code.includes("autoRefreshToken: false")) {
    console.log("❌ Edge function may be missing proper client options");
    
    // Add client options if not present
    const updated = code.replace(
      clientCreationPattern,
      'createClient($1, $2, { auth: { persistSession: false, autoRefreshToken: false } })'
    );
    
    if (updated !== code) {
      console.log("Updated code with proper client options");
      code = updated;
    } else {
      console.log("Could not update client options");
    }
  } else {
    console.log("✅ Edge function has proper client options");
  }
  
  return code;
}

// Helper function to save the updated edge function code
async function saveEdgeFunctionCode(code) {
  console.log("Saving updated edge function code...");
  
  try {
    await Deno.writeTextFile("supabase/functions/wrappedsupabase/index.ts", code);
    console.log("✅ Edge function code updated successfully");
    return true;
  } catch (error) {
    console.error("Error saving edge function code:", error.message);
    return false;
  }
}

// Helper function to deploy the updated edge function
async function deployEdgeFunction() {
  console.log("Attempting to deploy updated edge function...");
  
  try {
    const command = new Deno.Command("supabase", {
      args: ["functions", "deploy", "wrappedsupabase"],
      stdout: "piped",
      stderr: "piped",
    });
    
    const output = await command.output();
    
    if (output.code === 0) {
      console.log("✅ Edge function deployed successfully");
      return true;
    } else {
      const errorOutput = new TextDecoder().decode(output.stderr);
      console.error("Error deploying edge function:", errorOutput);
      return false;
    }
  } catch (error) {
    console.error("Error running deploy command:", error.message);
    return false;
  }
}

// Helper function to check Supabase database status
async function checkDatabaseStatus() {
  console.log("Checking Supabase database status...");
  
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      }
    });
    
    const { error } = await supabase.from('task_runs').select('count(*)').limit(1);
    
    if (error) {
      if (error.message.includes("paused") || error.code === "PGRST301") {
        console.log("❌ Supabase project appears to be paused");
        return false;
      } else {
        console.log("⚠️ Supabase database is reachable but returned an error:", error.message);
        return true;
      }
    } else {
      console.log("✅ Supabase database is active and reachable");
      return true;
    }
  } catch (error) {
    console.error("Error checking database status:", error.message);
    return false;
  }
}

// Main function to fix database connectivity
async function fixDatabaseConnectivity() {
  console.log("=== Database Connectivity Fix ===\n");
  
  // Step 1: Check if the Supabase project is active
  console.log("Step 1: Checking if Supabase project is active");
  const isActive = await checkDatabaseStatus();
  
  if (!isActive) {
    console.log("\n❌ Your Supabase project appears to be paused or unreachable");
    console.log("Please take one of the following actions:");
    console.log("1. Go to your Supabase dashboard and restart the project if it's paused");
    console.log("2. Check your environment variables (.env file) for correct URL and keys");
    console.log("3. Verify network connectivity to your Supabase project");
    return;
  }
  
  // Step 2: Load and update the edge function code
  console.log("\nStep 2: Checking edge function configuration");
  const originalCode = await loadEdgeFunctionCode();
  
  if (!originalCode) {
    console.log("❌ Could not load edge function code");
    console.log("Please check that the wrappedsupabase function exists at supabase/functions/wrappedsupabase/index.ts");
    return;
  }
  
  const updatedCode = updateEdgeFunctionCode(originalCode);
  
  if (updatedCode === originalCode) {
    console.log("No changes needed to edge function code");
  } else {
    const saved = await saveEdgeFunctionCode(updatedCode);
    
    if (saved) {
      console.log("\nStep 3: Deploying updated edge function");
      const deployed = await deployEdgeFunction();
      
      if (deployed) {
        console.log("\n✅ Database connectivity should now be fixed");
        console.log("Please run test-db-connection.ts to verify the fix");
      } else {
        console.log("\n❌ Failed to deploy updated edge function");
        console.log("Try manually deploying with: supabase functions deploy wrappedsupabase");
      }
    } else {
      console.log("\n❌ Failed to save updated edge function code");
    }
  }
  
  // Step 4: Provide additional recommendations
  console.log("\nAdditional Recommendations:");
  console.log("1. Check that your .env file contains the following variables:");
  console.log("   - SUPABASE_URL");
  console.log("   - SUPABASE_ANON_KEY");
  console.log("   - SUPABASE_SERVICE_ROLE_KEY");
  
  console.log("\n2. Ensure that all edge functions are deployed with:");
  console.log("   supabase functions deploy --no-verify-jwt");
  
  console.log("\n3. Verify that table permissions are correctly set in Supabase dashboard:");
  console.log("   - stack_runs table should be accessible by authenticated services");
  console.log("   - task_runs table should be accessible by authenticated services");
  
  console.log("\nAfter making these changes, run the comprehensive diagnostic tools again");
}

// Run the fix immediately
fixDatabaseConnectivity(); 