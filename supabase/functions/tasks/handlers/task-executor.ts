import { jsonResponse, formatErrorResponse, formatLogMessage } from "../utils/response-formatter.ts";
import { fetchTaskFromDatabase, supabaseClient } from "../services/database.ts";
import { generateModuleCode } from "../services/module-generator.ts";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

config({ export: true });

const supabaseUrlEnv = Deno.env.get('SUPABASE_URL') || '';
// If the URL is the edge functions URL, use the REST API URL instead for local dev
const SUPABASE_URL = (supabaseUrlEnv.includes('127.0.0.1:8000') || supabaseUrlEnv.includes('kong:8000'))
    ? 'http://localhost:8080' 
    : (supabaseUrlEnv || '');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
// REMOVED Fetching/Validation of SERVICE_ROLE_KEY as per user instruction

// ---> Validate critical environment variables
if (!SUPABASE_URL) throw new Error('Missing required environment variable: SUPABASE_URL');
if (!SUPABASE_ANON_KEY) throw new Error('Missing required environment variable: SUPABASE_ANON_KEY');
// <--- END Validate

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
          const quickJsUrl = `${SUPABASE_URL}/functions/v1/quickjs`;
          
          // DEBUG: Log the payload being sent
          const payload = {
            taskCode: task.code,
            taskName: task.name,
            taskInput: input || {},
            taskRunId: taskRunId,
            stackRunId: crypto.randomUUID(),
            toolNames: [],
            initialVmState: null
          };
          console.log(formatLogMessage('DEBUG', `QuickJS payload: ${JSON.stringify(payload)}`));

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
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
              },
              body: JSON.stringify(payload),
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
