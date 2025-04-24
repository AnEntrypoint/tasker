import { jsonResponse, formatTaskResult, formatErrorResponse, formatLogMessage } from "../utils/response-formatter.ts";
import { fetchTaskFromDatabase } from "../services/database.ts";
import { generateModuleCode } from "../services/module-generator.ts";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

config({ export: true });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
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
 */
export async function executeTask(taskId: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}): Promise<Response> {
  // Create logs array
  const logs: string[] = [];
  const startTime = Date.now();
  logs.push(formatLogMessage('INFO', `Task execution started at ${new Date(startTime).toISOString()}`));
  logs.push(formatLogMessage('INFO', `Executing task: ${taskId}`));

  try {
    // Fetch the task from the database
    logs.push(formatLogMessage('INFO', `Getting task definition for: ${taskId}`));
    const task = await fetchTaskFromDatabase(taskId);

    if (!task) {
      const errorMsg = `Task not found: ${taskId}`;
      console.error(`[ERROR] ${errorMsg}`);
      logs.push(formatLogMessage('ERROR', errorMsg));
      const endTime = Date.now();
      return jsonResponse(formatErrorResponse(errorMsg, logs), 404);
    }

    // Log task information
    logs.push(formatLogMessage('INFO', `Task found: ${task.name}`));
    logs.push(formatLogMessage('DEBUG', `Task code length: ${task.code?.length || 0} bytes`));
    logs.push(formatLogMessage('DEBUG', `Input: ${JSON.stringify(input)}`));

    // Execute the task code by sending to QuickJS edge function
    logs.push(formatLogMessage('INFO', `Preparing execution environment for task ${task.name}`));

    try {
      // --- Prepare Service Proxy Configuration ---
      logs.push(formatLogMessage('DEBUG', 'Constructing service proxy configurations...'));
      const serviceProxiesConfig = [
        {
          name: 'keystore',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedkeystore`,
          headers: { // Use ANON_KEY as per user instruction
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'openai',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedopenai`,
          headers: { // Use standard anon key auth
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'supabase',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedsupabase`,
          headers: { // Use standard anon key auth
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'websearch',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedwebsearch`,
           headers: { // Use standard anon key auth
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        // Add the tasks service proxy configuration
        {
          name: 'tasks',
          baseUrl: `${SUPABASE_URL}/functions/v1/tasks`,
          headers: { // Use standard anon key auth
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        // ---> ADD wrappedgapi HERE <---
        {
          name: 'gapi', // The name used in QuickJS: tools.gapi
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedgapi`,
          headers: { // Use standard anon key auth
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        }
        // Add more services here as needed
      ];
      logs.push(formatLogMessage('DEBUG', `Service proxies configured: ${serviceProxiesConfig.map(p => p.name).join(', ')}`));


      // Generate modules record (currently only 'tasks')
      const modulesRecord = await generateModuleCode(
        `Bearer ${SUPABASE_ANON_KEY}`, // Pass key for tasks module fetch calls
        SUPABASE_URL
      );

      // Prepare runtime configuration for QuickJS environment
      const runtimeConfig = {
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY,
      };

      // --- Inject Logging into Task Code (Optional, can be removed if not needed) ---
      // let taskCode = task.code;
      // const openAiCallLine = 'await tools.openai.createChatCompletion';
      // const openAiValidationLine = 'if (!openaiResponse || !openaiResponse.choices'; // Target the validation line

      // if (taskCode.includes(openAiCallLine)) {
      //     logs.push(formatLogMessage('DEBUG', 'Injecting VM logs around OpenAI call...'));
      //     // Log BEFORE the call
      //     taskCode = taskCode.replace(
      //         openAiCallLine,
      //         `console.log("[VM Task Log] Attempting OpenAI call...");\n    ${openAiCallLine}` // Keep original indentation
      //     );
      //     // Log AFTER the call (before validation)
      //     if (taskCode.includes(openAiValidationLine)) {
      //        taskCode = taskCode.replace(
      //            openAiValidationLine,
      //            `console.log("[VM Task Log] OpenAI call awaited (before validation).");\n    ${openAiValidationLine}` // Keep original indentation
      //        );
      //        logs.push(formatLogMessage('DEBUG', 'Successfully injected log after OpenAI call.'));
      //     } else {
      //        logs.push(formatLogMessage('WARN', 'OpenAI validation line not found for injecting log *after* call.'));
      //     }
      // } else {
      //     logs.push(formatLogMessage('WARN', 'OpenAI call line not found in task code for log injection.'));
      // }
      // -------------------------------------------------------------------------------------

      // Call the QuickJS edge function
      logs.push(formatLogMessage('INFO', `Invoking QuickJS function for task ${task.name}...`));
      const quickJsUrl = `${SUPABASE_URL}/functions/v1/quickjs`;
      logs.push(formatLogMessage('DEBUG', `QuickJS URL: ${quickJsUrl}`));

      // Add a timeout for the fetch call
      const controller = new AbortController();
      // Restore original timeout
      const timeoutDuration = 90000; // 90 seconds
      const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

      let response: Response;
      try {
        response = await fetch(quickJsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}` // Use anon key for quickjs function
          },
          body: JSON.stringify({
            code: task.code, // Use original task code
            input: input,
            modules: { // Pass necessary modules
              tasks: modulesRecord.tasks
            },
            runtimeConfig: runtimeConfig,
            serviceProxies: serviceProxiesConfig
          }),
          signal: controller.signal // Pass the abort signal
        });
      } catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            const errorMsg = `QuickJS function call timed out after ${timeoutDuration / 1000} seconds.`;
            logs.push(formatLogMessage('ERROR', errorMsg));
            throw new Error(errorMsg);
        } else {
            const errorMsg = `Fetch error calling QuickJS: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
            logs.push(formatLogMessage('ERROR', errorMsg));
            throw fetchError; // Re-throw other fetch errors
        }
      } finally {
        clearTimeout(timeoutId); // Clear the timeout watcher
      }

      logs.push(formatLogMessage('DEBUG', `QuickJS response status: ${response.status}`));

      const responseBody = await response.text(); // Read body once

      if (!response.ok) {
        logs.push(formatLogMessage('ERROR', `QuickJS execution failed: ${response.status} ${response.statusText} - ${responseBody}`));
        throw new Error(`QuickJS execution failed: ${response.status} ${response.statusText} - ${responseBody}`);
      }

       let result: any;
       try {
           result = JSON.parse(responseBody);
       } catch (parseError) {
           logs.push(formatLogMessage('ERROR', `Failed to parse QuickJS JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
           logs.push(formatLogMessage('DEBUG', `Raw QuickJS response body: ${responseBody}`));
           throw new Error('Failed to parse QuickJS JSON response.');
       }

       // Log the actual result received from QuickJS before formatting
       logs.push(formatLogMessage('DEBUG', `Raw QuickJS result.result: ${JSON.stringify(result.result)}`));

       // Merge logs from QuickJS execution
        if (result.logs && Array.isArray(result.logs)) {
            result.logs.forEach((logEntry: any) => {
                 if (typeof logEntry === 'string') {
                   // Attempt to parse if it looks like our format, otherwise log raw
                     if (logEntry.startsWith('[') && logEntry.includes('] [')) {
                        logs.push(logEntry); // Assume pre-formatted string
                     } else {
                        logs.push(formatLogMessage('INFO', `[QuickJS Raw Log] ${logEntry}`));
                     }
                 } else if (logEntry && typeof logEntry === 'object' && logEntry.message) {
                    logs.push(formatLogMessage(
                        (logEntry.level?.toUpperCase() as ('INFO'|'ERROR'|'WARN'|'DEBUG')) || 'INFO',
                        `[QuickJS-${logEntry.source?.toUpperCase() || 'VM'}] ${logEntry.message}`,
                         logEntry.data
                     ));
                 } else {
                     logs.push(formatLogMessage('DEBUG', `[QuickJS JSON Log] ${JSON.stringify(logEntry)}`));
                 }
            });
        }

      if (!result.success) {
         const errorMsg = `QuickJS execution reported failure: ${result.error || 'Unknown error'}`;
         logs.push(formatLogMessage('ERROR', errorMsg));
         if (result.errorDetails) { // Include details if provided by QuickJS
             logs.push(formatLogMessage('ERROR', `QuickJS error details: ${JSON.stringify(result.errorDetails)}`));
         }
         throw new Error(errorMsg);
       }

      logs.push(formatLogMessage('INFO', `Task ${task.name} executed successfully.`));
      const endTime = Date.now();
      logs.push(formatLogMessage('INFO', `Total execution time: ${endTime - startTime}ms`));

      // Return the successful result, including merged logs and execution time
      return jsonResponse(formatTaskResult(true, result.result, undefined, logs));

    } catch (taskError) {
        const errorMsg = `Error during task code execution: ${taskError instanceof Error ? taskError.message : String(taskError)}`;
        logs.push(formatLogMessage('ERROR', errorMsg));
        // Re-throw to be caught by outer handler - Let outer handler manage final response formatting
        throw taskError;
    }

  } catch (error) {
      const errorMsg = `Failed to execute task ${taskId}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[ERROR] ${errorMsg}`);
      if (error instanceof Error && error.stack) {
          console.error(`[ERROR] Stack trace: ${error.stack}`);
          logs.push(formatLogMessage('ERROR', `Stack: ${error.stack}`)); // Add stack to logs
      }
      logs.push(formatLogMessage('ERROR', errorMsg));
      const endTime = Date.now();
      return jsonResponse(formatErrorResponse(errorMsg, logs), 500);
  }
}

// Ensure response-formatter is updated to accept executionTime
// Example modification in response-formatter.ts (adjust as needed):
/*
export interface TaskResponse {
    success: boolean;
    result?: any;
    error?: { message: string; stack?: string };
    logs?: string[];
    metadata?: {
        executionTime?: number;
        [key: string]: any; // Allow other metadata
    };
}


export function formatTaskResult(
  success: boolean,
  result?: any,
  error?: any,
  logs?: string[],
  executionTime?: number // Add optional executionTime
): TaskResponse {
  const response: TaskResponse = { success };
  if (result !== undefined) response.result = result;
  if (error) response.error = { message: error.message || String(error), stack: error.stack };
  if (logs) response.logs = logs;
  if (executionTime !== undefined) {
    response.metadata = { // Ensure metadata exists
        ...(response.metadata || {}), // Preserve existing metadata if any
        executionTime
    };
    // Add basic resource usage if needed, requires more instrumentation
    // response.metadata.resourceUsage = { memory: 0, cpu: 0 };
  }
  return response;
}

export function formatErrorResponse(
    message: string,
    logs?: string[],
    executionTime?: number // Add optional executionTime
): TaskResponse {
    const response: TaskResponse = {
        success: false,
        error: { message }
    };
    if (logs) response.logs = logs;
    if (executionTime !== undefined) {
      response.metadata = { // Ensure metadata exists
          ...(response.metadata || {}),
          executionTime
      };
    }
    return response;
}
*/
