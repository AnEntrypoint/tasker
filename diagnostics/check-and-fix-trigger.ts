/**
 * Check and Fix Stack Runs Trigger
 * 
 * This tool checks if the stack_runs trigger is properly installed
 * and attempts to recreate it if missing.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

// The SQL for creating the proper trigger
const CREATE_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION process_stack_run()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('stack_runs_notification', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stack_runs_trigger ON stack_runs;

CREATE TRIGGER stack_runs_trigger
AFTER INSERT ON stack_runs
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION process_stack_run();
`;

// The SQL for checking existing triggers
const CHECK_TRIGGERS_SQL = `
SELECT trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_table = 'stack_runs'
ORDER BY trigger_name;
`;

async function checkAndFixTrigger() {
  console.log("=== Stack Runs Trigger Check and Fix ===\n");
  let fixNeeded = false;
  
  try {
    console.log("Step 1: Checking for existing triggers on stack_runs table");
    
    const checkResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        chain: [
          { type: "call", property: "rpc", args: ["query", { query: CHECK_TRIGGERS_SQL }] }
        ]
      })
    });
    
    if (checkResponse.ok) {
      const checkResult = await checkResponse.json();
      
      if (checkResult.data && checkResult.data.length > 0) {
        console.log("Found existing triggers:");
        let foundProcessingTrigger = false;
        
        checkResult.data.forEach((trigger: any, i: number) => {
          console.log(`${i+1}. ${trigger.trigger_name} (${trigger.event_manipulation})`);
          console.log(`   ${trigger.action_statement}`);
          
          if (trigger.trigger_name === 'stack_runs_trigger' && 
              trigger.action_statement.includes('process_stack_run()')) {
            foundProcessingTrigger = true;
          }
        });
        
        if (foundProcessingTrigger) {
          console.log("\n✅ The stack_runs_trigger is properly installed");
        } else {
          console.log("\n❌ The stack_runs_trigger is missing or incorrect");
          fixNeeded = true;
        }
      } else {
        console.log("No triggers found on stack_runs table");
        fixNeeded = true;
      }
    } else {
      console.error(`Failed to check triggers: ${checkResponse.status}`);
      console.log("Attempting fix anyway");
      fixNeeded = true;
    }
    
    if (fixNeeded) {
      console.log("\nStep 2: Recreating stack_runs trigger");
      
      const fixResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        },
        body: JSON.stringify({
          chain: [
            { type: "call", property: "rpc", args: ["query", { query: CREATE_TRIGGER_SQL }] }
          ]
        })
      });
      
      if (fixResponse.ok) {
        console.log("✅ Trigger recreation SQL executed successfully");
        
        // Verify the fix
        console.log("\nStep 3: Verifying trigger installation");
        
        const verifyResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
          },
          body: JSON.stringify({
            chain: [
              { type: "call", property: "rpc", args: ["query", { query: CHECK_TRIGGERS_SQL }] }
            ]
          })
        });
        
        if (verifyResponse.ok) {
          const verifyResult = await verifyResponse.json();
          
          if (verifyResult.data && verifyResult.data.some((t: any) => t.trigger_name === 'stack_runs_trigger')) {
            console.log("✅ Verification successful - trigger now installed");
          } else {
            console.log("❌ Verification failed - trigger still not properly installed");
          }
        } else {
          console.error(`Verification failed: ${verifyResponse.status}`);
        }
        
        // Test the trigger with a record insertion
        console.log("\nStep 4: Testing trigger with a record insertion");
        const testId = crypto.randomUUID();
        
        const insertResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
          },
          body: JSON.stringify({
            chain: [
              { type: "call", property: "from", args: ["stack_runs"] },
              { type: "call", property: "insert", args: [{
                id: testId,
                service_name: "trigger_test_service",
                method_name: "echo",
                args: ["trigger_after_fix"],
                status: "pending",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }] }
            ]
          })
        });
        
        if (insertResponse.ok) {
          console.log("Test record inserted successfully with ID:", testId);
          
          // Wait a moment for trigger to process
          console.log("Waiting for trigger to process...");
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Check if record was processed
          const checkResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
            },
            body: JSON.stringify({
              chain: [
                { type: "call", property: "from", args: ["stack_runs"] },
                { type: "call", property: "select", args: ["*"] },
                { type: "call", property: "eq", args: ["id", testId] }
              ]
            })
          });
          
          if (checkResponse.ok) {
            const checkResult = await checkResponse.json();
            if (checkResult.data && checkResult.data.length > 0) {
              const record = checkResult.data[0];
              console.log(`Record status after trigger fix: ${record.status}`);
              
              if (record.status !== "pending") {
                console.log("✅ Trigger is now working - status changed from 'pending'");
              } else {
                console.log("❌ Trigger still not working properly - status remains 'pending'");
                console.log("This may indicate issues with the stack processor or notification handling");
              }
            } else {
              console.log("❓ Could not find test record after insertion");
            }
          } else {
            console.log(`❌ Failed to check test record: ${checkResponse.status}`);
          }
        } else {
          console.log(`❌ Failed to insert test record: ${insertResponse.status}`);
        }
      } else {
        console.error(`Failed to recreate trigger: ${fixResponse.status}`);
      }
    } else {
      console.log("\nNo trigger fix needed.");
    }
    
    // Additional check for notification listening in stack processor
    console.log("\nStep 5: Checking stack processor notification handling");
    
    try {
      const pingResponse = await fetch("http://127.0.0.1:8000/functions/v1/stack-processor", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        },
        body: JSON.stringify({ 
          action: "check_notifications"
        }),
        signal: AbortSignal.timeout(5000)
      });
      
      if (pingResponse.ok) {
        const pingResult = await pingResponse.json();
        console.log("Stack processor notification check result:", pingResult);
      } else {
        console.log(`Stack processor notification check failed: ${pingResponse.status}`);
      }
    } catch (error) {
      console.error("Notification check error:", error instanceof Error ? error.message : String(error));
    }
    
    console.log("\nTrigger check and fix process complete.");
    
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the check and fix immediately
checkAndFixTrigger(); 