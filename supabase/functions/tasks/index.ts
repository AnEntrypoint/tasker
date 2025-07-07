// import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts"; // Removed dotenv
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve, ConnInfo } from "https://deno.land/std@0.201.0/http/server.ts";
import { corsHeaders } from "../quickjs/cors.ts";
// executeTask is not directly used by tasks/index.ts anymore for the main /tasks endpoint,
// as it now manages stack_runs and task_runs itself.
// import { executeTask } from "./handlers/task-executor.ts"; 
import { jsonResponse, formatTaskResult, formatLogMessage } from "./utils/response-formatter.ts";
import { TaskRegistry } from "./registry/task-registry.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
// import { generateSchema, formatSchema } from './services/schema-generator.ts'; // Not used in this file
// import { parseJSDocComments } from './utils/jsdoc-parser.ts'; // Not used in this file
// import { GeneratedSchema } from "./types/index.ts"; // Not used in this file
// import { executeMethodChain } from "npm:sdk-http-wrapper@1.0.10/server"; // Not used in this file
import { hostLog, simpleStringify } from '../_shared/utils.ts';
import { fetchTaskFromDatabase, supabaseClient as dbClient } from "./services/database.ts"; // Use the client from database.ts

// config({ export: true }); // Removed dotenv call

declare global {
  var __updatedFields: Record<string, any>;
}

// Initialize task registries
// const basicTaskRegistry = new TaskRegistry(); // Not used in this file's current logic
// const specialTaskRegistry = new TaskRegistry(); // Not used in this file's current logic

// --- Environment Setup ---
// Prioritize EXT_ prefixed variables from Supabase Edge Runtime for external URLs
const EXT_SUPABASE_URL = Deno.env.get('EXT_SUPABASE_URL') || 'http://127.0.0.1:8000'; // Default to local functions server

// For internal Supabase client connections (e.g., to REST API)
// Use the same URL as EXT_SUPABASE_URL for local development since they point to the same Supabase instance
let INTERNAL_SUPABASE_REST_URL = Deno.env.get('SUPABASE_URL') || EXT_SUPABASE_URL;

// Remove the faulty logic that sets to localhost:54321 (that's the Studio URL, not REST API)
console.warn(`[tasks/index.ts] INTERNAL_SUPABASE_REST_URL set to: ${INTERNAL_SUPABASE_REST_URL}`);

const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// ANON_KEY is not directly used for server-side operations in this file. fetchTaskFromDatabase handles its own key requirements.

if (!SERVICE_ROLE_KEY) {
    console.error("[tasks/index.ts] CRITICAL: Service role key (EXT_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY) is not configured.");
    // Depending on deployment, may want to throw here or let individual handlers fail.
}

console.log(`[tasks/index.ts] EXT_SUPABASE_URL: ${EXT_SUPABASE_URL}`);
console.log(`[tasks/index.ts] INTERNAL_SUPABASE_REST_URL: ${INTERNAL_SUPABASE_REST_URL}`);
console.log(`[tasks/index.ts] SERVICE_ROLE_KEY (masked): ${SERVICE_ROLE_KEY ? '*'.repeat(10) : 'MISSING'}`);
// console.log(`[INFO] Environment variables:`, Deno.env.toObject()); // Too verbose for regular logs

// Supabase client for administrative tasks within this edge function
// Uses INTERNAL_SUPABASE_REST_URL to connect directly to the DB services.
const adminSupabaseClient: SupabaseClient = createClient(INTERNAL_SUPABASE_REST_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false }
});


// --- Define the Tasks Service for SDK Wrapper ---
// This tasksService is meant to be callable via the QuickJS VM tools.execute('tasks.execute', ...)
// It should not rely on the complex direct fetch logic in tasksHandler, but rather use a simpler execution path.
// The original tasksService implementation was complex. Let's simplify.
// For now, this is a placeholder as the primary execution flow is through HTTP requests to /tasks/execute.
// If tools.execute('tasks.execute', ...) is a critical path, it needs robust implementation.
// Given the current setup where /tasks/execute offloads to stack_runs, tools.execute might also need to create a stack_run.

// const tasksService = { ... } // Placeholder: Original complex tasksService removed for clarity. 
//                            // If this is still needed for tools.execute in QJS, it needs careful reimplementation
//                            // to align with the ephemeral stack_run model.

