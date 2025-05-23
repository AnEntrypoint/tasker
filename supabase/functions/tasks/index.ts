import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve, ConnInfo } from "https://deno.land/std@0.201.0/http/server.ts";
import { corsHeaders } from "../quickjs/cors.ts";
import { executeTask } from "./handlers/task-executor.ts";
import { jsonResponse, formatTaskResult, formatLogMessage } from "./utils/response-formatter.ts";
import { TaskRegistry } from "./registry/task-registry.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateSchema, formatSchema } from './services/schema-generator.ts';
import { parseJSDocComments } from './utils/jsdoc-parser.ts';
import { GeneratedSchema } from "./types/index.ts";
import { executeMethodChain } from "npm:sdk-http-wrapper@1.0.10/server";
import { hostLog, simpleStringify } from '../_shared/utils.ts'; // Assuming utils are in _shared
import { fetchTaskFromDatabase } from "./services/database.ts";

config({ export: true });

declare global {
  var __updatedFields: Record<string, any>;
}

// Initialize task registries
const basicTaskRegistry = new TaskRegistry();
const specialTaskRegistry = new TaskRegistry();

// Environment setup
const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL') || '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';

// If the URL is the edge functions URL, use the REST API URL instead for local dev
const SUPABASE_URL = extSupabaseUrl.includes('127.0.0.1:8000') 
    ? 'http://localhost:54321' 
    : extSupabaseUrl || (supabaseUrl.includes('127.0.0.1:8000') ? 'http://localhost:54321' : supabaseUrl);

