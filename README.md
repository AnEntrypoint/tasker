# Tasker: Ephemeral Task Execution System

Tasker is a modular task execution system that uses QuickJS for secure, sandboxed JavaScript execution. It features an ephemeral call queueing system that enables tasks to make nested calls to other tasks or external services while maintaining a clean execution state.

## Overview

Tasker implements a hierarchical task execution system with persistent task runs and ephemeral stack runs. This architecture enables complex nested workflows with pause/resume capabilities, allowing tasks to execute for extended periods without hitting edge function timeouts.

The ephemeral call queueing system allows tasks to make nested calls to other tasks and services in a way that:

1. Returns immediately to the caller with a task run ID
2. Preserves VM state during nested calls
3. Processes nested calls sequentially
4. Provides status tracking and result retrieval

This approach solves several problems:

- Edge function timeout limitations
- Complex nested call chains
- State preservation between calls
- Reliable execution with retry capability

The GAPI Sleep-Resume feature demonstrates a pattern where:

1. A QuickJS task makes a GAPI API call
2. The QuickJS VM is suspended while the API call is processed
3. The VM state is saved to the database with a stack run
4. The GAPI API call completes
5. The VM is resumed with the API call result
6. The task processes and returns the domain list

The scripts in this repository provide solutions to:
- Execute the GAPI task through the ephemeral call queueing system
- Process any suspended GAPI calls when needed
- Display the Google Workspace domain list as a result

The ephemeral call queueing system allows tasks to make nested calls to other tasks without hitting edge function timeout limits by:

1. Saving VM state when a nested call is made
2. Creating stack run records in the database
3. Returning immediately to the caller
4. Processing stack runs sequentially with the stack processor
5. Resuming parent tasks when child tasks complete

The GAPI service is implemented as a Supabase Edge Function that provides access to Google APIs like Gmail and Admin Directory. The implementation includes token caching to avoid repeated JWT authentication, which is CPU-intensive and can cause resource limit errors in Edge Functions.

This document explains how to properly integrate with Google API (GAPI) services in the Tasker system, which uses QuickJS for secure, sandboxed task execution.

## Key Components

### Database Schema

The system uses the following tables:

1. **task_functions**: Stores task definitions (code, name, description)
2. **task_runs**: Tracks overall task execution (parent-level tracking)
3. **stack_runs**: Stores individual execution slices
4. **keystore**: Securely stores API keys and other secrets

The system uses two primary tables to track execution:

- **task_runs**: Persistent records of task executions, storing inputs, results, and logs.
- **stack_runs**: Ephemeral records for nested calls within tasks, automatically cleaned up when execution completes.

### Edge Functions

1. **/tasks**: Entry point for task execution
   - Creates a task_run record
   - Creates initial stack_run record
   - Returns immediately with a taskRunId
   
2. **/quickjs-executor**: Processes individual stack_run records
   - Initializes QuickJS VM
   - Executes the task code
   - Handles state serialization/deserialization
   - Manages suspension/resumption for nested calls

3. **Wrapped Services**: Proxies for external APIs
   - wrappedsupabase: Database operations
   - wrappedopenai: OpenAI API access
   - wrappedwebsearch: Web search functionality
   - wrappedkeystore: Secure key/value storage
   - wrappedgapi: Google API access

## Execution Flow

1. Client calls `/tasks` endpoint with taskName and input
2. `/tasks` creates a task_run record and an initial stack_run record
3. Database trigger calls `/quickjs-executor` with stack_run ID
4. QuickJS executor processes the stack_run:
   - If the task completes directly, the result is stored and status updated
   - If the task makes a nested call (e.g., to OpenAI), the VM is suspended:
     - The VM state is serialized and stored
     - A new child stack_run is created for the nested call
     - Parent stack_run is marked as suspended
5. Database triggers ensure processing continues:
   - When a nested call completes, its parent is automatically resumed
   - The pattern repeats for any depth of nesting

## VM State Management

The system serializes VM state between execution slices, capturing:
- Current task code
- Input parameters
- Execution context (call site information)
- Global state (when necessary)

This allows long-running tasks to be broken into manageable chunks that fit within edge function limits.

### VM State Manager Improvements

The VM State Manager has been enhanced with:
- Proper handling of parent_stack_run_id and parent_task_run_id
- Verification that parent_task_run_id exists before setting it
- Fixed foreign key constraint errors in stack_runs table

## Stack Processor

The stack processor is responsible for processing individual stack runs. It has been improved with:
- Better mock responses for service integrations
- Enhanced domain list functionality with detailed mocks
- Improved error handling, result extraction, and database operation resilience
- Better checking for parent/child relationships between stack runs
- Enhanced logging for easier troubleshooting
- Automatic triggering of the next pending stack run

The stack processor in `supabase/functions/stack-processor/index.ts` processes pending stack runs by:

- Finding and processing pending stack runs
- Executing tasks or service calls
- Updating stack run status
- Resuming parent stack runs with results from children
- Chaining to the next pending run

## QuickJS Executor

The QuickJS executor creates an isolated JavaScript environment for each task. Key features include:
- Standardized `__saveEphemeralCall__` helper function
- Fixed promise handling for ephemeral calls
- Handle tracking and cleanup with activeHandles array
- Improved error handling in critical functions
- Try/catch blocks to prevent uncaught exceptions in VM callback functions
- Enhanced memory management to prevent QuickJSUseAfterFree errors
- Fixed parent ID tracking and propagation

The QuickJS executor in `supabase/functions/quickjs/index.ts` creates an isolated JavaScript environment for task execution. It needs to:

- Intercept calls to `tools.tasks.execute`
- Save VM state when a nested call is encountered
- Insert a record into the `stack_runs` table
- Resume execution when the nested call completes

## Task Development

Tasks are JavaScript modules with a standard export pattern:

```javascript
/**
 * Task description
 * @param {object} input - Input parameters
 * @returns {object} - Task output
 */
export async function runTask(input, tools) {
  // Task implementation
  // Use tools.* for accessing services
  return { result: "Success" };
}
```

### Available Services

Tasks can access the following services through the `tools` object:

- **tools.supabase**: Database operations
- **tools.openai**: AI content generation
- **tools.websearch**: Web search via DuckDuckGo
- **tools.keystore**: Secure key/value storage
- **tools.gapi**: Google API access
- **tools.log**: Logger for tracking execution
- **tools.tasks**: Execute other tasks

## Security Model

- Tasks execute in an isolated QuickJS VM
- Access to external resources is only via authorized service proxies
- Service proxies enforce access controls and rate limits
- Keys are stored securely in the keystore service

## Database Triggers

The system uses database triggers to process stack runs:

```sql
CREATE OR REPLACE FUNCTION process_next_stack_run() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        PERFORM extensions.http_post(
            CONCAT(current_setting('app.settings.supabase_url', TRUE), '/functions/v1/quickjs'),
            jsonb_build_object('stackRunId', NEW.id),
            'application/json',
            jsonb_build_object(
                'Authorization', concat('Bearer ', current_setting('app.settings.service_role_key', TRUE)),
                'Content-Type', 'application/json'
            ),
            60000 -- 60s timeout
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER process_stack_run_insert
AFTER INSERT ON stack_runs
FOR EACH ROW
EXECUTE FUNCTION process_next_stack_run();
```

A database trigger is set up to call the stack processor when a new stack run is inserted:

