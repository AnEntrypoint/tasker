/**
 * VM State Serialization Diagnostic
 * 
 * This tool specifically tests the save/restore functionality
 * for the QuickJS VM state to help identify issues with 
 * VM state serialization and restoration.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

// Configuration
const API_BASE = "http://127.0.0.1:8000/functions/v1";
const ANON_KEY = env.SUPABASE_ANON_KEY || 'your-anon-key';
const TASK_NAME = "test-save-sleep-resume";  // This task is designed to test VM state

async function diagnoseVMState() {
  console.log("=== VM State Serialization Diagnostic ===\n");
  let taskRunId: string | null = null;
  
  try {
    // Phase 1: Check for test task availability
    console.log("Phase 1: Checking task availability");
    
    try {
      const taskResponse = await fetch(`${API_BASE}/tasks/list`, {
        method: "GET",
        headers: { 'apikey': ANON_KEY }
      });
      
      if (taskResponse.ok) {
        const taskList = await taskResponse.json();
        const foundTask = taskList.tasks?.some((t: any) => t.name === TASK_NAME);
        
        if (foundTask) {
          console.log(`✅ Test task '${TASK_NAME}' is available`);
        } else {
          console.log(`❌ Test task '${TASK_NAME}' not found`);
          console.log("You need to publish this task using: deno run -A taskcode/publish.ts --specific test-save-sleep-resume");
          return;
        }
      } else {
        console.error(`Failed to check task list: ${taskResponse.status}`);
      }
    } catch (error) {
      console.error("Task check error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 2: Directly examine the VM state saving code
    console.log("\nPhase 2: Examining stack_runs table structure");
    
    try {
      // Check stack_runs table structure
      const tableResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({
          chain: [
            { type: "call", property: "rpc", args: ["query", { 
              query: `
                SELECT column_name, data_type, character_maximum_length
                FROM information_schema.columns
                WHERE table_name = 'stack_runs'
                ORDER BY ordinal_position;
              `
            }] }
          ]
        })
      });
      
      if (tableResponse.ok) {
        const tableResult = await tableResponse.json();
        
        if (tableResult.data && tableResult.data.length > 0) {
          console.log("Stack runs table columns:");
          tableResult.data.forEach((col: any) => {
            console.log(`- ${col.column_name}: ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''}`);
          });
          
          // Check for VM state column
          const hasVmState = tableResult.data.some((col: any) => col.column_name === 'vm_state');
          if (hasVmState) {
            console.log("✅ The stack_runs table has a vm_state column for state storage");
          } else {
            console.log("❌ Missing vm_state column in stack_runs table");
          }
        } else {
          console.log("No columns found for stack_runs table");
        }
      } else {
        console.error(`Failed to check table structure: ${tableResponse.status}`);
      }
    } catch (error) {
      console.error("Table structure check error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 3: Execute the test task that uses VM state saving
    console.log("\nPhase 3: Running VM state save/restore test task");
    
    try {
      console.log(`Executing ${TASK_NAME} task...`);
      
      const execResponse = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': ANON_KEY
        },
        body: JSON.stringify({
          task: TASK_NAME,
          input: { 
            sleepMs: 100, // Very short sleep to avoid timeouts
            beforeSleepMessage: "Testing VM state before sleep",
            afterSleepMessage: "Testing VM state after restore"
          }
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (execResponse.ok) {
        const taskResult = await execResponse.json();
        console.log("✅ Task submission successful");
        console.log(`Task run ID: ${taskResult.task_run_id || 'Unknown'}`);
        console.log(`Initial status: ${taskResult.status || 'Unknown'}`);
        
        if (taskResult.task_run_id) {
          taskRunId = taskResult.task_run_id;
          
          // Wait briefly then check for VM state in stack_runs
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Check for stack run entries with VM state
          const stackRunsResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              'apikey': ANON_KEY
            },
            body: JSON.stringify({
              chain: [
                { type: "call", property: "from", args: ["stack_runs"] },
                { type: "call", property: "select", args: ["id", "service_name", "method_name", "status", "created_at", "updated_at"] },
                { type: "call", property: "eq", args: ["parent_run_id", taskRunId] }
              ]
            })
          });
          
          if (stackRunsResponse.ok) {
            const stackRunsResult = await stackRunsResponse.json();
            
            if (stackRunsResult.data && stackRunsResult.data.length > 0) {
              console.log(`Found ${stackRunsResult.data.length} stack runs for task`);
              stackRunsResult.data.forEach((run: any) => {
                console.log(`- ID: ${run.id}, Service: ${run.service_name}, Method: ${run.method_name}, Status: ${run.status}`);
                
                // If any are in "sleeping" status, VM state should exist
                if (run.status === "sleeping") {
                  console.log("  ✅ Found 'sleeping' status - VM state should be saved");
                }
              });
              
              // If we have stack runs, check one for VM state (without retrieving the full state which could be large)
              if (stackRunsResult.data.length > 0) {
                const sampleId = stackRunsResult.data[0].id;
                
                const vmStateCheckResponse = await fetch(`${API_BASE}/wrappedsupabase`, {
                  method: "POST",
                  headers: { 
                    "Content-Type": "application/json",
                    'apikey': ANON_KEY
                  },
                  body: JSON.stringify({
                    chain: [
                      { type: "call", property: "rpc", args: ["query", { 
                        query: `
                          SELECT 
                            id, 
                            status,
                            CASE WHEN vm_state IS NULL THEN false ELSE true END as has_vm_state,
                            pg_column_size(vm_state) as vm_state_size
                          FROM stack_runs
                          WHERE id = '${sampleId}';
                        `
                      }] }
                    ]
                  })
                });
                
                if (vmStateCheckResponse.ok) {
                  const vmStateResult = await vmStateCheckResponse.json();
                  
                  if (vmStateResult.data && vmStateResult.data.length > 0) {
                    const stateInfo = vmStateResult.data[0];
                    console.log(`\nVM state check for ID ${stateInfo.id}:`);
                    console.log(`- Status: ${stateInfo.status}`);
                    console.log(`- Has VM state: ${stateInfo.has_vm_state}`);
                    
                    if (stateInfo.has_vm_state) {
                      console.log(`- VM state size: ${stateInfo.vm_state_size} bytes`);
                      
                      if (stateInfo.vm_state_size > 0) {
                        console.log("✅ VM state is being saved properly");
                      } else {
                        console.log("❌ VM state is being saved but appears to be empty");
                      }
                    } else {
                      console.log("❌ VM state is not being saved");
                    }
                  }
                } else {
                  console.log(`Failed to check VM state: ${vmStateCheckResponse.status}`);
                }
              }
            } else {
              console.log("No stack runs found for this task");
              console.log("❌ VM state saving may not be occurring at all");
            }
          } else {
            console.log(`Failed to check stack runs: ${stackRunsResponse.status}`);
          }
          
          // Check final task status
          console.log("\nChecking final task status...");
          
          const resultResponse = await fetch(`${API_BASE}/tasks/result/${taskRunId}`, {
            method: "GET",
            headers: { 'apikey': ANON_KEY }
          });
          
          if (resultResponse.ok) {
            const resultData = await resultResponse.json();
            console.log(`Status: ${resultData.status}`);
            
            if (resultData.status === 'completed' && resultData.result) {
              console.log("✅ Task completed successfully");
              console.log("Result:", JSON.stringify(resultData.result, null, 2));
              
              // Look for specific indicators that state was restored
              if (resultData.result.afterSleep === "Testing VM state after restore") {
                console.log("✅ VM state was successfully restored - task continued after sleep");
              } else {
                console.log("❌ VM state restoration appears to have failed - missing expected output");
              }
            } else {
              console.log("❌ Task did not complete:", resultData.status);
              if (resultData.error) {
                console.log("Error:", resultData.error);
              }
            }
          } else {
            console.log(`Failed to get task result: ${resultResponse.status}`);
          }
        }
      } else {
        console.log(`❌ Task submission failed: ${execResponse.status}`);
        const errorText = await execResponse.text();
        console.log('Error:', errorText);
      }
    } catch (error) {
      console.error("Task execution error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 4: Check for QuickJS promise handling
    console.log("\nPhase 4: Checking for known QuickJS promise issues");
    
    try {
      // Look for relevant files in the codebase
      const quickJSFile = "supabase/functions/quickjs/index.ts";
      
      console.log(`\nChecking for async/promise handling issues...`);
      
      // Specific patterns to look for
      const asyncPatterns = [
        "JS_ExecutePendingJob",
        "executePendingJobs",
        "newAsyncContext",
        "ctx.resolvePromise",
        "asyncify"
      ];
      
      console.log("Key patterns for proper async handling:");
      asyncPatterns.forEach(pattern => {
        console.log(`- ${pattern}`);
      });
      
      console.log("\nConsider updating the QuickJS implementation to ensure:");
      console.log("1. Proper job processing loop with rt.executePendingJobs()");
      console.log("2. Correctly implemented newAsyncContext() for Asyncify support");
      console.log("3. Usage of ctx.resolvePromise() for promise settlement");
      console.log("4. VM proxy generator correctly handling promise returns");
    } catch (error) {
      console.error("QuickJS check error:", error instanceof Error ? error.message : String(error));
    }
    
    // Phase 5: Diagnostic Summary
    console.log("\nPhase 5: Diagnostic Summary");
    
    console.log("\nVM State Diagnostic Results:");
    console.log("1. Task execution - " + (taskRunId ? "✅ Initiated successfully" : "❌ Failed to initiate"));
    console.log("2. State Saving - Check if stack runs are created with 'sleeping' status");
    console.log("3. State Restoration - Check if tasks complete and continue after sleeping");
    
    console.log("\nPossible issues:");
    console.log("- QuickJS VM state serialization may be incomplete or corrupted");
    console.log("- Promise handling in QuickJS may not be properly implemented");
    console.log("- Stack processor may not be properly restoring VM state");
    console.log("- Database triggers may not be activating the stack processor");
    
    console.log("\nRecommended fixes:");
    console.log("1. Update the QuickJS implementation to properly handle promises");
    console.log("2. Ensure VM state serialization captures all necessary context");
    console.log("3. Verify that stack processor properly responds to database triggers");
    console.log("4. Implement better error handling in the VM state restoration process");
    
  } catch (error) {
    console.error("Diagnostic error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the diagnostic immediately
diagnoseVMState(); 