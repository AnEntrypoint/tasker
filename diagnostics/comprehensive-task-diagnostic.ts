/**
 * Comprehensive Task Diagnostic Tool
 * 
 * This tool systematically tests the entire task execution pipeline
 * to identify exactly where tasks are getting stuck or failing.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

// Configuration
const API_BASE = "http://127.0.0.1:8000/functions/v1";
const ANON_KEY = env.SUPABASE_ANON_KEY || 'your-anon-key';
const TASK_NAME = "gapi-test-sleep-resume";
const TEST_TYPE = "echo"; // Using lightweight echo test to avoid API timeouts

async function runComprehensiveDiagnostic() {
  console.log("=== Comprehensive Task Execution Diagnostic ===\n");
  let taskRunId: string | null = null;
  
  try {
    // Phase 1: Check database connectivity and schema
    console.log("Phase 1: Checking database connectivity and schema");
    
    try {
      const tablesResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
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
      
      if (tablesResponse.ok) {
        const tablesResult = await tablesResponse.json();
        console.log("✅ Database connection successful");
        
        // Check for required tables
        const tables = tablesResult.data || [];
        const requiredTables = ["task_runs", "stack_runs", "task_functions"];
        
        for (const table of requiredTables) {
          if (tables.some((t: any) => t.table_name === table)) {
            console.log(`✅ Table found: ${table}`);
          } else {
            console.log(`❌ Missing required table: ${table}`);
          }
        }
      } else {
        console.error(`❌ Database connection failed: ${tablesResponse.status}`);
      }
    } catch (error) {
      console.error("Database check error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 2: Check stack processor and triggers
    console.log("\nPhase 2: Testing stack processor functionality");
    
    try {
      // Test stack processor ping
      const pingResponse = await fetch(`${API_BASE}/stack-processor`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({ action: "ping" }),
        signal: AbortSignal.timeout(5000)
      });
      
      if (pingResponse.ok) {
        const pingResult = await pingResponse.json();
        console.log("✅ Stack processor responds to ping:", pingResult);
      } else {
        console.log(`❌ Stack processor ping failed: ${pingResponse.status}`);
      }
      
      // Test trigger by inserting a test record
      const testId = crypto.randomUUID();
      console.log(`Testing database trigger with test ID: ${testId}`);
      
      const insertResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({
          chain: [
            { type: "call", property: "from", args: ["stack_runs"] },
            { type: "call", property: "insert", args: [{
              id: testId,
              service_name: "test_service",
              method_name: "echo",
              args: ["trigger_test"],
              status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }] }
          ]
        })
      });
      
      if (insertResponse.ok) {
        console.log("✅ Test record inserted successfully");
        
        // Wait a moment for trigger to process
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if record was processed
        const checkResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            'apikey': ANON_KEY
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
            console.log(`Record status: ${record.status}`);
            
            if (record.status !== "pending") {
              console.log("✅ Trigger appears to be working - status changed from 'pending'");
            } else {
              console.log("❌ Trigger may not be working - status still 'pending'");
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
    } catch (error) {
      console.error("Stack processor check error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 3: Execute a task and track its lifecycle
    console.log("\nPhase 3: Testing full task execution lifecycle");
    
    try {
      console.log(`Executing ${TASK_NAME} task with testType=${TEST_TYPE}...`);
      
      const taskResponse = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({
          task: TASK_NAME,
          input: { 
            verbose: true,
            testType: TEST_TYPE
          }
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (taskResponse.ok) {
        const taskResult = await taskResponse.json();
        console.log("✅ Task submission successful");
        console.log(`Task run ID: ${taskResult.task_run_id || 'Unknown'}`);
        console.log(`Initial status: ${taskResult.status || 'Unknown'}`);
        
        if (taskResult.task_run_id) {
          taskRunId = taskResult.task_run_id;
          
          // Wait briefly then check task_runs table directly
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          const taskRunResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              'apikey': ANON_KEY
            },
            body: JSON.stringify({
              chain: [
                { type: "call", property: "from", args: ["task_runs"] },
                { type: "call", property: "select", args: ["*"] },
                { type: "call", property: "eq", args: ["id", taskRunId] }
              ]
            })
          });
          
          if (taskRunResponse.ok) {
            const taskRunResult = await taskRunResponse.json();
            if (taskRunResult.data && taskRunResult.data.length > 0) {
              const taskRun = taskRunResult.data[0];
              console.log(`Task run record found with status: ${taskRun.status}`);
              
              // Check for related stack runs
              const stackRunsResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
                method: "POST",
                headers: { 
                  "Content-Type": "application/json",
                  'apikey': ANON_KEY
                },
                body: JSON.stringify({
                  chain: [
                    { type: "call", property: "from", args: ["stack_runs"] },
                    { type: "call", property: "select", args: ["*"] },
                    { type: "call", property: "eq", args: ["parent_run_id", taskRunId] }
                  ]
                })
              });
              
              if (stackRunsResponse.ok) {
                const stackRunsResult = await stackRunsResponse.json();
                if (stackRunsResult.data && stackRunsResult.data.length > 0) {
                  console.log(`Found ${stackRunsResult.data.length} related stack run records`);
                  console.log("Stack runs statuses:");
                  stackRunsResult.data.forEach((run: any, i: number) => {
                    console.log(`  ${i+1}. ID: ${run.id}, Status: ${run.status}`);
                  });
                } else {
                  console.log("No related stack run records found");
                }
              } else {
                console.log(`Failed to check related stack runs: ${stackRunsResponse.status}`);
              }
            } else {
              console.log("No task run record found in database");
            }
          } else {
            console.log(`Failed to check task run: ${taskRunResponse.status}`);
          }
          
          // Check API endpoint for status
          console.log("\nChecking task status via API endpoint...");
          const resultResponse = await fetch(`${API_BASE}/tasks/result/${taskRunId}`, {
            method: "GET",
            headers: { 
              'apikey': ANON_KEY
            }
          });
          
          if (resultResponse.ok) {
            const resultData = await resultResponse.json();
            console.log(`API Status: ${resultData.status || 'Unknown'}`);
            console.log("Full API Response:", JSON.stringify(resultData, null, 2));
          } else {
            console.log(`API Status check failed: ${resultResponse.status}`);
          }
        }
      } else {
        console.log(`❌ Task submission failed: ${taskResponse.status}`);
        const errorText = await taskResponse.text();
        console.log('Error:', errorText);
      }
    } catch (error) {
      console.error("Task execution error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 4: Diagnostic Summary
    console.log("\nPhase 4: Diagnostic Summary");
    
    if (taskRunId) {
      console.log(`\nTo check the final result later, run:`);
      console.log(`deno run -A check-task-run.ts ${taskRunId}`);
    }
    
    console.log("\nPossible issues to investigate:");
    console.log("1. Database trigger for stack_runs table may not be active");
    console.log("2. Stack processor may not be picking up pending records");
    console.log("3. VM state may not be properly saved/restored");
    console.log("4. QuickJS promise handling or async logic may be incomplete");
    
    console.log("\nRecommended fixes:");
    console.log("1. Verify trigger SQL in database");
    console.log("2. Check stack processor logs for errors");
    console.log("3. Test VM state serialization separately");
    console.log("4. Review QuickJS implementation for promise handling issues");
    
  } catch (error) {
    console.error("Diagnostic error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the diagnostic immediately
runComprehensiveDiagnostic(); 