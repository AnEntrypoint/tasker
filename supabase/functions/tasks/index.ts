import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve, ConnInfo } from "https://deno.land/std@0.201.0/http/server.ts";
import { corsHeaders } from "../quickjs/cors.ts";
import { executeTask } from "./handlers/task-executor.ts";
import { jsonResponse, formatTaskResult, formatLogMessage } from "./utils/response-formatter.ts";
import { TaskRegistry } from "./registry/task-registry.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateSchema, formatSchema } from './services/schema-generator.ts';
import { parseJSDocComments } from './utils/jsdoc-parser.ts';
import { GeneratedSchema } from "./types/index.ts";
import { executeMethodChain } from "npm:sdk-http-wrapper@1.0.10/server";

config({ export: true });

declare global {
  var __updatedFields: Record<string, any>;
}

// Initialize task registries
const basicTaskRegistry = new TaskRegistry();
const specialTaskRegistry = new TaskRegistry();

// Environment setup
const SUPABASE_URL = Deno.env.get('EXT_SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('EXT_SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || '';
console.log(`[INFO] SUPABASE_URL: ${SUPABASE_URL}`);
const supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// --- Define the Tasks Service for SDK Wrapper ---
const tasksService = {
  execute: async (taskIdentifier: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}) => {
    console.log(`[INFO][SDK Service] Received task execution request for: ${taskIdentifier}`);
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

serve(async (req: Request, connInfo: ConnInfo): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return createCorsPreflightResponse();
  }

  const url = new URL(req.url);
  // Use the full pathname provided by the Supabase gateway
  const pathname = url.pathname;
  console.log(`[INFO] Processing ${req.method} request to ${pathname}`);

  try {
    // --- Handle POST requests (Potential SDK Call or Direct Task Execution) ---
    if (req.method === 'POST') {
        let requestBody;
        try {
          requestBody = await req.clone().json();
        } catch (e) {
          const error = e as Error;
          return createErrorResponse("Invalid JSON body", [formatLogMessage('ERROR', `Failed to parse JSON body: ${error.message}`)], 400);
        }

        // Check for SDK Wrapper request (has 'chain')
        if (requestBody.chain && Array.isArray(requestBody.chain)) {
          console.log(`[INFO] Handling SDK wrapper request for tasks service`);
          try {
            const result = await executeMethodChain(tasksService, requestBody.chain);
            return new Response(JSON.stringify({ data: result }), { status: 200, headers: corsHeaders });
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[ERROR][SDK Service] ${err.message}`);
            return new Response(JSON.stringify({ 
              error: { message: err.message, code: (err as any).code, name: err.name, stack: err.stack }
            }), { status: (err as any).status || 500, headers: corsHeaders });
          }
        } 
        // Handle Direct Task Execution request (POST without 'chain')
        else {
            console.log(`[INFO] Handling direct task execution request`);
            const taskIdentifier = requestBody.taskId || requestBody.id || requestBody.name;
            if (!taskIdentifier) {
              return createErrorResponse('No task identifier provided in body', [], 400);
            }
            // Check registry or execute from DB (using the logic previously in handleTaskRoutes)
            if (specialTaskRegistry.hasTask(taskIdentifier) || basicTaskRegistry.hasTask(taskIdentifier)) {
                const logs: string[] = [formatLogMessage('INFO', `Executing registered task: ${taskIdentifier}`)];
                try {
                  let result;
                  if (specialTaskRegistry.hasTask(taskIdentifier)) {
                    result = await specialTaskRegistry.executeTask(taskIdentifier, requestBody.input || {}, logs);
                  } else {
                    result = await basicTaskRegistry.executeTask(taskIdentifier, requestBody.input || {}, logs);
                  }
                  return createResponse(result, logs);
                } catch (error) {
                  const errorMsg = `Error executing registered task: ${error instanceof Error ? error.message : String(error)}`;
                  console.error(`[ERROR] ${errorMsg}`);
                  logs.push(formatLogMessage('ERROR', errorMsg));
                  return createErrorResponse(errorMsg, logs);
                }
            } else {
                const options = {
                  debug: Boolean(requestBody.debug),
                  verbose: Boolean(requestBody.verbose),
                  include_logs: Boolean(requestBody.include_logs)
                };
                // executeTask now returns Response, so just return it
                return await executeTask(taskIdentifier, requestBody.input || {}, options);
            }
        }
    }
    // --- Handle GET requests (List, OpenAPI, etc.) ---
    else if (req.method === 'GET') {
        // Determine route based on the last segment of the path relative to the function mount point
        const pathSegments = pathname.split('/').filter(Boolean);
        const routeSegment = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : '';

        // Task list route (/functions/v1/tasks/list or potentially just /functions/v1/tasks)
        if (routeSegment === 'list' || (routeSegment === 'tasks' && pathSegments.includes('v1'))) { // Basic check
             console.log(`[INFO] Handling GET request for task list`);
            try {
                const endpoint = `${SUPABASE_URL}/rest/v1/task_functions`;
                const response = await fetch(`${endpoint}?order=name.asc`, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
                });
                if (!response.ok) return createErrorResponse(`REST API error: ${response.status} ${response.statusText}`);
                const data = await response.json();
                return createResponse({ tasks: data || [], count: data?.length || 0, timestamp: new Date().toISOString() });
            } catch (error) {
                return createErrorResponse(`Error listing tasks: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // OpenAPI schema route (/functions/v1/tasks/openapi)
        else if (routeSegment === 'openapi') {
            console.log(`[INFO] Handling GET request for OpenAPI schema`);
            try {
                // Simplified OpenAPI generation logic from previous code
                const { data: tasks, error: fetchError } = await supabaseClient.from('task_functions').select('name, code, description');
                if (fetchError) throw new Error(`Database error fetching tasks: ${fetchError.message}`);
                if (!tasks || tasks.length === 0) return createResponse({ openapi: '3.0.0', info: { title: 'Task API', version: '1.0.0' }, paths: {} });
                const schemas: Record<string, GeneratedSchema> = {};
                 for (const task of tasks) {
                    try {
                        const parsedInfo = parseJSDocComments(task.code || '', task.name || 'unknown');
                        schemas[task.name] = generateSchema(parsedInfo);
                    } catch (parseError) {
                        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                        console.error(`[ERROR] Failed to parse/generate schema for task ${task.name}: ${errorMsg}`);
                        schemas[task.name] = { name: task.name, description: `(Error generating schema: ${errorMsg})`, parameters: { type: 'object' }, returns: { type: 'object' } };
                    }
                }
                const aggregatedSchemas = { info: { title: 'Task API Schemas (Aggregated)', version: '1.0.0' }, tasks: schemas };
                return createResponse(aggregatedSchemas);
            } catch (error) {
                 return createErrorResponse(`Error generating OpenAPI schema: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // Add other GET routes if needed (e.g., /health)
        else {
             return createErrorResponse('GET route not found', [formatLogMessage('ERROR', `GET Route not found: ${pathname}`)], 404);
        }
    }
    // --- Handle other methods (PUT, DELETE, etc. - currently not standard task actions) ---
    else {
         return createErrorResponse(`Unsupported method: ${req.method}`, [], 405);
    }

  } catch (error) {
    // Catch-all for unexpected errors in the main handler
    console.error(`[ERROR] Unhandled error in main handler: ${error instanceof Error ? error.message : String(error)}`);
    return createErrorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`);
  }
});