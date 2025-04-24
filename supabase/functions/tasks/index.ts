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

async function handleTaskRoutes(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let pathname = url.pathname;
  let path = pathname.split('/').filter(Boolean);
  const method = request.method;

  // Adjust for Supabase Functions mountpoint prefix: /functions/v1/tasks
  if (path.length >= 3 && path[0] === 'functions' && path[1] === 'v1' && path[2] === 'tasks') {
    // Remove the prefix segments
    path = path.slice(3);
    // Rebuild pathname based on remaining segments
    pathname = '/' + path.join('/');
    if (pathname === '/') pathname = '/';
  }

  console.log(`[INFO] Processing ${method} request to ${pathname}`);
  
  // Task execution route
  if ((pathname === '/tasks' || pathname === '/') && method === 'POST') {
    try {
      const requestBody = await request.clone().json();
      const taskIdentifier = requestBody.taskId || requestBody.id || requestBody.name;
      
      if (!taskIdentifier) {
        return createErrorResponse('No task identifier provided', [formatLogMessage('ERROR', 'No task identifier provided')]);
      }
      
      // Check if task exists in registry
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
        // Execute from database
        const options = {
          debug: Boolean(requestBody.debug),
          verbose: Boolean(requestBody.verbose),
          include_logs: Boolean(requestBody.include_logs)
        };
        return await executeTask(taskIdentifier, requestBody.input || {}, options);
      }
    } catch (error) {
      const errorMsg = `Task execution error: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[ERROR] ${errorMsg}`);
      return createErrorResponse(errorMsg, [formatLogMessage('ERROR', errorMsg)]);
    }
  }
  
  // Schema generation route
  if (path.length === 1 && path[0] === 'schema' && method === 'POST') {
    try {
      const { code } = await request.json();
      if (!code) {
        return createErrorResponse('No code provided for schema generation');
      }
      const schema = await generateSchema(code);
      return createResponse(schema);
    } catch (error) {
      const errorMsg = `Schema generation error: ${error instanceof Error ? error.message : String(error)}`;
      return createErrorResponse(errorMsg);
    }
  }
  
  // Task list route
  if ((path.length === 1 && path[0] === 'list') || (pathname === '/tasks/list') && method === 'GET') {
    try {
      const endpoint = `${SUPABASE_URL}/rest/v1/task_functions`;
      const response = await fetch(`${endpoint}?order=name.asc`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      
      if (!response.ok) {
        return createErrorResponse(`REST API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      return createResponse({
        tasks: data || [],
        count: data?.length || 0,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      return createErrorResponse(`Error listing tasks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Task creation/update route
  if (path.length === 1 && path[0] === 'create' && method === 'POST') {
    try {
      const { name, code, description } = await request.json();
      
      if (!name || !code) {
        return createErrorResponse('Name and code are required for task creation');
      }
      
      const checkResult = await supabaseClient.from('task_functions').select('id').eq('name', name).maybeSingle();
      
      if (checkResult.error && checkResult.error.code !== 'PGRST116') {
        throw new Error(`Database error checking for existing task: ${checkResult.error.message}`);
      }
      
      let result;
      if (checkResult.data) {
        result = await supabaseClient.from('task_functions').update({
          code,
          description: description || `Task ${name}`
        }).eq('id', checkResult.data.id);
      } else {
        result = await supabaseClient.from('task_functions').insert({
          name,
          code,
          description: description || `Task ${name}`
        });
      }
      
      if (result.error) {
        throw new Error(`Database error: ${result.error.message}`);
      }
      
      return createResponse({
        message: `Task ${name} ${checkResult.data ? 'updated' : 'created'} successfully`,
        task: {
          name,
          id: checkResult.data?.id,
          description: description || `Task ${name}`
        }
      });
    } catch (error) {
      return createErrorResponse(`Error creating/updating task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Task deletion route
  if (path.length === 1 && path[0] === 'delete' && method === 'POST') {
    try {
      const { name } = await request.json();
      
      if (!name) {
        return createErrorResponse('Task name is required for deletion');
      }
      
      const result = await supabaseClient.from('task_functions').delete().eq('name', name);
      
      if (result.error) {
        throw new Error(`Database error: ${result.error.message}`);
      }
      
      return createResponse({ message: `Task ${name} deleted successfully` });
    } catch (error) {
      return createErrorResponse(`Error deleting task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // OpenAPI schema route - Refactored
  if (path.length === 1 && path[0] === 'openapi' && method === 'GET') {
    try {
      // 1. Fetch all task functions from the database
      const { data: tasks, error: fetchError } = await supabaseClient
        .from('task_functions')
        .select('name, code, description');

      if (fetchError) {
        throw new Error(`Database error fetching tasks: ${fetchError.message}`);
      }

      if (!tasks || tasks.length === 0) {
        return createResponse({ openapi: '3.0.0', info: { title: 'Task API', version: '1.0.0' }, paths: {} }); // Return empty spec
      }

      // 2. Generate schema for each task
      const schemas: Record<string, GeneratedSchema> = {};
      for (const task of tasks) {
        try {
          // 2a. Parse JSDoc
          const parsedInfo = parseJSDocComments(task.code || '', task.name || 'unknown');
          // 2b. Generate internal schema
          schemas[task.name] = generateSchema(parsedInfo);
        } catch (parseError) {
           // Cast parseError to Error to access message
           const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
           console.error(`[ERROR] Failed to parse/generate schema for task ${task.name}: ${errorMsg}`);
           // Optionally skip this task or add a basic schema entry
           schemas[task.name] = { name: task.name, description: `(Error generating schema: ${errorMsg})`, parameters: { type: 'object' }, returns: { type: 'object' } };
        }
      }

      // 3. Format the aggregated schemas into OpenAPI format
      // NOTE: The `formatSchema` function expects a *single* GeneratedSchema.
      // We need an aggregation step or a different formatting function for multiple tasks.
      // Let's assume `formatSchema` needs modification or we need a new `formatOpenAPI` function.
      // For now, we cannot directly call `formatSchema` with `schemas`.
      // We will just return the raw aggregated schemas for now.
      // TODO: Implement proper OpenAPI aggregation/formatting based on the `formatSchema` capabilities or create a new formatter.

      // Returning raw aggregated schemas (replace with actual OpenAPI formatting later)
      const aggregatedSchemas = { 
          info: { title: 'Task API Schemas (Aggregated)', version: '1.0.0' },
          tasks: schemas 
      };

      // const openapiSchema = await formatSchema(aggregatedSchemas, 'openapi'); // Placeholder for future correct call

      return createResponse(aggregatedSchemas); // Return the raw schemas for now

    } catch (error) {
      return createErrorResponse(`Error generating OpenAPI schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // If no route matched
  return createErrorResponse('Route not found', [formatLogMessage('ERROR', `Route not found: ${url.pathname}`)], 404);
}

serve(async (req: Request, connInfo: ConnInfo): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return createCorsPreflightResponse();
  }
  
  try {
    return await handleTaskRoutes(req);
  } catch (error) {
    console.error(`[ERROR] Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
    return createErrorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`);
  }
});