```sql
CREATE OR REPLACE FUNCTION notify_stack_processor() RETURNS TRIGGER AS $$
BEGIN
  PERFORM http_post(
    'http://127.0.0.1:8000/functions/v1/stack-processor',
    jsonb_build_object('trigger', 'process-next'),
    'application/json'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stack_run_insert_trigger
AFTER INSERT ON stack_runs
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION notify_stack_processor();
```

## Testing & Deployment

1. Use `taskcode/publish.ts` to publish tasks to the database
2. Use the test scripts to verify task execution
3. Monitor execution with Supabase logs and database queries

## Future Improvements

1. **Stack Processor Enhancements**:
   - More sophisticated stack run chaining
   - Better validation of args between parent and child calls
   - More explicit state management between calls

2. **Database Security and Access**:
   - Review permissions for stack_runs and task_runs tables
   - Add dedicated API endpoints for monitoring stack run status
   - Improve database migration tools for table schema consistency

3. **Memory Management**:
   - Further improve handle tracking and disposal in QuickJS
   - Add periodic garbage collection during long-running tasks
   - Implement more sophisticated tracking of QuickJS handles

4. **Testing Infrastructure**:
   - Create automated tests for different ephemeral call patterns
   - Add integration tests for full task chains
   - Implement more comprehensive logging and monitoring 

Add more robust error handling and retries for transient API failures
Implement metrics and alerts for GAPI call performance and failures
Optimize the monitoring process to reduce database load
Add support for more Google API services in the direct processor

## Architecture

Tasker is a modular content generation system using QuickJS for secure, sandboxed task execution. The system follows an asynchronous, database-driven execution model where tasks are broken down into individual "slices" that can be processed independently, allowing for complex nested tasks without hitting edge function execution limits.

The system consists of the following components:

### 1. QuickJS Executor

The QuickJS executor in `supabase/functions/quickjs/index.ts` creates an isolated JavaScript environment for task execution. It needs to:

- Intercept calls to `tools.tasks.execute`
- Save VM state when a nested call is encountered
- Insert a record into the `stack_runs` table
- Resume execution when the nested call completes

### 2. Database Tables

The system uses two main tables:

**stack_runs**
```sql
CREATE TABLE stack_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_task_run_id UUID,
  service_name TEXT NOT NULL,
  method_name TEXT NOT NULL,
  args JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  result JSONB,
  error TEXT,
  vm_state BYTEA,
  waiting_on_stack_run_id UUID
);

CREATE INDEX idx_stack_runs_status ON stack_runs(status);
CREATE INDEX idx_stack_runs_created_at ON stack_runs(created_at);
CREATE INDEX idx_stack_runs_parent_task_run_id ON stack_runs(parent_task_run_id);
```

**task_runs**
```sql
CREATE TABLE task_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_name TEXT NOT NULL,
  input JSONB,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  result JSONB,
  error TEXT,
  logs JSONB[]
);

CREATE INDEX idx_task_runs_status ON task_runs(status);
CREATE INDEX idx_task_runs_created_at ON task_runs(created_at);
```

### 3. Stack Processor

The stack processor in `supabase/functions/stack-processor/index.ts` is responsible for:

- Processing one stack run at a time
- Fetching the next pending stack run from the database
- Executing the appropriate service method
- Updating the stack run record with the result
- Looking for runs waiting on this stack run and resuming them

### 4. Database Triggers

A database trigger is set up to call the stack processor when a new stack run is inserted:

```sql
CREATE OR REPLACE FUNCTION notify_stack_processor() RETURNS TRIGGER AS $$
BEGIN
  PERFORM http_post(
    'http://127.0.0.1:8000/functions/v1/stack-processor',
    jsonb_build_object('trigger', 'process-next'),
    'application/json'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stack_run_insert_trigger
AFTER INSERT ON stack_runs
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION notify_stack_processor();
```

### 5. Task API

The task API in `supabase/functions/tasks/index.ts` provides endpoints for:

- Executing tasks
- Checking task status
- Retrieving task results
- Listing available tasks

### Core Components

1. **QuickJS Executor**: A sandboxed JavaScript environment that executes tasks securely, with support for promises and async/await.

2. **Stack Processor**: Manages the execution of stack runs (ephemeral calls) and maintains proper parent-child relationships.

3. **VM State Manager**: Handles serialization and deserialization of VM state for tasks that are paused during nested calls.

4. **Task Manager**: Publishes tasks to the database and provides information about available tasks.

5. **Service Proxies**: Wrap external services like Google API, OpenAI, Supabase, and web search, providing a secure interface for tasks.

## Implementation Steps

### 1. QuickJS VM State Management

First, implement VM state management in the QuickJS executor:

```typescript
// In supabase/functions/quickjs/index.ts

// Save VM state when a nested call is encountered
function saveVMState(stackRunId: string, vmState: Uint8Array): Promise<void> {
  // Update the stack run record with VM state
  return supabaseClient
    .from('stack_runs')
    .update({ vm_state: vmState })
    .eq('id', stackRunId);
}

// Resume VM execution from saved state
function resumeVMFromState(vmState: Uint8Array): Promise<any> {
  // Create a new VM with the saved state
  const { vm, context } = createVMFromState(vmState);
  
  // Execute the VM until completion
  return executeVM(vm, context);
}

// Create a proxy for tools.tasks.execute
function createTasksExecuteProxy(taskRunId: string) {
  return async function(taskName: string, input: any) {
    // Create a new stack run record
    const stackRun = await supabaseClient
      .from('stack_runs')
      .insert({
        parent_task_run_id: taskRunId,
        service_name: 'tasks',
        method_name: 'execute',
        args: [taskName, input],
        status: 'pending'
      })
      .select()
      .single();
    
    // Get the stack run ID
    const stackRunId = stackRun.data.id;
    
    // Save the VM state
    await saveVMState(stackRunId, getVMState());
    
    // Return a promise that will be resolved when the stack run completes
    return new Promise((resolve, reject) => {
      // Update the stack run to wait on the nested call
      supabaseClient
        .from('stack_runs')
        .update({ 
          status: 'waiting',
          waiting_on_stack_run_id: stackRunId 
        })
        .eq('id', taskRunId);
    });
  };
}
```

### 2. Stack Processor Implementation

Next, implement the stack processor:

```typescript
// In supabase/functions/stack-processor/index.ts

// Process the next pending stack run
async function processNextStackRun() {
  // Get the next pending stack run
  const { data, error } = await supabaseClient
    .from('stack_runs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  
  if (error || !data) {
    console.log('No pending stack runs found');
    return;
  }
  
  const stackRun = data;
  
  // Update the stack run status to processing
  await supabaseClient
    .from('stack_runs')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', stackRun.id);
  
  try {
    // Execute the service method
    const result = await executeServiceMethod(
      stackRun.service_name,
      stackRun.method_name,
      stackRun.args
    );
    
    // Update the stack run with the result
    await supabaseClient
      .from('stack_runs')
      .update({ 
        status: 'completed', 
        result, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', stackRun.id);
    
    // Look for runs waiting on this one
    await resumeWaitingRuns(stackRun.id);
  } catch (error) {
    // Update the stack run with the error
    await supabaseClient
      .from('stack_runs')
      .update({ 
        status: 'failed', 
        error: error.message, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', stackRun.id);
  }
}

// Resume runs waiting on a completed stack run
async function resumeWaitingRuns(stackRunId) {
  // Get all runs waiting on this one
  const { data, error } = await supabaseClient
    .from('stack_runs')
    .select('*')
    .eq('waiting_on_stack_run_id', stackRunId);
  
  if (error || !data || data.length === 0) {
    return;
  }
  
  // For each waiting run, resume execution
  for (const waitingRun of data) {
    // Get the result of the completed run
    const { data: completedRun } = await supabaseClient
      .from('stack_runs')
      .select('result')
      .eq('id', stackRunId)
      .single();
    
    // Resume the VM with the saved state
    if (waitingRun.vm_state) {
      try {
        const result = await resumeVMFromState(waitingRun.vm_state, completedRun.result);
        
        // Update the waiting run with the result
        await supabaseClient
          .from('stack_runs')
          .update({ 
            status: 'completed', 
            result, 
            updated_at: new Date().toISOString(),
            waiting_on_stack_run_id: null
          })
          .eq('id', waitingRun.id);
      } catch (error) {
        // Update the waiting run with the error
        await supabaseClient
          .from('stack_runs')
          .update({ 
            status: 'failed', 
            error: error.message, 
            updated_at: new Date().toISOString(),
            waiting_on_stack_run_id: null
          })
          .eq('id', waitingRun.id);
      }
    }
  }
}
```