// Initialize global state
if (!globalThis.__updatedFields) globalThis.__updatedFields = {};

// function createResponse(data: any, logs: string[] = [], status = 200): Response { // Not used
//   return jsonResponse(formatTaskResult(true, data, undefined, logs), status);
// }

// function createErrorResponse(errorMessage: string, logs: string[] = [], status = 500): Response { // Not used
//   return jsonResponse(formatTaskResult(false, undefined, errorMessage, logs), status);
// }

// function createCorsPreflightResponse(): Response { // Not used directly, handled in main serve
//   return new Response(null, { status: 204, headers: corsHeaders });
// }

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*', // Adjust for production
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer', // Added prefer
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PATCH', // Added GET, PATCH
};

const LOG_PREFIX_BASE = "[TasksEF]"; // Tasks Edge Function

async function tasksHandler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: CORS_HEADERS });
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
    const logPrefix = `${LOG_PREFIX_BASE} [Task: ${taskName || 'N/A'}]`;

    if (!taskName || typeof taskName !== 'string') {
        hostLog(logPrefix, 'error', "'taskName' is required and must be a string.");
        return new Response(simpleStringify({ error: "'taskName' is required and must be a string." }), {
            status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    try {
        hostLog(logPrefix, 'info', `Attempting to fetch definition for task: '${taskName}'`);
        const taskFunction = await fetchTaskFromDatabase(undefined, taskName); // Uses dbClient with service_role from database.ts

        if (!taskFunction || !taskFunction.id || !taskFunction.code) {
            hostLog(logPrefix, 'warn', `Task definition not found or incomplete for '${taskName}'.`);
            return new Response(simpleStringify({ error: `Task '${taskName}' not found or is invalid.` }), {
                status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }
        hostLog(logPrefix, 'info', `Task definition '${taskFunction.name}' (ID: ${taskFunction.id}) found.`);

        hostLog(logPrefix, 'info', `Creating task_run record for input:`, input || '(no input)');
        const { data: taskRunData, error: taskRunError } = await adminSupabaseClient
            .from('task_runs')
            .insert({
            task_function_id: taskFunction.id,
            task_name: taskFunction.name,
            input: input || null,
            status: 'queued'
            })
            .select('id')
            .single();

        if (taskRunError || !taskRunData) {
            hostLog(logPrefix, 'error', `Failed to create task_run record:`, taskRunError?.message || "No data returned");
            throw new Error(`Database error: Failed to initiate task run. ${taskRunError?.message}`);
        }
        const taskRunId = taskRunData.id;
        hostLog(logPrefix, 'info', `Task_run record created: ${taskRunId}`);

        hostLog(logPrefix, 'info', `Creating initial stack_run for task_run ${taskRunId}`);
        const { data: stackRunDataInsert, error: stackRunError } = await adminSupabaseClient
            .from('stack_runs')
            .insert({
            parent_task_run_id: taskRunId,
                service_name: 'tasks', // Or taskFunction.name if more specific
                method_name: 'execute', // Standard method for initial task execution
                args: [taskFunction.name, input || {}], // Ensure args are serializable
            status: 'pending',
                vm_state: { // Initial state for QuickJS
                    taskCode: taskFunction.code,
                    taskName: taskFunction.name,
                    taskInput: input || {},
                    // taskRunId: taskRunId, // Pass taskRunId to QJS for linking logs/state
                }
            })
            .select('id')
            .single();

        if (stackRunError || !stackRunDataInsert) {
            hostLog(logPrefix, 'error', `Failed to create initial stack_run record:`, stackRunError?.message || "No data returned");
            // Attempt to mark the parent task_run as failed
            try {
                await adminSupabaseClient
                    .from('task_runs')
                    .update({
                        status: 'failed',
                        error: { 
                            message: "System error: Failed to create initial stack_run for task execution.", 
                            details: stackRunError?.message || "Unknown stack_run insertion error"
                        },
                        ended_at: new Date().toISOString()
                    })
                    .eq('id', taskRunId);
            } catch (updateErr) {
                hostLog(logPrefix, 'error', "Additionally failed to mark task_run as failed:", updateErr);
            }
            throw new Error(`Database error: Failed to create initial stack run. ${stackRunError?.message}`);
        }
        const initialStackRunId = stackRunDataInsert.id;
        hostLog(logPrefix, 'info', `Initial stack_run ${initialStackRunId} created for task '${taskName}' (task_run ID: ${taskRunId}). Offloading for processing.`);
        
        // Asynchronously trigger stack processor (best effort, cron is fallback)
        const isLocalDev = EXT_SUPABASE_URL.includes('127.0.0.1') || EXT_SUPABASE_URL.includes('localhost');
        
        if (isLocalDev) {
            // For local development, use the same pattern as the stack processor does internally
            // Queue a direct call without HTTP to avoid networking issues
            setTimeout(async () => {
                hostLog(logPrefix, 'info', `Local dev: Processing stack_run ${initialStackRunId} directly`);
                try {
                    // For local development, use kong URL for edge-to-edge communication
                    const stackProcessorUrl = EXT_SUPABASE_URL.includes('127.0.0.1') || EXT_SUPABASE_URL.includes('localhost') 
                        ? 'http://kong:8000/functions/v1/stack-processor'
                        : `${EXT_SUPABASE_URL}/functions/v1/stack-processor`;
                    
                    hostLog(logPrefix, 'info', `Local dev: Using stack processor URL: ${stackProcessorUrl}`);
                    const response = await fetch(stackProcessorUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({})
                    });
                    
                    if (response.ok) {
                        const result = await response.text();
                        hostLog(logPrefix, 'info', `Local dev: Stack processor triggered: ${result}`);
                    } else {
                        hostLog(logPrefix, 'warn', `Local dev: Stack processor failed with status ${response.status}`);
                    }
                } catch (error) {
                    hostLog(logPrefix, 'error', `Local dev: Stack processor error: ${error instanceof Error ? error.message : String(error)}`);
                    hostLog(logPrefix, 'info', `Local dev: Stack run ${initialStackRunId} will be processed by next stack processor poll`);
                }
            }, 100); // Short delay just to let current request complete
        } else {
            // Production: use regular HTTP trigger with auth
            const stackProcessorUrl = `${EXT_SUPABASE_URL}/functions/v1/stack-processor`;
            fetch(stackProcessorUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
                },
                body: JSON.stringify({ stackRunId: initialStackRunId })
            }).then(async (res) => {
                if (!res.ok) {
                    hostLog(logPrefix, 'warn', `Stack processor trigger failed: ${res.status}`, await res.text());
                } else {
                    hostLog(logPrefix, 'info', `Stack processor triggered for stack_run ${initialStackRunId}.`);
                }
            }).catch(e => {
                hostLog(logPrefix, 'warn', `Error triggering stack processor:`, e.message);
            });
        }

        return new Response(simpleStringify({
            message: "Task accepted and queued for asynchronous processing.",
            taskRunId: taskRunId,
            initialStackRunId: initialStackRunId // Optionally return this for more direct tracking
        }), {
            status: 202, // HTTP 202 Accepted
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(logPrefix, 'error', "Unhandled error in /tasks endpoint handler:", error.message, error.stack);
        return new Response(simpleStringify({ error: "An unexpected server error occurred." }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
}

async function statusHandler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") { // Handle OPTIONS for GET requests too
        return new Response("ok", { headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const taskRunId = url.searchParams.get('id');
    const logPrefix = `${LOG_PREFIX_BASE} [Status/${taskRunId || 'N/A'}]`;
    
    if (!taskRunId) {
        return new Response(simpleStringify({ error: 'Missing taskRunId query parameter' }), {
            status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }
    
    try {
        hostLog(logPrefix, 'info', `Fetching status for task run ID: ${taskRunId}`);
        const { data: taskRun, error } = await adminSupabaseClient
            .from('task_runs')
            .select('*')
            .eq('id', taskRunId)
            .single();

        if (error) {
            hostLog(logPrefix, 'error', `Database query failed for task_run: ${error.message}`);
            if (error.code === 'PGRST116') { // Not found
                 return new Response(simpleStringify({ error: `Task run with ID ${taskRunId} not found` }), {
                    status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                });
            }
            return new Response(simpleStringify({ error: `Failed to fetch task status: ${error.message}` }), {
                status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        if (!taskRun) { // Should be covered by PGRST116, but as a safeguard
            return new Response(simpleStringify({ error: `Task run with ID ${taskRunId} not found` }), {
                status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }
        
        // Check for stuck tasks or attempt to update status from a completed stack_run
        // This logic can be complex; for now, we primarily return the current state.
        // A more robust solution might involve a separate "status updater" or refined logic in stack-processor.
        if ((taskRun.status === 'queued' || taskRun.status === 'processing') && taskRun.created_at) {
            const createdAt = new Date(taskRun.created_at);
            const now = new Date();
            const diffInSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);
            
            // If task seems stuck, we might try to find its latest stack_run
            if (diffInSeconds > 30) { // Example: 30 seconds
                 hostLog(logPrefix, 'info', `Task status is '${taskRun.status}' for ${diffInSeconds}s. Checking for completed stack runs.`);
                const { data: completedStackRun, error: stackRunError } = await adminSupabaseClient
                    .from('stack_runs')
                    .select('result, status, error')
                    .eq('parent_task_run_id', taskRunId)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle(); // Use maybeSingle to handle no rows gracefully

                if (stackRunError) {
                    hostLog(logPrefix, 'warn', `Could not query latest stack_run for task_run ${taskRunId}: ${stackRunError.message}`);
                } else if (completedStackRun) {
                    if (completedStackRun.status === 'completed' && taskRun.status !== 'completed') {
                        hostLog(logPrefix, 'info', `Found terminal stack_run in 'completed' state. Updating task_run ${taskRunId}.`);
                        const { error: updateError } = await adminSupabaseClient
                            .from('task_runs')
                            .update({ 
                                status: 'completed',
                                result: completedStackRun.result,
                                ended_at: new Date().toISOString(),
                                updated_at: new Date().toISOString(),
                             })
                            .eq('id', taskRunId);
                        if (updateError) {
                             hostLog(logPrefix, 'error', `Failed to update task_run ${taskRunId} from stack_run: ${updateError.message}`);
                        } else {
                            taskRun.status = 'completed'; // Reflect change in current response
                            taskRun.result = completedStackRun.result;
                        }
                    } else if (completedStackRun.status === 'failed' && taskRun.status !== 'failed' && taskRun.status !== 'error') {
                         hostLog(logPrefix, 'info', `Found terminal stack_run in 'failed' state. Updating task_run ${taskRunId}.`);
                        const { error: updateError } = await adminSupabaseClient
                            .from('task_runs')
                            .update({ 
                                status: 'error', // or 'failed' depending on desired task_run state
                                error: completedStackRun.error || { message: 'Derived from failed stack_run' },
                                ended_at: new Date().toISOString(),
                                            updated_at: new Date().toISOString(),
                            })
                            .eq('id', taskRunId);
                        if (updateError) {
                             hostLog(logPrefix, 'error', `Failed to update task_run ${taskRunId} from failed stack_run: ${updateError.message}`);
                                } else {
                            taskRun.status = 'error'; // Reflect change
                            taskRun.error = completedStackRun.error || { message: 'Derived from failed stack_run' };
                        }
                    }
                }
            }
        }


        hostLog(logPrefix, 'info', `Returning task_run status: ${taskRun.status}`);
        if (taskRun.status === 'error' || taskRun.status === 'failed') {
            hostLog(logPrefix, 'warn', `Task in error/failed state. Details: ${simpleStringify(taskRun.error || 'No error details')}`);
        }

        return new Response(simpleStringify(taskRun), {
            status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(logPrefix, 'error', `Exception in statusHandler: ${errorMessage}`);
        return new Response(simpleStringify({ error: `Internal server error: ${errorMessage}` }), {
            status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }
}

async function logsHandler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") { // Handle OPTIONS for GET requests too
        return new Response("ok", { headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const taskRunId = url.searchParams.get('id');
    const logPrefix = `${LOG_PREFIX_BASE} [Logs/${taskRunId || 'N/A'}]`;
    
    if (!taskRunId) {
        return new Response(simpleStringify({ error: 'Missing taskRunId query parameter' }), {
            status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }
    
    try {
        hostLog(logPrefix, 'info', `Fetching logs for task run ID: ${taskRunId}`);
        // Fetch logs from task_runs and potentially related stack_runs if detailed logging is stored there
        const { data: taskRun, error } = await adminSupabaseClient
            .from('task_runs')
            .select('logs, vm_logs, status, error') // Select relevant fields
            .eq('id', taskRunId)
            .single();

        if (error) {
            hostLog(logPrefix, 'error', `Database query failed for task_run logs: ${error.message}`);
             if (error.code === 'PGRST116') { // Not found
                 return new Response(simpleStringify({ error: `Task run with ID ${taskRunId} not found (for logs)` }), {
                    status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                });
            }
            return new Response(simpleStringify({ error: `Failed to fetch task logs: ${error.message}` }), {
                status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }
        
        if (!taskRun) {
             return new Response(simpleStringify({ error: `Task run with ID ${taskRunId} not found (for logs)` }), {
                status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        // Potentially fetch more detailed logs from stack_runs associated with this task_run
        const { data: stackRunsLogs, error: stackRunsError } = await adminSupabaseClient
            .from('stack_runs')
            .select('logs, created_at, service_name, method_name, status')
            .eq('parent_task_run_id', taskRunId)
            .order('created_at', { ascending: true });

        let combinedLogs = {
            taskRunLogs: taskRun.logs || [],
            taskRunVMLogs: taskRun.vm_logs || [],
            stackRunEventLogs: [],
            status: taskRun.status,
            error: taskRun.error
        };

        if (stackRunsError) {
            hostLog(logPrefix, 'warn', `Could not fetch stack_run logs: ${stackRunsError.message}`);
        } else if (stackRunsLogs) {
            combinedLogs.stackRunEventLogs = stackRunsLogs.map(sr => ({
                timestamp: sr.created_at,
                service: sr.service_name,
                method: sr.method_name,
                status: sr.status,
                logs: sr.logs || []
            })) as any;
        }
        
        return new Response(simpleStringify(combinedLogs), {
            status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(logPrefix, 'error', `Exception in logsHandler: ${errorMessage}`);
        return new Response(simpleStringify({ error: `Internal server error fetching logs: ${errorMessage}` }), {
            status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }
}


serve(async (req: Request) => {
    const url = new URL(req.url);
    const pathSegments = url.pathname.split("/").filter(Boolean); // e.g., ['tasks', 'execute']
    const basePath = pathSegments[0]; // Should be 'tasks' for this function

    hostLog(LOG_PREFIX_BASE, 'info', `Req: ${req.method} ${url.pathname}`);

    try {
        if (basePath === "tasks") {
            const action = pathSegments[1]; // 'execute', 'status', 'logs'
            if (req.method === "POST" && action === "execute") {
                return await tasksHandler(req);
            } else if (req.method === "GET" && action === "status") {
                return await statusHandler(req);
            } else if (req.method === "GET" && action === "logs") {
                return await logsHandler(req);
            } else if (req.method === "OPTIONS") { // Catch-all OPTIONS for /tasks/*
                 return new Response("ok", { headers: CORS_HEADERS });
            }
             else if (!action && req.method === "POST") { // Backward compatibility for POST /tasks
                 hostLog(LOG_PREFIX_BASE, 'info', `Backward compatibility: POST /tasks routed to tasksHandler.`);
                 return await tasksHandler(req);
            }
        }
        
        // Default root response or unmatched paths
        hostLog(LOG_PREFIX_BASE, 'info', `Unmatched route: ${req.method} ${url.pathname}. Sending default info response.`);
        return new Response(simpleStringify({
            service: "Tasker Edge Function API",
            version: "1.1.0", // Incremented version
            status: "running",
            info: "See documentation for available endpoints.",
            available_routes: {
                "/tasks/execute": { "method": "POST", "description": "Execute a task asynchronously." },
                "/tasks/status": { "method": "GET", "params": "id (query: taskRunId)", "description": "Get the status of a task run." },
                "/tasks/logs": { "method": "GET", "params": "id (query: taskRunId)", "description": "Get logs for a task run." }
            }
        }), {
            status: (basePath === "tasks" && pathSegments.length > 1) ? 404 : 200, // 404 if /tasks/unknown, 200 for / or /tasks
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Unhandled error in main request router:", error.message, error.stack);
        return new Response(simpleStringify({ 
            error: "Internal server error", 
            message: error.message 
        }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});

hostLog(LOG_PREFIX_BASE, 'info', "Tasker Edge Function server started.");