const SUPABASE_ANON_KEY = Deno.env.get('EXT_SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
console.log(`[INFO] SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`[INFO] SERVICE_ROLE_KEY (masked): ${SERVICE_ROLE_KEY ? '*'.repeat(10) : 'MISSING'}`);
console.log(`[INFO] Environment variables:`, Deno.env.toObject());
const supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
});

// --- Define the Tasks Service for SDK Wrapper ---
const tasksService = {
  execute: async (taskIdentifier: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}) => {
    //console.log(`[INFO][SDK Service] Received task execution request for: ${taskIdentifier}`);
    const logs: string[] = [formatLogMessage('INFO', `[SDK Service] Executing task: ${taskIdentifier}`)];
    try {
      // Check registry first (same logic as direct execution)
      if (specialTaskRegistry.hasTask(taskIdentifier) || basicTaskRegistry.hasTask(taskIdentifier)) {
        logs.push(formatLogMessage('INFO', `[SDK Service] Executing registered task: ${taskIdentifier}`));
        let result;
        if (specialTaskRegistry.hasTask(taskIdentifier)) {
          result = await specialTaskRegistry.executeTask(taskIdentifier, input, logs);
        } else {
          result = await basicTaskRegistry.executeTask(taskIdentifier, input, logs);
        }
        // The SDK wrapper expects the raw result, not a formatted Response
        return { success: true, data: result, logs };
      } else {
        // Execute from database via executeTask
        logs.push(formatLogMessage('INFO', `[SDK Service] Executing task from database: ${taskIdentifier}`));
        const response = await executeTask(taskIdentifier, input, options);
        const result = await response.json(); // executeTask returns a Response
        // Extract data and logs from the formatted response
        return { success: result.success, data: result.result, error: result.error, logs: result.logs };
      }
    } catch (error) {
      const errorMsg = `[SDK Service] Error executing task ${taskIdentifier}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[ERROR] ${errorMsg}`);
      logs.push(formatLogMessage('ERROR', errorMsg));
      // Throw the error so executeMethodChain can format it
      throw new Error(errorMsg);
    }
  }
};
// ---------------------------------------------

// Initialize global state
if (!globalThis.__updatedFields) globalThis.__updatedFields = {};

function createResponse(data: any, logs: string[] = [], status = 200): Response {
  return jsonResponse(formatTaskResult(true, data, undefined, logs), status);
}

function createErrorResponse(errorMessage: string, logs: string[] = [], status = 500): Response {
  return jsonResponse(formatTaskResult(false, undefined, errorMessage, logs), status);
}

function createCorsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const LOG_PREFIX_BASE = "[TasksHandlerEF]"; // Tasks Handler Edge Function

async function tasksHandler(req: Request): Promise<Response> {
    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: CORS_HEADERS });
    }

    let supabaseClient: SupabaseClient;
    try {
        if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
            hostLog(LOG_PREFIX_BASE, 'error', "Supabase URL or Service Role Key is not configured in environment variables.");
            throw new Error("Supabase environment variables for service role not set.");
        }
        // Initialize Supabase client with service role key for administrative tasks
        supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
            // No need to pass auth headers explicitly when using service_role_key server-side
            auth: { persistSession: false }
        });
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Supabase client (service role) initialization failed:", error.message);
        return new Response(simpleStringify({ error: "Server configuration error.", details: error.message }), {
            status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    let requestBody;
    try {
        requestBody = await req.json();
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Invalid JSON request body:", error.message);
        return new Response(simpleStringify({ error: "Invalid JSON request body.", details: error.message }), {
            status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    const { taskName, input } = requestBody;
    const logPrefix = `${LOG_PREFIX_BASE} [TaskName: ${taskName || 'N/A'}]`;

    if (!taskName || typeof taskName !== 'string') {
        hostLog(logPrefix, 'error', "'taskName' is required in the request body and must be a string.");
        return new Response(simpleStringify({ error: "'taskName' is required and must be a string." }), {
            status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    try {
        // Step 1: Fetch Task Definition from task_functions table
        hostLog(logPrefix, 'info', `Attempting to fetch definition for task: '${taskName}'`);
        
        // Use fetchTaskFromDatabase which now has direct HTTP fetch as a fallback
        const taskFunction = await fetchTaskFromDatabase(undefined, taskName);

        if (!taskFunction) {
            hostLog(logPrefix, 'warn', `Task definition not found for '${taskName}'.`);
            return new Response(simpleStringify({ error: `Task '${taskName}' not found.` }), {
                status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }
        hostLog(logPrefix, 'info', `Task definition '${taskFunction.name}' (ID: ${taskFunction.id}) found.`);

        // Step 2: Create a task_runs record to track the overall user request
        hostLog(logPrefix, 'info', `Creating task_run record with input:`, input || '(no input)');
        
        // Use direct fetch method for creating task_run record
        const baseUrl = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
        const serviceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                             Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                         
        if (!serviceRoleKey) {
            throw new Error("Service role key not available for direct insert");
        }
        
        const taskRunData = {
            task_function_id: taskFunction.id,
            task_name: taskFunction.name,
            input: input || null,
            status: 'queued'
        };
        
        const url = `${baseUrl}/rest/v1/task_runs`;
        
        const insertResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(taskRunData)
        });
        
        if (!insertResponse.ok) {
            const errorText = await insertResponse.text();
            hostLog(logPrefix, 'error', `Failed to create task_run record in database: HTTP ${insertResponse.status} ${insertResponse.statusText}`, errorText);
            throw new Error(`Database error: Failed to initiate task run. HTTP ${insertResponse.status} ${insertResponse.statusText}`);
        }
        
        const taskRunResult = await insertResponse.json();
        const taskRunId = Array.isArray(taskRunResult) && taskRunResult.length > 0 ? taskRunResult[0].id : null;
        
        if (!taskRunId) {
            hostLog(logPrefix, 'error', "Failed to obtain task_run ID after insertion");
            throw new Error("Database error: Failed to obtain task run ID after insertion");
        }
        
        hostLog(logPrefix, 'info', `Task_run record created successfully: ${taskRunId}`);

        // Step 3: Create the initial stack_runs record to kick off the execution
        hostLog(logPrefix, 'info', `Creating initial stack_run for task_run ${taskRunId}`);
        
        // Use direct fetch for creating stack_run record
        const stackRunData = {
            parent_task_run_id: taskRunId,
            service_name: 'tasks',
            method_name: 'execute',
            args: [taskFunction.name, input || null],
            status: 'pending',
            vm_state: {
                taskCode: taskFunction.code,
                taskName: taskFunction.name,
                taskInput: input || null
            }
        };
        
        const stackRunsUrl = `${baseUrl}/rest/v1/stack_runs`;
        
        const stackRunResponse = await fetch(stackRunsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(stackRunData)
        });
        
        if (!stackRunResponse.ok) {
            const errorText = await stackRunResponse.text();
            hostLog(logPrefix, 'error', `Failed to create initial stack_run record in database: HTTP ${stackRunResponse.status} ${stackRunResponse.statusText}`, errorText);
            
            // Attempt to mark the parent task_run as failed to avoid orphaned task_runs
            try {
                const updateTaskRunUrl = `${baseUrl}/rest/v1/task_runs?id=eq.${encodeURIComponent(taskRunId)}`;
                await fetch(updateTaskRunUrl, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${serviceRoleKey}`,
                        'apikey': serviceRoleKey
                    },
                    body: JSON.stringify({
                        status: 'failed',
                        error: { 
                            message: "System error: Failed to create initial stack_run for task execution.", 
                            details: `HTTP ${stackRunResponse.status} ${stackRunResponse.statusText}`
                        },
                        ended_at: new Date().toISOString()
                    })
                });
            } catch (updateErr) {
                hostLog(logPrefix, 'error', "Additionally failed to mark task_run as failed:", updateErr);
            }
            
            throw new Error(`Database error: Failed to create initial stack run. HTTP ${stackRunResponse.status} ${stackRunResponse.statusText}`);
        }
        
        const stackRunResult = await stackRunResponse.json();
        const stackRunId = Array.isArray(stackRunResult) && stackRunResult.length > 0 ? stackRunResult[0].id : null;
        
        if (!stackRunId) {
            hostLog(logPrefix, 'error', "Failed to obtain stack_run ID after insertion");
            throw new Error("Database error: Failed to obtain stack run ID after insertion");
        }
        
        hostLog(logPrefix, 'info', `Initial stack_run ${stackRunId} created. Task '${taskName}' (run ID: ${taskRunId}) has been successfully offloaded.`);

        // Step 4: Immediately trigger stack processor to avoid relying on database triggers
        try {
            hostLog(logPrefix, 'info', `Directly triggering stack processor for task run ${taskRunId}`);
            const stackProcessorUrl = `${baseUrl}/functions/v1/stack-processor`;
            
            const processorResponse = await fetch(stackProcessorUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${serviceRoleKey}`
                },
                body: JSON.stringify({
                    stackRunId: stackRunId
                })
            });
            
            if (!processorResponse.ok) {
                const errorText = await processorResponse.text();
                hostLog(logPrefix, 'warn', `Failed to trigger stack processor (will continue asynchronously): HTTP ${processorResponse.status}`, errorText);
                // Continue even if direct processing fails (it will be picked up by cron)
            } else {
                hostLog(logPrefix, 'info', `Stack processor triggered successfully for task run ${taskRunId}`);
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            hostLog(logPrefix, 'warn', `Error triggering stack processor (will continue asynchronously):`, error.message);
            // Continue even if direct processing fails (it will be picked up by cron)
        }

        // Step 5: Respond to the user indicating the task has been accepted
        return new Response(simpleStringify({
            message: "Task accepted and queued for asynchronous processing.",
            taskRunId: taskRunId
        }), {
            status: 202, // HTTP 202 Accepted: Request accepted, processing not complete
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(logPrefix, 'error', "Unhandled error in /tasks endpoint handler:", error.message, error.stack);
        // Avoid exposing detailed internal errors to the client unless necessary
        return new Response(simpleStringify({ error: "An unexpected server error occurred while processing the task request." }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
}

// New handler for getting task status
async function statusHandler(req: Request): Promise<Response> {
    // Extract taskRunId from query params in URL for GET requests
    const url = new URL(req.url);
    const taskRunId = url.searchParams.get('id');
    
    const logPrefix = `[tasks/status/${taskRunId}]`;
    
    hostLog(logPrefix, 'info', `Received status request for task run ID: ${taskRunId}`);
    
    if (!taskRunId) {
        return new Response(
            simpleStringify({ error: 'Missing taskRunId parameter' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
    
    try {
        // Determine the correct baseUrl for database access
        const extSupabaseUrl = Deno.env.get("EXT_SUPABASE_URL") || "";
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://kong:8000";
        
        // Use Kong URL for local development or when EXT_SUPABASE_URL is missing
        const useKong = extSupabaseUrl.includes('localhost') || 
                       extSupabaseUrl.includes('127.0.0.1') || 
                       !extSupabaseUrl;
                       
        const baseUrl = useKong 
            ? 'http://kong:8000/rest/v1' 
            : `${SUPABASE_URL}/rest/v1`;
        
        // Fetch task run from database
        const dbUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}&select=*`;
        hostLog(logPrefix, 'info', `Attempting to fetch task run from: ${dbUrl}`);
        
        const response = await fetch(dbUrl, {
            headers: {
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                'apikey': SERVICE_ROLE_KEY
            }
        });
        
        if (!response.ok) {
            const error = await response.text();
            const errorMessage = `Database query failed: ${error}`;
            hostLog(logPrefix, 'error', errorMessage);
            return new Response(
                simpleStringify({ error: `Failed to fetch task status: ${errorMessage}` }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const tasks = await response.json();
        hostLog(logPrefix, 'info', `Database query successful. Found ${tasks.length} records.`);
        
        if (tasks.length === 0) {
            return new Response(
                simpleStringify({ error: `Task run with ID ${taskRunId} not found` }),
                { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const taskRun = tasks[0];
        
        // Check if task has been stuck in 'queued' or 'processing' state
        if ((taskRun.status === 'queued' || taskRun.status === 'processing') && taskRun.created_at) {
            const createdAt = new Date(taskRun.created_at);
            const now = new Date();
            const diffInSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);
            
            // Even for recent tasks, do a quick check for completed results
            hostLog(logPrefix, 'info', `Task is in ${taskRun.status} state for ${diffInSeconds} seconds, checking if there's a completed stack run`);
            
            // First try: Get the stack run associated with this task
            try {
                // Use parent_task_run_id field
                const stackRunUrl = `${baseUrl}/stack_runs?select=*&parent_task_run_id=eq.${taskRunId}&status=eq.completed&order=created_at.desc&limit=1`;
                const stackRunResponse = await fetch(stackRunUrl, {
                    headers: {
                        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (stackRunResponse.ok) {
                    const stackRuns = await stackRunResponse.json();
                    
                    if (stackRuns && stackRuns.length > 0) {
                        const completedStackRun = stackRuns[0];
                        hostLog(logPrefix, 'warn', `Found completed stack run ${completedStackRun.id} with result, updating task run status`);
                        
                        // Update the task run to completed with the result from the stack run
                        const updateUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}`;
                        const updateResponse = await fetch(updateUrl, {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                'apikey': SERVICE_ROLE_KEY,
                                'Content-Type': 'application/json',
                                'Prefer': 'return=minimal'
                            },
                            body: JSON.stringify({
                                status: 'completed',
                                result: completedStackRun.result,
                                updated_at: new Date().toISOString(),
                                ended_at: new Date().toISOString()
                            })
                        });
                        
                        if (!updateResponse.ok) {
                            const updateError = await updateResponse.text();
                            hostLog(logPrefix, 'error', `Failed to update task run status: ${updateError}`);
                        } else {
                            hostLog(logPrefix, 'info', `Successfully updated task run ${taskRunId} to completed status`);
                            
                            // Update the taskRun object with the new status and result
                            taskRun.status = 'completed';
                            taskRun.result = completedStackRun.result;
                            taskRun.updated_at = new Date().toISOString();
                            taskRun.ended_at = new Date().toISOString();
                        }
                    } else {
                        // Try a different query using parent_task_run_id field (handles legacy/compatibility)
                        try {
                            const altStackRunUrl = `${baseUrl}/stack_runs?select=*&parent_task_run_id=eq.${taskRunId}&status=eq.completed&order=created_at.desc&limit=1`;
                            const altStackRunResponse = await fetch(altStackRunUrl, {
                                headers: {
                                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                    'apikey': SERVICE_ROLE_KEY
                                }
                            });
                            
                            if (altStackRunResponse.ok) {
                                const altStackRuns = await altStackRunResponse.json();
                                
                                if (altStackRuns && altStackRuns.length > 0) {
                                    const completedStackRun = altStackRuns[0];
                                    hostLog(logPrefix, 'warn', `Found completed stack run ${completedStackRun.id} with result (via parent_task_run_id), updating task run status`);
                                    
                                    // Update the task run to completed with the result from the stack run
                                    const updateUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}`;
                                    const updateResponse = await fetch(updateUrl, {
                                        method: 'PATCH',
                                        headers: {
                                            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                            'apikey': SERVICE_ROLE_KEY,
                                            'Content-Type': 'application/json',
                                            'Prefer': 'return=minimal'
                                        },
                                        body: JSON.stringify({
                                            status: 'completed',
                                            result: completedStackRun.result,
                                            updated_at: new Date().toISOString(),
                                            ended_at: new Date().toISOString()
                                        })
                                    });
                                    
                                    if (updateResponse.ok) {
                                        hostLog(logPrefix, 'info', `Successfully updated task run ${taskRunId} to completed status (via parent_task_run_id)`);
                                        
                                        // Update the taskRun object
                                        taskRun.status = 'completed';
                                        taskRun.result = completedStackRun.result;
                                        taskRun.updated_at = new Date().toISOString();
                                        taskRun.ended_at = new Date().toISOString();
                                    }
                                } else {
                                    hostLog(logPrefix, 'info', `No completed stack run found for task run ${taskRunId} with either query method`);
                                    
                                    // For long-running tasks, check if we need a manual cleanup
                                    if (diffInSeconds > 60) {
                                        hostLog(logPrefix, 'warn', `Task has been stuck in ${taskRun.status} state for over 60 seconds, performing manual check`);
                                        
                                        // Fallback: Try to find any stack run related to this task
                                        try {
                                            if (taskRun.waiting_on_stack_run_id) {
                                                // If we have a waiting_on_stack_run_id, just wait for that to complete
                                                hostLog(logPrefix, 'info', `Task is waiting on stack run ${taskRun.waiting_on_stack_run_id}, no manual intervention needed`);
                                                // Continue with normal status return
                                            }
                                            
                                            const allStackRunsUrl = `${baseUrl}/stack_runs?select=*&or=(parent_task_run_id.eq.${taskRunId})&order=created_at.desc&limit=1`;
                                            
                                            hostLog(logPrefix, 'info', `Checking for any stack runs: ${allStackRunsUrl}`);
                                            
                                            const allStackRunsResponse = await fetch(allStackRunsUrl, {
                                                headers: {
                                                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                                    'Content-Type': 'application/json'
                                                }
                                            });
                                            
                                            if (allStackRunsResponse.ok) {
                                                const allStackRuns = await allStackRunsResponse.json();
                                                
                                                if (allStackRuns && allStackRuns.length > 0) {
                                                    const latestStackRun = allStackRuns[0];
                                                    hostLog(logPrefix, 'warn', `Found stack run ${latestStackRun.id} with status ${latestStackRun.status}, but no completed result`);
                                                    
                                                    // If task has been running too long, mark as error
                                                    if (diffInSeconds > 120) {
                                                        const updateUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}`;
                                                        await fetch(updateUrl, {
                                                            method: 'PATCH',
                                                            headers: {
                                                                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                                                'apikey': SERVICE_ROLE_KEY,
                                                                'Content-Type': 'application/json',
                                                                'Prefer': 'return=minimal'
                                                            },
                                                            body: JSON.stringify({
                                                                status: 'error',
                                                                error: { message: 'Task execution timed out after 120 seconds' },
                                                                updated_at: new Date().toISOString(),
                                                                ended_at: new Date().toISOString()
                                                            })
                                                        });
                                                        
                                                        taskRun.status = 'error';
                                                        taskRun.error = { message: 'Task execution timed out after 120 seconds' };
                                                        taskRun.updated_at = new Date().toISOString();
                                                        taskRun.ended_at = new Date().toISOString();
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            hostLog(logPrefix, 'error', `Error checking for completed stack runs: ${e instanceof Error ? e.message : String(e)}`);
                                        }
                                    }
                                }
                            }
                        } catch (altError) {
                            hostLog(logPrefix, 'error', `Error checking alternative stack runs query: ${altError instanceof Error ? altError.message : String(altError)}`);
                        }
                    }
                } else {
                    const stackRunError = await stackRunResponse.text();
                    hostLog(logPrefix, 'error', `Failed to check for completed stack runs: ${stackRunError}`);
                }
            } catch (e) {
                hostLog(logPrefix, 'error', `Error checking for completed stack runs: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        
        hostLog(logPrefix, 'info', `Returning task run with status: ${taskRun.status}`);
        
        // Extra handling for error states to make debugging easier
        if (taskRun.status === 'error') {
            hostLog(logPrefix, 'warn', `Task in error state. Error details: ${JSON.stringify(taskRun.error || 'No error details available')}`);
        }
        
        return new Response(
            simpleStringify(taskRun),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(logPrefix, 'error', `Exception in statusHandler: ${errorMessage}`);
        return new Response(
            simpleStringify({ error: `Internal server error: ${errorMessage}` }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
}

// Helper function to handle task logs requests
async function logsHandler(req: Request): Promise<Response> {
    // Extract taskRunId from query params in URL for GET requests
    const url = new URL(req.url);
    const taskRunId = url.searchParams.get('id');
    
    const logPrefix = `[tasks/logs/${taskRunId}]`;
    
    hostLog(logPrefix, 'info', `Received logs request for task run ID: ${taskRunId}`);
    
    if (!taskRunId) {
        return new Response(
            simpleStringify({ error: 'Missing taskRunId parameter' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
    
    try {
        // Determine the correct baseUrl for database access
        const extSupabaseUrl = Deno.env.get("EXT_SUPABASE_URL") || "";
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://kong:8000";
        
        // Use Kong URL for local development or when EXT_SUPABASE_URL is missing
        const useKong = extSupabaseUrl.includes('localhost') || 
                       extSupabaseUrl.includes('127.0.0.1') || 
                       !extSupabaseUrl;
                       
        const baseUrl = useKong 
            ? 'http://kong:8000/rest/v1' 
            : `${SUPABASE_URL}/rest/v1`;
        
        // Fetch task run from database
        const dbUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}&select=*`;
        hostLog(logPrefix, 'info', `Attempting to fetch task run from: ${dbUrl}`);
        
        const response = await fetch(dbUrl, {
            headers: {
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                'apikey': SERVICE_ROLE_KEY
            }
        });
        
        if (!response.ok) {
            const error = await response.text();
            const errorMessage = `Database query failed: ${error}`;
            hostLog(logPrefix, 'error', errorMessage);
            return new Response(
                simpleStringify({ error: `Failed to fetch task logs: ${errorMessage}` }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const tasks = await response.json();
        hostLog(logPrefix, 'info', `Database query successful. Found ${tasks.length} records.`);
        
        if (tasks.length === 0) {
            return new Response(
                simpleStringify({ error: `Task run with ID ${taskRunId} not found` }),
                { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const taskRun = tasks[0];
        
        // Check for long-running tasks or special cases
        if (taskRun.status === 'queued' || taskRun.status === 'processing') {
            const createdAt = new Date(taskRun.created_at);
            const now = new Date();
            const diffInSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);
            
            // For long-running tasks, check if waiting on something
            if (diffInSeconds > 60 && taskRun.waiting_on_stack_run_id) {
                hostLog(logPrefix, 'warn', `Task has been running for ${diffInSeconds}s and is waiting on stack run ${taskRun.waiting_on_stack_run_id}`);
                // Continue processing to return available logs
            }
        }
        
        // Get logs from the task run
        const logs = taskRun.logs || [];
        
        // Also check for vm_logs
        const vmLogs = taskRun.vm_logs || [];
        
        return new Response(
            simpleStringify({ 
                logs,
                vm_logs: vmLogs
            }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(logPrefix, 'error', `Exception in logsHandler: ${errorMessage}`);
        return new Response(
            simpleStringify({ error: `Internal server error: ${errorMessage}` }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
}

// Start the Deno server and pass the tasksHandler for incoming requests
serve(async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname.split("/").filter(Boolean); // Remove empty segments
    
    // Log request
    hostLog(LOG_PREFIX_BASE, 'info', `Received request: ${req.method} ${url.pathname}`);
    
    try {
        // Routes handler
        if (path.length >= 2 && path[0] === "tasks") {
            if (path[1] === "execute") {
                // Execute a task: POST /tasks/execute
                return tasksHandler(req);
            } else if (path[1] === "status") {
                // Get task status: GET /tasks/status?id=xyz
                return statusHandler(req);
            } else if (path[1] === "logs") {
                // Get task logs: GET /tasks/logs?id=xyz
                return logsHandler(req);
            } else {
                // Default route for backward compatibility
                return tasksHandler(req);
            }
        }
        
        // Handle root request or unknown paths
        return new Response(simpleStringify({
            service: "Tasker Edge Function",
            version: "1.0.0",
            status: "running",
            endpoints: [
                "/tasks/execute [POST] - Execute a task",
                "/tasks/status [GET] - Get task status",
                "/tasks/logs [GET] - Get task logs"
            ]
        }), {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Unhandled error in request handler:", error.message);
        return new Response(simpleStringify({ 
            error: "Internal server error", 
            message: error.message 
        }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});