### 3. Task API Implementation

Finally, implement the task API:

```typescript
// In supabase/functions/tasks/index.ts

// Execute a task
async function executeTask(taskName, input) {
  // Create a task run record
  const { data, error } = await supabaseClient
    .from('task_runs')
    .insert({
      task_name: taskName,
      input,
      status: 'queued'
    })
    .select()
    .single();
  
  if (error) {
    throw new Error(`Failed to create task run: ${error.message}`);
  }
  
  const taskRunId = data.id;
  
  // Create a stack run to execute the task
  await supabaseClient
    .from('stack_runs')
    .insert({
      parent_task_run_id: taskRunId,
      service_name: 'tasks',
      method_name: 'execute',
      args: [taskName, input],
      status: 'pending'
    });
  
  // Return the task run ID
  return {
    taskRunId,
    status: 'queued'
  };
}

// Get task status
async function getTaskStatus(taskRunId) {
  const { data, error } = await supabaseClient
    .from('task_runs')
    .select('*')
    .eq('id', taskRunId)
    .single();
  
  if (error) {
    throw new Error(`Failed to get task status: ${error.message}`);
  }
  
  return data;
}
```

Fix Stack Processor:
   ```bash
   deno run --allow-read --allow-write fix-stack-processor.ts
   deno run --allow-read --allow-write diff-stack-processor.ts
   ```
   Review the changes and apply them:
   ```bash
   mv supabase/functions/stack-processor/index.ts supabase/functions/stack-processor/index.ts.bak
   mv supabase/functions/stack-processor/index.fixed.ts supabase/functions/stack-processor/index.ts
   ```

Run Direct GAPI Processor to clear any backlog:
   ```bash
   deno run -A process-direct-gapi.ts
   ```

Set Up GAPI Monitor for continuous monitoring:
   ```bash
   mkdir -p logs
   deno run -A gapi-monitor.ts
   ```

Configure Cron Job for automated processing:
   ```bash
   chmod +x cron-gapi-monitor.sh
   ```
   Add to crontab (runs every 5 minutes):
   ```
   */5 * * * * /path/to/tasker/cron-gapi-monitor.sh >> /path/to/tasker/logs/cron.log 2>&1
   ```

## Testing

To test the ephemeral call queueing system:

1. Create a simple task that makes nested calls
2. Execute the task and get the task run ID
3. Poll for task status until it completes
4. Use the check-stack-runs.js script to monitor stack runs

Example test task:

```javascript
/**
 * Test task that makes nested calls
 * @param {Object} input - Input parameters
 * @param {number} input.depth - How many levels of nested calls to make
 * @returns {Object} Results with timing information
 */
export default async function nestedCallsTest(input) {
  const startTime = new Date();
  console.log(`Starting nested calls test at depth ${input.depth}`);
  
  const result = {
    depth: input.depth,
    startTime: startTime.toISOString()
  };
  
  // Make a nested call if depth > 0
  if (input.depth > 0) {
    console.log(`Making nested call at depth ${input.depth}`);
    
    // This should be intercepted by the ephemeral call mechanism
    const nestedResult = await tools.tasks.execute("nested-calls-test", {
      depth: input.depth - 1
    });
    
    // Add the nested result
    result.nestedResult = nestedResult;
  }
  
  // Record completion time
  const endTime = new Date();
  result.endTime = endTime.toISOString();
  result.durationMs = endTime - startTime;
  
  return result;
}
```

## Debugging

To debug the ephemeral call system:

1. Check stack_runs table for pending or failed runs
2. Examine VM state storage and retrieval
3. Verify the stack processor is being triggered
4. Monitor database triggers and logs

Check QuickJS logs for VM execution issues
Monitor stack processor logs for processing errors
Examine database tables to track execution flow
Use database queries to find stuck or failed runs

## Common Issues

- **VM State Serialization**: Ensure VM state is properly serialized and deserialized
- **Promise Handling**: Make sure promises are correctly handled in the QuickJS environment
- **Stack Processor Timing**: The stack processor might need to wait for async operations to complete
- **Database Indexes**: Verify indexes are set up for efficient querying of stack runs

### 1. Stuck Tasks

Tasks may appear to get "stuck" in the execution pipeline, leading to:
- Tasks never completing (staying in "running" state)
- CPU time limit errors from accumulated polling
- Resource exhaustion

#### Diagnosis

- Tasks never progress beyond the "running" state
- Records in stack_runs table remain in "pending" status
- VM state is not being saved or restored properly

#### Root Causes

- Stack processor not running or not responding
- Database trigger not functioning
- VM state not being properly saved
- Missing database trigger
- Stack processor not properly handling pending runs
- Database access permissions issues

#### Diagnostic Tools

**Detect Stuck Tasks**:
```bash
deno run -A detect-stuck-tasks.ts
```

**Test Stack Processor Trigger**:
```bash
deno run -A check-stack-processor-trigger.ts
```

**Non-Polling GAPI Test**:
```bash
deno run -A test-gapi-no-polling.ts
```

#### Solutions

- Check if the stack processor is responsive
- Verify database trigger installation using `check-and-fix-trigger.ts`
- Fix database connectivity issues (often the primary cause)
- Ensure proper promise handling in QuickJS executor
- Implement proper timeout handling in all async operations
- Use progressive timeouts for status checks (increase interval over time)

### 2. Google API (GAPI) Issues

Google API access often results in CPU time limit errors in Edge Functions due to the computationally expensive JWT authentication process.

#### Symptoms

- `CPU time soft limit reached`
- `early termination has been triggered`
- `connection closed before message completed`
- `exit 137` (Out of memory error)

#### Root Cause

Google's JWT authentication process requires asymmetric cryptography operations that exceed Supabase Edge Function CPU limits.

#### Solutions

1. **Use Token Caching**: Implement aggressive token caching to minimize authentication operations
2. **Use Direct API Implementations**: Bypass the SDK abstraction for performance-critical operations
3. **Always use "my_customer"**: For Admin SDK operations, always use the string "my_customer" instead of email addresses
4. **Potential Architectural Solutions**:
   - Create a standalone service outside of Supabase for Google API authentication
   - Use a serverless platform with higher CPU/memory limits
   - Pre-generate tokens externally and store them in Supabase Keystore
   - For browser applications, use Google Identity Platform directly on the client side

### 3. QuickJS Promise Handling

Improper handling of promises in QuickJS is a common source of issues.

#### Symptoms

- Tasks get stuck at await points
- Promises never resolve
- VM state is not saved correctly

#### Root Causes

- QuickJS requires explicit job processing for promises
- Missing executePendingJob calls
- Improper bridging between host promises and VM promises

