import { jsonResponse, formatErrorResponse, formatLogMessage } from "../utils/response-formatter.ts";
import { fetchTaskFromDatabase, supabaseClient } from "../services/database.ts";
import { generateModuleCode } from "../services/module-generator.ts";
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
// import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts"; // Removed dotenv

// config({ export: true }); // Removed dotenv call

// Prioritize EXT_ prefixed variables from Supabase Edge Runtime
const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL');
const supabaseUrlFromEnv = Deno.env.get('SUPABASE_URL'); // Fallback if EXT_ is not set

let SUPABASE_URL_FOR_CLIENT = extSupabaseUrl || supabaseUrlFromEnv || '';
// For edge-to-edge communication in local development, use kong URL instead of 127.0.0.1
if (SUPABASE_URL_FOR_CLIENT.includes('127.0.0.1:8000') || SUPABASE_URL_FOR_CLIENT.includes('localhost:8000')) {
    console.log(`[task-executor.ts] Detected local development environment. Using kong URL for edge-to-edge communication.`);
    SUPABASE_URL_FOR_CLIENT = 'http://kong:8000';
}

const SUPABASE_ANON_KEY_FOR_CLIENT = Deno.env.get('EXT_SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';

// ---> Validate critical environment variables for client initialization
if (!SUPABASE_URL_FOR_CLIENT) {
    console.error('[task-executor.ts] Critical: SUPABASE_URL_FOR_CLIENT could not be determined from EXT_SUPABASE_URL or SUPABASE_URL.');
    throw new Error('Missing environment variable for Supabase URL (EXT_SUPABASE_URL or SUPABASE_URL)');
}
if (!SUPABASE_ANON_KEY_FOR_CLIENT) {
    console.error('[task-executor.ts] Critical: SUPABASE_ANON_KEY_FOR_CLIENT could not be determined from EXT_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY.');
    throw new Error('Missing environment variable for Supabase Anon Key (EXT_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY)');
}

console.log(`[task-executor.ts] Using SUPABASE_URL_FOR_CLIENT: ${SUPABASE_URL_FOR_CLIENT}`);
console.log(`[task-executor.ts] Using SUPABASE_ANON_KEY_FOR_CLIENT: ${SUPABASE_ANON_KEY_FOR_CLIENT ? '[REDACTED]' : 'MISSING'}`);

// ... supabaseClient initialization in database.ts should be used for DB operations
// ... For calling other edge functions like quickjs, we construct the URL using EXT_SUPABASE_URL primarily.

const QUICKJS_FUNCTION_URL_BASE = (SUPABASE_URL_FOR_CLIENT.startsWith('http') ? SUPABASE_URL_FOR_CLIENT : `http://${SUPABASE_URL_FOR_CLIENT}`) + '/functions/v1/quickjs';

/**
 * Task interface representing a task in the database
 */
export interface TaskDefinition {
  id: string;
  name: string;
  description: string;
  code: string;
  created_at: string;
  updated_at: string;
}

/**
 * Execute a task with the given name and input
 *
 * This function now implements an ephemeral execution model:
 * 1. It immediately returns a response indicating that the task is being processed
 * 2. The task execution is recorded in the task_runs table with status 'queued'
 * 3. The result of the task execution is stored in the task_runs table, not returned to the caller
 * 4. The caller can check the status of the task execution by querying the task_runs table
 */
export async function executeTask(
  taskId: string,
  input: Record<string, unknown> = {},
  _options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}
): Promise<Response> {
  const startTime = Date.now();
  const taskRunId = crypto.randomUUID();
  console.log(formatLogMessage('INFO', `Task execution started at ${new Date(startTime).toISOString()}`));
  console.log(formatLogMessage('INFO', `Executing task: ${taskId} with run ID: ${taskRunId}`));

  try {
    // Fetch the task from the database
    const task = await fetchTaskFromDatabase(taskId);

    if (!task) {
      const errorMsg = `Task not found: ${taskId}`;
      console.error(`[ERROR] ${errorMsg}`);
      console.log(formatLogMessage('ERROR', errorMsg));
      return jsonResponse(formatErrorResponse(errorMsg), 404);
    }

    // Create a task_runs record with status 'queued'
      try {
      const insertResult = await supabaseClient.from('task_runs').insert({
          id: taskRunId,
        task_name: taskId,
        input: input || {},
          status: 'queued',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
      }).select('id').maybeSingle();

        if (!insertResult || insertResult.error) {
          const errorMessage = insertResult?.error?.message || 'Unknown error during insert';
          console.log(formatLogMessage('ERROR', `Failed to create task_runs record: ${errorMessage}`));
          // Continue execution even if task_runs record creation fails
        } else {
          console.log(formatLogMessage('INFO', `Created task_runs record with ID: ${taskRunId}`));
        }
      } catch (taskRunError) {
        console.log(formatLogMessage('ERROR', `Error creating task_runs record: ${taskRunError}`));
        // Continue execution even if task_runs record creation fails
      }

      // Start task execution in the background
      (async () => {
        try {
          // Call the QuickJS edge function
        console.log(formatLogMessage('INFO', `Invoking QuickJS function for task ${taskId}...`));
          const quickJsUrl = QUICKJS_FUNCTION_URL_BASE;

          // Add a timeout for the fetch call
          const controller = new AbortController();
          const timeoutDuration = 180000;
          const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

          let response: Response;
          try {
            response = await fetch(quickJsUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY_FOR_CLIENT}`
              },
              body: JSON.stringify({
              taskCode: task.code,
              taskName: task.name,
              taskInput: input || {},
              taskRunId: taskRunId
              }),
            signal: controller.signal
            });
          } catch (fetchError) {
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                const errorMsg = `QuickJS function call timed out after ${timeoutDuration / 1000} seconds.`;
                console.log(formatLogMessage('ERROR', errorMsg));

                // Update the task_runs record with the error
                await supabaseClient.from('task_runs').update({
                  status: 'error',
                  error: { message: errorMsg },
                  updated_at: new Date().toISOString()
                }).eq('id', taskRunId);

                return; // Exit the background task
            } else {
                const errorMsg = `Fetch error calling QuickJS: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
                console.log(formatLogMessage('ERROR', errorMsg));

                // Update the task_runs record with the error
                await supabaseClient.from('task_runs').update({
                  status: 'error',
                  error: { message: errorMsg },
                  updated_at: new Date().toISOString()
                }).eq('id', taskRunId);

                return; // Exit the background task
            }
          } finally {
            clearTimeout(timeoutId); // Clear the timeout watcher
          }

          const responseBody = await response.text(); // Read body once

          if (!response.ok) {
          const errorMsg = `Failed to execute task: ${response.status} - ${responseBody}`;
            console.log(formatLogMessage('ERROR', errorMsg));

            // Update the task_runs record with the error
            await supabaseClient.from('task_runs').update({
              status: 'error',
              error: { message: errorMsg },
              updated_at: new Date().toISOString()
            }).eq('id', taskRunId);

            return; // Exit the background task
          }

        // If execution was successful but the task is suspended waiting for a nested call
        // The QuickJS function will update the task_run status directly
        // We don't need to update it here

        // For immediate completion, update with result
        try {
          const result = JSON.parse(responseBody);
          if (result && !result.__hostCallSuspended) {
            await supabaseClient.from('task_runs').update({
              status: 'completed',
              result,
              updated_at: new Date().toISOString(),
              ended_at: new Date().toISOString()
            }).eq('id', taskRunId);
        }
        } catch (parseError) {
          console.log(formatLogMessage('ERROR', `Failed to parse QuickJS response: ${parseError}`));
          // Don't update task run status here as it might be handled by the stack processor
        }
    } catch (error) {
        console.log(formatLogMessage('ERROR', `Background task execution error: ${error}`));
        // Update task run with error
      try {
        await supabaseClient.from('task_runs').update({
          status: 'error',
            error: { message: error instanceof Error ? error.message : String(error) },
            updated_at: new Date().toISOString(),
            ended_at: new Date().toISOString()
        }).eq('id', taskRunId);
      } catch (updateError) {
          console.log(formatLogMessage('ERROR', `Failed to update task run with error: ${updateError}`));
      }
      }
    })();

    // Immediately return a response with the task ID for tracking
    return jsonResponse({
      message: "Task execution started",
      taskRunId,
      status: "queued"
    }, 202);
  } catch (error) {
    console.error(`Error in executeTask: ${error instanceof Error ? error.message : String(error)}`);
    return jsonResponse(formatErrorResponse(`Error executing task: ${error instanceof Error ? error.message : String(error)}`), 500);
  }
}

