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
export async function executeTask(
  taskId: string,
  input: Record<string, unknown> = {},
  options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}
): Promise<Response> {
  const startTime = Date.now();
  //console.log(formatLogMessage('INFO', `Task execution started at ${new Date(startTime).toISOString()}`));
  //console.log(formatLogMessage('INFO', `Executing task: ${taskId}`));

  try {
    // Fetch the task from the database
    //console.log(formatLogMessage('DEBUG', `Getting task definition for: ${taskId}`));
    const task = await fetchTaskFromDatabase(taskId);

    if (!task) {
      const errorMsg = `Task not found: ${taskId}`;
      console.error(`[ERROR] ${errorMsg}`);
      console.log(formatLogMessage('ERROR', errorMsg));
      return jsonResponse(formatErrorResponse(errorMsg), 404);
    }

    try {
      // --- Prepare Service Proxy Configuration ---
      const serviceProxiesConfig = [
        {
          name: 'keystore',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedkeystore`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'openai',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedopenai`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'supabase',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedsupabase`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'websearch',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedwebsearch`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'tasks',
          baseUrl: `${SUPABASE_URL}/functions/v1/tasks`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        },
        {
          name: 'gapi',
          baseUrl: `${SUPABASE_URL}/functions/v1/wrappedgapi`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
          }
        }
      ];

      // Generate modules record (currently only 'tasks')
      const modulesRecord = await generateModuleCode(
        `Bearer ${SUPABASE_ANON_KEY}`,
        SUPABASE_URL
      );

      // Prepare runtime configuration for QuickJS environment
      const runtimeConfig = {
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY,
      };

      // Call the QuickJS edge function
      //console.log(formatLogMessage('INFO', `Invoking QuickJS function for task ${task.name}...`));
      const quickJsUrl = `${SUPABASE_URL}/functions/v1/quickjs`;
      //console.log(formatLogMessage('DEBUG', `QuickJS URL: ${quickJsUrl}`));

      // Add a timeout for the fetch call
      const controller = new AbortController();
      // Restore original timeout
      const timeoutDuration = 180000;
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
            console.log(formatLogMessage('ERROR', errorMsg));
            throw new Error(errorMsg);
        } else {
            const errorMsg = `Fetch error calling QuickJS: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
            console.log(formatLogMessage('ERROR', errorMsg));
            throw fetchError; // Re-throw other fetch errors
        }
      } finally {
        clearTimeout(timeoutId); // Clear the timeout watcher
      }

      //console.log(formatLogMessage('DEBUG', `QuickJS response status: ${response.status}`));

      const responseBody = await response.text(); // Read body once

      if (!response.ok) {
        console.log(formatLogMessage('ERROR', `QuickJS execution failed: ${response.status} ${response.statusText} - ${responseBody}`));
        throw new Error(`QuickJS execution failed: ${response.status} ${response.statusText} - ${responseBody}`);
      }

       let result: any;
       try {
           result = JSON.parse(responseBody);
       } catch (parseError) {
           console.log(formatLogMessage('ERROR', `Failed to parse QuickJS JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
           //console.log(formatLogMessage('DEBUG', `Raw QuickJS response body: ${responseBody}`));
           throw new Error('Failed to parse QuickJS JSON response.');
       }

       // Log the actual result received from QuickJS before formatting
       //console.log(formatLogMessage('DEBUG', `Raw QuickJS result.result: ${JSON.stringify(result.result)}`));

       // Merge logs from QuickJS execution
        if (result.logs && Array.isArray(result.logs)) {
            result.logs.forEach((logEntry: any) => {
                 if (typeof logEntry === 'string') {
                   // Attempt to parse if it looks like our format, otherwise log raw
                     if (logEntry.startsWith('[') && logEntry.includes('] [')) {
                        console.log(logEntry); // Assume pre-formatted string
                     } else {
                        console.log(formatLogMessage('INFO', `[QuickJS Raw Log] ${logEntry}`));
                     }
                 } else if (logEntry && typeof logEntry === 'object' && logEntry.message) {
                    console.log(formatLogMessage(
                        (logEntry.level?.toUpperCase() as ('INFO'|'ERROR'|'WARN'|'DEBUG')) || 'INFO',
                        `[QuickJS-${logEntry.source?.toUpperCase() || 'VM'}] ${logEntry.message}`,
                         logEntry.data
                     ));
                 } else {
                     console.log(formatLogMessage('DEBUG', `[QuickJS JSON Log] ${JSON.stringify(logEntry)}`));
                 }
            });
        }

      if (!result.success) {
         const errorMsg = `QuickJS execution reported failure: ${result.error || 'Unknown error'}`;
         console.log(formatLogMessage('ERROR', errorMsg));
         if (result.errorDetails) { // Include details if provided by QuickJS
             console.log(formatLogMessage('ERROR', `QuickJS error details: ${JSON.stringify(result.errorDetails)}`));
         }
         throw new Error(errorMsg);
       }

      //console.log(formatLogMessage('INFO', `Task ${task.name} executed successfully.`));
      const endTime = Date.now();
      console.log('Total Time:', endTime - startTime);

      const finalFormattedResult = formatTaskResult(true, result.result, undefined);
      // Return the successful result, including merged logs and execution time
      return jsonResponse(finalFormattedResult); // Use the logged object

    } catch (taskError) {
        const errorMsg = `Error during task code execution: ${taskError instanceof Error ? taskError.message : String(taskError)}`;
        console.log(formatLogMessage('ERROR', errorMsg));
        // Re-throw to be caught by outer handler - Let outer handler manage final response formatting
        throw taskError;
    }

  } catch (error) {
      const errorMsg = `Failed to execute task ${taskId}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[ERROR] ${errorMsg}`);
      if (error instanceof Error && error.stack) {
          console.error(`[ERROR] Stack trace: ${error.stack}`);
          console.log(formatLogMessage('ERROR', `Stack: ${error.stack}`)); // Add stack to logs
      }
      console.log(formatLogMessage('ERROR', errorMsg));
      const endTime = Date.now();
      return jsonResponse(formatErrorResponse(errorMsg), 500);
  }
}