#### Solutions

1. **Always Use Async/Await** for asynchronous operations in tasks
2. **Properly Handle Promise Errors** with try/catch blocks
3. **Avoid Missing Await** when calling async functions
4. **Process Pending Jobs** properly in the QuickJS executor:

```typescript
// Process all pending jobs until none remain
function processJobs(rt) {
  let jobsProcessed = 0;
  let res;
  do {
    res = rt.executePendingJob();
    if (res !== null) {
      jobsProcessed++;
    }
  } while (res !== null);
  return jobsProcessed;
}
```

### 4. Database Connectivity Issues

Database connectivity problems are often at the root of stuck tasks and other issues.

#### Symptoms

- 404 errors when trying to access database tables
- Cannot perform database operations needed for task execution
- Tasks get stuck in "running" state indefinitely

#### Diagnostic Approach

Use the `test-db-connection.ts` script to verify Supabase connection:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'http://127.0.0.1:8000';
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 'your-service-role-key';

// Create client with explicit options
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});

// Test connection
const { data, error } = await supabase.from('task_runs').select('count(*)');
if (error) {
  console.error('Connection error:', error);
} else {
  console.log('Connection successful:', data);
}
```

#### Solutions

- Check Supabase project configuration and ensure database access is properly set up for edge functions
- Verify that environment variables are correctly set (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
- Ensure the service role key has proper permissions for the required tables
- Check for any network restrictions that might be blocking access

## Best Practices

1. Always use async/await in task functions
2. Keep task execution time reasonable
3. Handle errors properly in nested calls
4. Use the task API to check status and retrieve results 

Task Design
   - Make tasks modular and focused on specific functions
   - Use nested task calls for complex workflows
   - Handle errors properly to ensure parent tasks can recover

Performance
   - Keep individual task steps small and focused
   - Use asynchronous operations where possible
   - Monitor stack run counts to avoid excessive nesting

Development Testing
   - Use the `npm run ephemeral` command to test the system
   - Check task logs for execution flow issues
   - Monitor the `stack_runs` table during development

Always Use Array Path Format: When calling GAPI methods, always use array path format for method names:

```javascript
// GOOD:
const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [args]);

// AVOID:
const result = await context.tools.gapi.admin.domains.list(args);
```

Use the Standard Helper Module:

```javascript
// Load the helper
const gapiHelper = await context.tasks.require("../shared/gapi-helper");

// List domains
const domains = await gapiHelper.listDomains(context, { customer: "my_customer" });