export interface ProcessStackRunParams {
  taskCode: string;
  taskName: string;
  taskInput: Record<string, unknown>;
  parentTaskRunId: string;
  currentStackRunId: string;
  // vmResumeState?: any; // For future resumable VMs
  dbClient: SupabaseClient; // Client for updating stack_runs table
}

export interface ProcessStackRunResult {
  status: 'completed' | 'failed' | 'suspended';
  result?: any;
  error?: any;
  qjsRawResponse?: string; // For debugging
}

/**
 * Processes a specific stack run by invoking the QuickJS Edge Function.
 * It updates the status of the currentStackRunId in the 'stack_runs' table.
 * It assumes that if QuickJS suspends, QuickJS itself handles updating its
 * 'stack_runs' record to 'suspended' and creating child stack_runs.
 */
export async function processStackRunViaQuickJs({
  taskCode,
  taskName,
  taskInput,
  parentTaskRunId,
  currentStackRunId,
  dbClient,
  // vmResumeState 
}: ProcessStackRunParams): Promise<ProcessStackRunResult> {
  const startTime = Date.now();
  console.log(formatLogMessage('INFO', `[stackRun:${currentStackRunId}] processStackRunViaQuickJs started for task '${taskName}' (parentTaskRun:${parentTaskRunId}) at ${new Date(startTime).toISOString()}`));

  try {
    console.log(formatLogMessage('INFO', `[stackRun:${currentStackRunId}] Invoking QuickJS function at ${QUICKJS_FUNCTION_URL_BASE}...`));

    const controller = new AbortController();
    const timeoutDuration = 180000; // 3 minutes
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

    let qjsResponse: Response;
    try {
      qjsResponse = await fetch(QUICKJS_FUNCTION_URL_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY_FOR_CLIENT}`
        },
        body: JSON.stringify({
          taskCode,
          taskName,
          taskInput: taskInput || {},
          taskRunId: parentTaskRunId, // Passed to QJS for context, logging, and creating child stack_runs
          stackRunId: currentStackRunId, // Passed to QJS so it knows which stack_run it represents
          // vmResumeState // For future resumable VMs
        }),
        signal: controller.signal
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        const errorMsg = `[stackRun:${currentStackRunId}] QuickJS function call timed out after ${timeoutDuration / 1000} seconds.`;
        console.log(formatLogMessage('ERROR', errorMsg));
        await dbClient.from('stack_runs').update({
          status: 'failed',
          error: { message: errorMsg, type: 'TimeoutError' },
          updated_at: new Date().toISOString(),
          ended_at: new Date().toISOString()
        }).eq('id', currentStackRunId);
        return { status: 'failed', error: { message: errorMsg, type: 'TimeoutError' } };
      } else {
        const errorMsg = `[stackRun:${currentStackRunId}] Fetch error calling QuickJS: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
        console.log(formatLogMessage('ERROR', errorMsg));
        await dbClient.from('stack_runs').update({
          status: 'failed',
          error: { message: errorMsg, type: 'FetchError', details: String(fetchError) },
          updated_at: new Date().toISOString(),
          ended_at: new Date().toISOString()
        }).eq('id', currentStackRunId);
        return { status: 'failed', error: { message: errorMsg, type: 'FetchError' } };
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const responseBodyText = await qjsResponse.text();

    if (!qjsResponse.ok) {
      const errorMsg = `[stackRun:${currentStackRunId}] QuickJS execution failed: ${qjsResponse.status} - ${responseBodyText}`;
      console.log(formatLogMessage('ERROR', errorMsg));
      await dbClient.from('stack_runs').update({
        status: 'failed',
        error: { message: `QuickJS execution failed: ${qjsResponse.status}`, details: responseBodyText, type: 'QuickJSError' },
        updated_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      }).eq('id', currentStackRunId);
      return { status: 'failed', error: { message: errorMsg, type: 'QuickJSError' }, qjsRawResponse: responseBodyText };
    }

    // QuickJS execution was successful (HTTP 2xx)
    try {
      const result = JSON.parse(responseBodyText);
      console.log(formatLogMessage('INFO', `[stackRun:${currentStackRunId}] QuickJS response received, __hostCallSuspended: ${result?.__hostCallSuspended}`));

      if (result && result.__hostCallSuspended === true) {
        // QuickJS has suspended and is expected to have:
        // 1. Created a new child stack_run record (status: 'pending').
        // 2. Updated its own currentStackRunId record to status: 'suspended'.
        // If QuickJS does not update its own stack_run, the stack-processor might need to.
        // For now, we assume QuickJS did its job.
        console.log(formatLogMessage('INFO', `[stackRun:${currentStackRunId}] Task execution suspended by QuickJS. Current stack run should be marked 'suspended' by QuickJS.`));
        // Optionally verify:
        // const { data: current } = await dbClient.from('stack_runs').select('status').eq('id', currentStackRunId).single();
        // if (current && current.status !== 'suspended') { /* log warning or force update */ }
        return { status: 'suspended', result, qjsRawResponse: responseBodyText };
      } else {
        // QuickJS completed this segment without suspending.
        console.log(formatLogMessage('INFO', `[stackRun:${currentStackRunId}] Task execution completed successfully by QuickJS.`));
        await dbClient.from('stack_runs').update({
          status: 'completed',
          result: result,
          updated_at: new Date().toISOString(),
          ended_at: new Date().toISOString()
        }).eq('id', currentStackRunId);
        return { status: 'completed', result, qjsRawResponse: responseBodyText };
      }
    } catch (parseError) {
      const errorMsg = `[stackRun:${currentStackRunId}] Failed to parse QuickJS JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}. Raw response: ${responseBodyText}`;
      console.log(formatLogMessage('ERROR', errorMsg));
      // Treat as failure of this stack run, as we can't determine its state.
      await dbClient.from('stack_runs').update({
        status: 'failed',
        error: { message: 'Failed to parse QuickJS JSON response', details: responseBodyText, type: 'ResponseParseError' },
        updated_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      }).eq('id', currentStackRunId);
      return { status: 'failed', error: { message: errorMsg, type: 'ResponseParseError' }, qjsRawResponse: responseBodyText };
    }

  } catch (error) {
    const errorMsg = `[stackRun:${currentStackRunId}] Unhandled error in processStackRunViaQuickJs: ${error instanceof Error ? error.message : String(error)}`;
    console.log(formatLogMessage('ERROR', errorMsg));
    // Attempt to mark the stack_run as failed
    try {
      await dbClient.from('stack_runs').update({
        status: 'failed',
        error: { message: 'Unhandled error during stack run processing', details: String(error), type: 'UnhandledError' },
        updated_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      }).eq('id', currentStackRunId);
    } catch (updateError) {
      console.log(formatLogMessage('ERROR', `[stackRun:${currentStackRunId}] Additionally failed to update stack_run on unhandled error: ${updateError instanceof Error ? updateError.message : String(updateError)}`));
    }
    return { status: 'failed', error: { message: errorMsg, type: 'UnhandledError' } };
  }
}