// List Gmail messages
const messages = await gapiHelper.listGmailMessages(context, { 
  userId: "me", 
  q: "subject:important" 
});
```

Add Robust Error Handling:

```javascript
try {
  const domains = await gapiHelper.listDomains(context, { customer: "my_customer" });
  if (!domains.success) {
    console.error(`Error listing domains: ${domains.error}`);
    return { success: false, error: domains.error };
  }
  
  // Process successful result
  return { success: true, domains: domains.domains };
} catch (error) {
  console.error(`Unexpected error: ${error.message}`);
  return { success: false, error: error.message };
}
```

## Task Runs vs Stack Runs

### Task Runs (Persistent)
- Come from outside the system (user-initiated)
- Stored in the `task_runs` table permanently
- Contain complete records of execution including results from all nested calls
- Maintain full history for auditing and analysis

### Stack Runs (Ephemeral)
- Represent nested module calls made during task execution
- Temporarily stored in the `stack_runs` table
- Processed asynchronously by the stack processor
- Removed after adding their results to the parent task run
- Enable pause/resume for complex nested workflows

## Architecture Components

### 1. QuickJS Sandbox
- Provides isolated JavaScript execution environment
- Manages VM state serialization/deserialization
- Handles async operations using Asyncify support
- Enables pause/resume for long-running tasks

### 2. Stack Processor
- Processes stack runs asynchronously
- Executes nested task calls when parent task pauses
- Updates parent with results when child tasks complete
- Manages the tree-like execution structure

### 3. Database Tables
- `task_runs`: Stores permanent record of task executions
- `stack_runs`: Temporarily stores nested call state
- Database triggers for processing new stack runs

### 4. Service Proxies
- Allow tasks to access external services
- Include Supabase, OpenAI, web search, and other tools
- Trap method calls to handle pause/resume

## Execution Flow

1. **Task Initiation**
   - Client calls the `/tasks` endpoint with task name and parameters
   - System creates a persistent `task_run` record
   - QuickJS VM is initialized for execution
   - Client receives a task run ID immediately

2. **Task Execution**
   - QuickJS executes the task code
   - Task may call other tasks or services

3. **Nested Call Handling**
   - When a task calls another task or service method:
     - Current VM state is saved
     - A record is inserted into `stack_runs` table
     - Parent task execution pauses
     - Database trigger calls stack processor

4. **Stack Processing**
   - Stack processor identifies the type of call
   - For task calls: initializes a new QuickJS VM with task code
   - For service calls: executes the service method directly
   - When complete, updates `stack_runs` with result

5. **Resumption**
   - When child execution completes, parent is resumed
   - Stack processor updates parent's stack run with result
   - Parent VM is rehydrated with saved state plus result
   - Execution continues from the exact point it paused

6. **Completion**
   - When task completes, result is stored in `task_runs`
   - Stack runs are cleaned up after adding their results to parent
   - Client can poll `/tasks/status/{taskRunId}` for results

## Implementation Details

### QuickJS VM Integration

The QuickJS VM provides a sandboxed JavaScript environment that supports:

- Pausing execution at any await point
- Saving complete VM state
- Resuming from saved state
- Handling timeout conditions

Key features:
- Uses Asyncify to transform async code for pause/resume
- Implements a job processing loop for handling async operations
- Provides host function proxies for external service access

### Database Schema

**task_runs table**
- id: UUID primary key
- task_id: Reference to task function
- input: JSON input parameters
- status: 'queued', 'processing', 'completed', 'failed', etc.
- result: JSON result data
- error: JSON error details if failed
- created_at, updated_at: Timestamps

**stack_runs table**
- id: UUID primary key
- parent_run_id: Reference to parent task_run or stack_run
- module_name: Name of service module
- method_name: Name of method being called
- args: JSON array of arguments
- status: 'pending', 'processing', 'completed', 'failed', etc.
- result: JSON result data
- created_at, updated_at: Timestamps

### Triggers and Processing

The system uses database triggers to notify the stack processor when new stack runs are created:

```sql
CREATE OR REPLACE FUNCTION process_next_stack_run() RETURNS TRIGGER AS $$
BEGIN
    -- Only process runs that are in 'pending' status
    IF NEW.status = 'pending' THEN
        -- Send request to the quickjs edge function
        PERFORM extensions.http_post(
            CONCAT(current_setting('app.settings.supabase_url', TRUE), '/functions/v1/quickjs'),
            jsonb_build_object('stackRunId', NEW.id),
            'application/json',
            jsonb_build_object(
                'Authorization', concat('Bearer ', current_setting('app.settings.service_role_key', TRUE)),
                'Content-Type', 'application/json'
            ),
            60000 -- 60s timeout
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to process stack runs
CREATE TRIGGER process_stack_run_insert
AFTER INSERT ON stack_runs
FOR EACH ROW
EXECUTE FUNCTION process_next_stack_run();
```

### Handling Nested Calls

When a task calls another task, the system:

1. Creates a unique stack run ID
2. Saves VM state and call details to `stack_runs`
3. Returns a suspension marker to the VM
4. When the child task completes, resumes parent execution

The VM proxies trap method calls using JavaScript Proxy objects:

```javascript
// Inside VM, tools.tasks.execute is trapped by proxy
const result = await tools.tasks.execute('nested-task', { param: 'value' });
// Execution pauses here until nested task completes
console.log('Resumed with result:', result);
```

## Limitations and Considerations

- Complex nested calls may require careful error handling
- Very deep call hierarchies could impact performance
- Async operations require proper implementation in QuickJS
- Database triggers must be configured correctly for processing

## Example Task

```javascript
/**
 * A sample task demonstrating nested calls
 * @param {Object} input - The input parameters
 * @returns {Object} The task result
 */
export default async function(input, context) {
  console.log("Starting parent task");
  
  // Call a nested task
  const nestedResult = await context.tools.tasks.execute('nested-task', {
    param: input.someParam
  });
  
  // Task execution pauses here until nested-task completes
  console.log("Resumed parent task with nested result:", nestedResult);
  
  // Use result from nested task
  return {
    original: input,
    nested: nestedResult,
    combined: `${input.someParam}-${nestedResult.value}`
  };
}
```

## Conclusion

The ephemeral execution model enables complex, nested task workflows while maintaining performance and reliability. By separating persistent task runs from ephemeral stack runs, the system provides a robust foundation for sophisticated content generation and processing pipelines.

## Current Status

- We've successfully created test tasks and published them to the database
- We've created test scripts to verify the ephemeral call behavior 
- We've implemented a tool to check stack runs in the database

## Findings

1. Currently, tasks are executing synchronously without using the ephemeral call queueing system
2. Calls to `tools.tasks.execute()` in our tasks are not being intercepted by the system
3. The stack_runs table contains various completed and processing entries, but none for our new test tasks
4. No task_runs records are being created for our test task executions

## Possible Issues

1. The QuickJS environment may not be properly intercepting and saving nested calls to the stack_runs table
2. The __saveEphemeralCall__ function in QuickJS might not be correctly implemented or connected
3. The VM state isn't being saved when nested calls are encountered
4. The stack processor might not be processing pending stack runs correctly

## Next Steps

1. **Investigate QuickJS Configuration**:
   - Check the QuickJS executor implementation in supabase/functions/quickjs/index.ts
   - Verify that promise handling is correctly implemented with newAsyncContext()
   - Ensure that tools.tasks.execute is being properly intercepted

2. **Verify Database Setup**:
   - Check the stack_runs and task_runs table schemas
   - Ensure proper indexes are set up for efficient querying

3. **Check Ephemeral Call Implementation**:
   - Verify the implementation of __saveEphemeralCall__ in the QuickJS environment
   - Check how VM state is being saved when nested calls are encountered

4. **Test Stack Processor**:
   - Manually create a stack_run record and see if it gets processed
   - Verify database triggers are set up correctly

## Implementation Tasks

1. **QuickJS Executor Enhancement**:
   - Implement proper interception of tools.tasks.execute calls
   - Ensure VM state is correctly saved when nested calls are encountered

2. **Task Execution Workflow Update**:
   - Modify executeTask function to create task_runs records
   - Return task run IDs immediately rather than waiting for results

3. **Stack Processor Improvements**:
   - Enhance the stack processor to handle nested calls efficiently
   - Implement better error handling and recovery
   
4. **Testing Utilities**:
   - Create additional test tasks with different levels of nesting
   - Implement better monitoring and diagnostic tools

## Recommended Testing Steps

1. Manually create a stack_run record for testing
2. Monitor the stack processor behavior using check-stack-runs.js
3. Validate the ephemeral call queueing through simple test tasks
4. Test more complex nested call patterns once basic functionality is working

## Problem Background

The Tasker system uses an ephemeral call queueing system to handle nested task execution, with each call being saved to the `stack_runs` table and then processed asynchronously. However, GAPI integration has been facing issues with:

1. Stack runs getting stuck in "pending" or "in_progress" states
2. Task runs not being updated with results from completed GAPI calls
3. Parent stack runs not being properly resumed after child GAPI calls complete

## Solution Components

We've created several tools to address these issues:

### 1. Direct GAPI Processor (`process-direct-gapi.ts`)

This script directly processes pending GAPI stack runs by:

- Finding all GAPI stack runs in pending/in_progress state
- Making direct calls to the `wrappedgapi` edge function
- Updating stack runs with results
- Properly updating parent stack runs and task runs

```bash
deno run -A process-direct-gapi.ts
```

### 2. GAPI Monitor (`gapi-monitor.ts`)

A monitoring script that can be scheduled to run periodically to:

- Check for and process pending GAPI stack runs
- Identify and fix stuck task runs
- Make direct GAPI calls as a fallback
- Run continuously for a configured duration
- Log all activities to a file

```bash
deno run -A gapi-monitor.ts
```

### 3. Stack Processor Fix (`fix-stack-processor.ts`)

This script fixes linter errors in the stack processor implementation:

- Updates outdated import URLs
- Fixes method name mismatches
- Corrects parameter type issues
- Creates a patched version of the file

```bash
deno run --allow-read --allow-write fix-stack-processor.ts
```

### 4. Cron Job Script (`cron-gapi-monitor.sh`)

A shell script to automate the monitoring process:

- Runs both the GAPI monitor and direct processor
- Can be scheduled via cron
- Logs all output

## How It Works

1. When a task calls the Google API through the `__callHostTool__` function, an entry is created in the `stack_runs` table with status "pending".

2. The GAPI monitor periodically checks for pending stack runs, processes them by making direct API calls to `wrappedgapi`, and updates the results.

3. For parent stack runs that were waiting on GAPI calls, the monitor updates their VM state and sets them to "ready_to_resume", then triggers the stack processor to resume them.

4. For task runs associated with GAPI calls, the monitor ensures they are updated with the final results.

5. As a fallback, the direct processor is also run periodically to handle any runs that might have been missed by the monitor.

If issues persist:

1. Check the logs in `./logs/gapi-monitor.log`
2. Run the direct processor manually: `deno run -A process-direct-gapi.ts`
3. Verify that the `wrappedgapi` edge function is working: 
   ```bash
   deno run -A check-direct-gapi.ts
   ```
4. Check for any stuck tasks or stack runs: 
   ```bash
   deno run -A check-gapi-stack-runs.ts
   ```

## Key Concepts

1. **Module Calls and VM Suspension**: All service calls (including GAPI) should cause the QuickJS VM to suspend execution, save state, and resume after the call completes. These are not traditional JavaScript promises but rather VM suspension points.

2. **Method Path Arrays**: To reliably call GAPI services, use arrays of path segments rather than property chains. For example, use `["admin", "domains", "list"]` instead of `gapi.admin.domains.list`.

3. **Standard Helpers**: Use the shared helper modules in `taskcode/shared/gapi-helper.js` for consistent and reliable GAPI integration.

### Issue 1: Nested Property Access

**Problem**: The QuickJS environment doesn't properly build method chains when using nested property access like `gapi.admin.domains.list`.

**Solution**: Use the direct `__callHostTool__` approach or the `gapi-helper` module:

```javascript
// Direct approach
const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer: "my_customer" }]);

// Helper module approach
const gapiHelper = await context.tasks.require("../shared/gapi-helper");
const result = await gapiHelper.callGapiService(context, ["admin", "domains", "list"], [{ customer: "my_customer" }]);
```

### Issue 2: Promise Handling

**Problem**: QuickJS requires explicit job processing for promises, which can cause async operations to hang if not handled properly.

**Solution**: Using the VM suspension mechanism instead of direct promises ensures proper handling:

```javascript
// This will create a VM suspension point
const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer: "my_customer" }]);
```

## Task Template

Here's a template for building tasks that integrate with GAPI:

```javascript
/**
 * @task my-gapi-task
 * @description Example task using GAPI integration
 * @param {object} input - Input parameters
 * @returns {object} Result object
 */
module.exports = async function execute(input, context) {
  console.log("Starting my-gapi-task");
  
  try {
    // Load the helper
    let gapiHelper;
    try {
      gapiHelper = await context.tasks.require("../shared/gapi-helper");
    } catch (error) {
      // Use the direct approach if the helper isn't available
      return await directApproach(input, context);
    }
    
    // Call GAPI methods using the helper
    const result = await gapiHelper.callGapiService(
      context,
      ["admin", "domains", "list"],
      [{ customer: input.customer || "my_customer" }]
    );
    
    // Process and return the result
    return {
      success: true,
      data: result
    };
  } catch (error) {
    console.error("Error:", error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

// Fallback approach without helper
async function directApproach(input, context) {
  try {
    const result = await __callHostTool__(
      "gapi", 
      ["admin", "domains", "list"], 
      [{ customer: input.customer || "my_customer" }]
    );
    
    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
```

## Important Notes

1. **VM State**: The QuickJS VM state is preserved between suspensions, allowing for sequential API calls.
2. **Task Context**: The context object provides access to the tools and tasks objects.
3. **Logging**: Use console.log/error in tasks for debugging; these are captured in task logs.
4. **Testing**: Use the provided CLI tools for testing GAPI integration directly.
5. **Service Role**: GAPI calls use the service role key for authentication. 

When working with Google Admin SDK API:

1. **Always use `"my_customer"` (not an email)**: When referring to the customer that the authenticated admin belongs to, always use the string `"my_customer"`, not the admin email address.

2. **Email addresses are not valid customer IDs**: Using an email address as a customer ID will result in a 400 Bad Request error from the Google API.

3. **Customer IDs for multi-tenant situations**: Only use specific customer ID values for multi-tenant situations where you're managing multiple Google Workspace domains.

## Direct Implementation for Performance Critical Operations

For performance-critical operations, the service includes direct implementations that bypass the SDK abstraction. Currently, the following operations have direct implementations:

- `admin.domains.list` - Directly calls the Admin API to list domains

## Status and Management Endpoints

The service includes several status and management endpoints:

- `GET /wrappedgapi/health` - Returns health status and token cache size
- `POST /wrappedgapi` with `method: "checkCredentials"` - Checks if credentials are properly loaded
- `POST /wrappedgapi` with `method: "getTokenInfo"` - Returns info about currently cached tokens
- `POST /wrappedgapi` with `method: "clearTokenCache"` - Clears the token cache (all tokens or specific scope)

## Configuration

The service requires the following configuration in the keystore:

- `global/GAPI_KEY` - Google service account credentials JSON
- `global/GAPI_ADMIN_EMAIL` - Admin email address for domain-wide delegation

Several test scripts are available to test the GAPI service:

- `tests/gapi/test-gapi-health.ts` - Tests health and status endpoints
- `tests/misc/test-keystore.ts` - Tests keystore access for credentials
- `tests/gapi/test-gapi-domains-simple.ts` - Tests domains listing with `"my_customer"`

The implementation includes several optimizations:

1. **Token Caching**: Tokens are cached in memory with expiry tracking
2. **Direct API Implementations**: Performance-critical operations bypass the SDK abstraction
3. **Simplified Authentication**: Uses service account with domain-wide delegation
4. **Error Handling**: Detailed error reporting with full error context
5. **Health Monitoring**: Includes health endpoint for monitoring

These optimizations allow the service to work within Edge Function resource constraints while providing robust access to Google APIs.

## Scripts

### 1. `run-gapi-sleep-resume.js`

One-step script that:
- Executes the gapi-best-practice task
- Polls for task completion or timeout
- Processes any suspended GAPI calls
- Makes a direct GAPI call and displays the domain list
- Provides helpful error handling and fallbacks

Usage:
```
deno run -A run-gapi-sleep-resume.js
```

or using the npm script:
```
npm run gapi:domains-direct
```

### 2. `process-suspended-gapi.ts`

Utility script that:
- Finds any suspended GAPI calls in the stack_runs table
- Processes them with direct GAPI API calls
- Updates parent stack runs that were waiting for results
- Triggers the stack processor to resume
- Always displays the domain list

Usage:
```
deno run -A process-suspended-gapi.ts
```

### 3. `process-direct-gapi.ts`

General-purpose utility that:
- Processes all pending GAPI stack runs with direct API calls
- Updates parent stack runs and task runs with results
- Includes error handling and automatic retries

Usage:
```
deno run -A process-direct-gapi.ts
```

### Stack Runs Table Structure

The stack_runs table contains the following important columns used by this solution:
- `id`: Unique ID for the stack run
- `parent_run_id`: ID of the parent stack run, if any
- `parent_task_run_id`: ID of the associated task run
- `method_path`: Array of strings representing the GAPI method path
- `method_name`: The specific method being called (e.g., "list")
- `status`: Current status (pending, in_progress, completed, failed)
- `vm_state`: JSON representation of the VM state when suspended
- `result`: The result of the GAPI call when completed

### The GAPI Call Suspension Process

1. `gapi-best-practice.js` task calls `__callHostTool__("gapi", ["admin", "domains", "list"], [{ customer }])`
2. The QuickJS VM creates a stack run with status "pending" and suspends execution
3. The VM state is saved to the database, including the current call context
4. The stack processor attempts to process the GAPI call

### Manual Processing

If the stack processor doesn't complete the GAPI call automatically, our utility scripts:
1. Find suspended/pending GAPI calls in the stack_runs table
2. Make direct calls to the GAPI API through the wrappedgapi edge function
3. Update the stack run with the result and status "completed"
4. Update any parent runs that were waiting for the result with the vm_state.last_call_result set
5. Trigger the stack processor to resume execution of parent tasks

## Domain List Display

All scripts display the Google Workspace domain list in a formatted way:

```
=== DOMAIN LIST (4 domains) ===

Domain 1: example.com
   - Primary: Yes
   - Verified: Yes
   - Created: 12/22/2022, 11:46:28 AM

Domain 2: example.org
   - Primary: No
   - Verified: Yes
   - Created: 12/22/2022, 12:00:44 PM

...

=== END OF DOMAIN LIST ===
```

## Usage Options

1. **One-step run with domain list**:
   ```
   npm run gapi:domains-direct
   ```

2. **Traditional GAPI sleep-resume process**:
   ```
   npm run gapi:sleep-resume
   ```
   followed by processing suspended calls:
   ```
   deno run -A process-suspended-gapi.ts
   ```

3. **Direct GAPI call for domain list only**:
   ```
   deno run -A process-direct-gapi.ts
   ```

If you encounter issues:

1. Make sure Supabase Edge Functions are running:
   ```
   npm run gapi:serve
   ```

2. Check for stuck or pending stack runs:
   ```
   deno run -A process-suspended-gapi.ts
   ```

3. Run a direct GAPI call to verify API access:
   ```
   deno run -A process-direct-gapi.ts
   ```

4. Check the logs for error messages

## Components

### 1. VM State Manager

The VM state manager in `supabase/functions/quickjs/vm-state-manager.ts` provides utilities for:

- Generating UUIDs for stack runs
- Capturing VM state before suspension
- Saving stack runs to the database
- Triggering the stack processor
- Restoring VM state from a stack run

### 2. Service Proxy Generator

The proxy generator in `supabase/functions/quickjs/proxy-generator.ts` intercepts service calls by:

- Creating a proxy object that captures method calls
- Special handling for `tasks.execute` calls
- Saving stack runs and returning promises for async operations

### 3. Stack Processor

The stack processor in `supabase/functions/stack-processor/index.ts` processes pending stack runs by:

- Finding and processing pending stack runs
- Executing tasks or service calls
- Updating stack run status
- Resuming parent stack runs with results from children
- Chaining to the next pending run

### 4. Database Tables

The system uses two primary tables:

**stack_runs**: Tracks execution state of function calls
- id: UUID primary key
- parent_stack_run_id: Reference to parent stack run
- parent_task_run_id: Reference to parent task run
- service_name: Service being called (e.g., "tasks")
- method_name: Method being called (e.g., "execute")
- args: JSON array of arguments
- status: Current status ("pending", "processing", "completed", "error", etc.)
- created_at/updated_at: Timestamps
- result: Result of the execution
- error: Error message if failed
- vm_state: Serialized VM state
- resume_payload: Data for resumption
- waiting_on_stack_run_id: Reference to child stack run

**task_runs**: Tracks high-level task execution
- id: UUID primary key
- task_name: Name of the task
- input: Task input parameters
- status: Current status
- created_at/updated_at: Timestamps
- result: Task result
- error: Error information
- waiting_on_stack_run_id: Reference to stack run

## Workflow

1. A task calls `tools.tasks.execute()` to execute another task
2. The proxy generator intercepts the call and:
   - Generates a stack run ID
   - Captures VM state
   - Saves a record to the stack_runs table
   - Triggers the stack processor
   - Returns a promise that will be resolved later

3. The stack processor:
   - Finds the oldest pending stack run
   - Updates its status to "processing"
   - Executes the requested operation (task or service call)
   - Updates the stack run with the result
   - Marks any parent stack runs as ready to resume
   - Chains to the next pending run

4. When a task returns to check its result:
   - The task handler checks if the task has completed
   - If complete, returns the result
   - If still processing, returns a status update

## Key Implementation Details

1. **Promise Handling**: The QuickJS executor explicitly processes pending Promise jobs
2. **VM State Capture**: Only essential state is saved to the database
3. **Sequential Processing**: Stack runs are processed one at a time
4. **Parent-Child Relationships**: Stack runs track their parents and waiting status
5. **Trigger-Based Approach**: Stack processor is triggered when new runs are created
6. **Fallback Processing**: Cron job checks for stuck runs

The system can be tested using:
- `test-ephemeral-calls.js`: Tests basic task execution and nested calls
- `check-stack-runs.js`: Monitors stack run status and can trigger processing

If tasks are not using the ephemeral call queueing system:
1. Ensure VM state manager is properly configured
2. Check that proxy generator is intercepting service calls 
3. Verify stack processor is being triggered
4. Check database tables for proper structure
5. Look for errors in function logs

## Understanding QuickJS Promise Execution

QuickJS, unlike browser JavaScript engines or Node.js, doesn't have an implicit event loop that automatically processes pending promise jobs. Instead, promises must be explicitly processed by calling `runtime.executePendingJob()`. This has important implications for asynchronous code execution.

1. **Explicit Job Processing**: In QuickJS, pending promise operations need to be explicitly processed.
2. **Asyncify Bridging**: When a host function returns a promise, QuickJS needs to use asyncify to bridge between the host's promise and the VM's promise.
3. **Promise Resolution**: Promises must be properly awaited and their pending jobs must be processed.

## Best Practices for Promise Handling in Tasks

### 1. Always Use Async/Await for Asynchronous Operations

```javascript
// ✅ Good:
async function runTask(input) {
  const result = await tools.someService.someMethod();
  return { success: true, data: result };
}

// ❌ Bad:
function runTask(input) {
  return tools.someService.someMethod().then(result => {
    return { success: true, data: result };
  });
}
```

### 2. Properly Handle Promise Errors with Try/Catch

```javascript
// ✅ Good:
async function runTask(input) {
  try {
    const result = await tools.someService.someMethod();
    return { success: true, data: result };
  } catch (error) {
    console.error("Error:", error.message);
    return { success: false, error: error.message };
  }
}

// ❌ Bad:
async function runTask(input) {
  const result = await tools.someService.someMethod();  // Unhandled promise rejection if this fails
  return { success: true, data: result };
}
```

### 3. Sequential vs. Parallel Promise Execution

```javascript
// Sequential execution - one after the other
async function sequential() {
  const result1 = await tools.service.method1();
  const result2 = await tools.service.method2();
  return [result1, result2];
}

// Parallel execution - all at once
async function parallel() {
  const promises = [
    tools.service.method1(),
    tools.service.method2()
  ];
  return await Promise.all(promises);
}
```

### 4. Avoid Missing Await

```javascript
// ✅ Good:
async function runTask(input) {
  const result = await tools.someService.someMethod();
  return result;
}

// ❌ Bad:
async function runTask(input) {
  const result = tools.someService.someMethod();  // Missing await!
  return result;  // Returns a promise, not the resolved value
}
```

## How QuickJS Handles Promises in the VM

When using promises in QuickJS:

1. The VM executes your JavaScript code.
2. When an async function or promise is encountered, it creates pending jobs.
3. The VM needs to explicitly process these pending jobs by calling `runtime.executePendingJob()`.
4. When a promise resolves, its `.then()` handlers are queued as pending jobs.
5. The VM processes these jobs to continue execution.

The Tasker system handles this complexity for you by:

1. Using asyncified functions to bridge between host promises and VM promises.
2. Explicitly processing pending jobs after promises are resolved.
3. Properly handling suspended tasks when calling external services.

## Implementation in the Executor

The QuickJS executor in Tasker handles promises by:

1. Creating an async context for the VM.
2. Properly awaiting promise results with `vm.resolvePromise()`.
3. Processing any pending jobs after the promise resolves with `runtime.executePendingJob()`.
4. Handling suspensions and resumptions for nested async calls.

## Example Task with Proper Promise Handling

See the `promise-handling-example.js` task for complete examples of proper promise handling in QuickJS.

To run the example, use the `test-promise-example.ts` script:

```bash
deno run --allow-read --allow-env --allow-net test-promise-example.ts
```

### Issue: Unhandled Promise Rejection

**Cause**: Missing try/catch around await or not handling promise rejections.

**Solution**: Always wrap async operations in try/catch blocks.

### Issue: Promise Result Not Available

**Cause**: Missing await when calling async functions.

**Solution**: Always use await when calling any function that returns a promise.

### Issue: Task Hangs

**Cause**: Pending promise jobs not being processed.

**Solution**: This is handled by the executor, but make sure your async code properly awaits all promises.

### Issue: Promise Resolution in Nested Calls

**Cause**: Complex nested promises can cause issues with job processing.

**Solution**: Use async/await with clean sequential code rather than complex promise chains.

## Further Reading

- [QuickJS Documentation](https://bellard.org/quickjs/quickjs.html)
- [MDN: Using Promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises)
- [MDN: Async/Await](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Asynchronous/Async_await)

## Ephemeral Execution Flow

1. A task is submitted for execution via the tasks API.
2. A `task_run` record is created with status "processing".
3. The task is executed in the QuickJS sandbox.
4. When the task calls another service or task, execution pauses at the await point.
5. A `stack_run` record is created with status "pending" and the VM state is serialized.
6. The stack processor picks up the pending stack run and executes it.
7. When the stack run completes, its result is stored and its parent task is resumed.
8. The parent task continues execution with the result of the nested call.
9. When the parent task completes, the `task_run` record is updated with the final result.
10. Any `stack_run` records are automatically cleaned up.

## Key Features

- **Nested Task Execution**: Tasks can call other tasks, with the parent task pausing until the child task completes.
- **VM State Serialization**: The system can pause and resume task execution at await points.
- **Secure Sandboxing**: Tasks run in a QuickJS sandbox with limited access to the host environment.
- **Service Proxies**: Tasks can securely access external services like Google API through proxies.
- **Task Publishing**: Tasks can be easily published to the database from local JavaScript files.

## Task Creation

Tasks are defined as JavaScript modules with JSDoc comments for documentation. Example:

```javascript
/**
 * @task gapi-list-domains-with-nested
 * @description List all domains for G Suite with nested task call example
 * @param {object} input - Input parameters
 * @param {boolean} [input.includeStats] - Include usage statistics
 * @returns {Object} Domain information
 */
module.exports = async function execute(input, context) {
  // Task implementation
  const authResult = await context.tools.gapi.authenticate("https://example.com/scope");
  const domainsResult = await context.tools.gapi.admin.directory.domains.list({
    customer: input.customer || "my_customer"
  });
  
  // Nested task call
  if (input.includeStats) {
    const stats = await context.tools.tasks.execute("module-diagnostic", {
      checkGlobalScope: true
    });
    
    return {
      domains: domainsResult.domains,
      stats: stats
    };
  }
  
  return { domains: domainsResult.domains };
};
```

## Command-Line Tools

### Task Publisher

Publishes tasks to the database:

```bash
deno run --allow-net --allow-env --allow-read taskcode/publish.ts --all
deno run --allow-net --allow-env --allow-read taskcode/publish.ts --specific module-diagnostic
deno run --allow-net --allow-env --allow-read taskcode/publish.ts --list
```

Or using npm script:

```bash
npm run publish
```

### Task Executor

Executes tasks from the command line:

```bash
deno run --allow-net --allow-env --allow-read run-task.ts --task gapi-list-domains-with-nested
deno run --allow-net --allow-env --allow-read run-task.ts --task module-diagnostic --input '{"checkGlobalScope":true}'
deno run --allow-net --allow-env --allow-read run-task.ts --list
```

Or using npm script:

```bash
npm run task -- --list
npm run task -- --task module-diagnostic --input '{"checkGlobalScope":true}'
npm run task -- --task gapi-list-domains-with-nested --poll
```

For more details on using the task executor, see [TASK_EXECUTOR_USAGE.md](TASK_EXECUTOR_USAGE.md).

## System Status

The system successfully implements:

1. **Basic Ephemeral Execution**:
   - Simple tasks run successfully
   - Task runs are saved to database with proper status
   - Results are extracted and returned correctly

2. **Service Integration**:
   - Authentication with services works (e.g., Google API)
   - Service proxies handle method calls and return results
   - Nested service calls are properly chained

3. **VM State Management**:
   - VM state is properly saved and restored
   - Parent/child relationships between stack runs are maintained
   - Results propagate correctly between stack runs

## Additional Documentation

For more detailed information, see:

- [ARCHITECTURE.md](ARCHITECTURE.md) - Detailed system architecture
- [EPHEMERAL_EXECUTION_GUIDE.md](EPHEMERAL_EXECUTION_GUIDE.md) - Comprehensive guide to ephemeral execution
- [QUICKJS_PROMISE_GUIDE.md](QUICKJS_PROMISE_GUIDE.md) - Guide to handling promises in QuickJS
- [TASK_EXECUTOR_USAGE.md](TASK_EXECUTOR_USAGE.md) - Task executor CLI usage

## Prerequisites

1. Make sure you have Deno installed on your system.
2. Set the following environment variables:
   - `SUPABASE_URL`: Your Supabase URL
   - `SUPABASE_ANON_KEY`: Your Supabase anon key

## Usage

You can run the task executor using the `npm run task` command, which is a shortcut for `deno run -A run-task.ts`, with various options:

### List all available tasks

```bash
npm run task -- --list
# or
npm run task -- -l
```

This will show a list of all tasks available in the database.

### Execute a task

```bash
npm run task -- --task <task-name>
# or
npm run task -- -t <task-name>
```

### Execute a task with input parameters

```bash
npm run task -- --task <task-name> --input '{"param1": "value1", "param2": "value2"}'
# or
npm run task -- -t <task-name> -i '{"param1": "value1", "param2": "value2"}'
```

### Execute a task and poll for results

```bash
npm run task -- --task <task-name> --poll
# or
npm run task -- -t <task-name> -p
```

This will execute the task and poll the `task_runs` table for the result.

## Examples

### List all tasks

```bash
npm run task -- --list
```

### Run the module-diagnostic task

```bash
npm run task -- --task module-diagnostic --input '{"checkGlobalScope": true}'
```

### Run the gapi-list-domains task and poll for results

```bash
npm run task -- --task gapi-list-domains-with-nested --poll
```

## Ephemeral Execution

The Tasker system uses an ephemeral execution model, where tasks are executed asynchronously in the background. When you execute a task, you'll receive a task run ID, which you can use to check the status and result of the task.

The task executor will display the task run ID and, if the `--poll` option is specified, will poll the `task_runs` table for the result.

If you encounter any issues:

1. Make sure the Supabase functions are running (`supabase functions serve --no-verify-jwt`).
2. Verify that your environment variables are correctly set.
3. Check that the task exists in the `task_functions` table.
4. Look for any error messages in the logs.

## Troubleshooting

## Testing Strategies

### 1. Graduated Testing Approach

1. Start with the **echo** test type to eliminate Google API issues
2. Use the `detect-stuck-tasks.ts` tool to identify where tasks get stuck
3. Test the database trigger with `check-stack-processor-trigger.ts`
4. Try direct invocation of the stack processor
5. Check database tables for proper schema and triggers

### 2. Testing GAPI Sleep/Resume Functionality

The Tasker system uses a save/sleep/resume mechanism when accessing external services. To test this functionality:

**Standard Task Endpoint Test**:
```bash
npm run gapi:test
```

**Direct Stack Processor Test**:
```bash
npm run gapi:test-direct [testType]
```

Available test types:
- **echo** - Lightweight test that avoids actual API calls (default)
- **customer** - Gets basic customer information from Google Admin SDK
- **info** - Gets directory API information for a specific user

### 3. Avoiding Resource Exhaustion During Testing

To prevent resource exhaustion:
- Avoid excessive polling (use fire-and-forget approach)
- Use the non-polling approach demonstrated in `test-gapi-no-polling.ts`
- For browser-based testing, implement progressive timeouts (increase interval over time)
- Consider using the direct invocation approach for more detailed debugging

## Prevention Best Practices

1. **Proper Error Handling**: Implement comprehensive error handling in tasks and service proxies
2. **Timeouts and Retries**: Add proper timeout handling and retry logic for critical operations
3. **Health Checks**: Implement health check endpoints for monitoring system components
4. **Watchdog Service**: Consider implementing a watchdog service for detecting and recovering stuck tasks
5. **Progressive Polling**: Use progressive polling intervals to avoid resource exhaustion
6. **Token Caching**: Implement aggressive token caching for authentication-heavy services
7. **VM State Management**: Ensure proper VM state serialization and deserialization

## References

- [QuickJS Documentation](https://bellard.org/quickjs/quickjs.html)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Google Identity Platform](https://developers.google.com/identity)