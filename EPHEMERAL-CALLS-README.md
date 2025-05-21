# Ephemeral Call Queueing System

This document describes how to implement and use the ephemeral call queueing system for handling nested task execution in Tasker.

## Overview

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

## Architecture

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

## Common Issues

- **VM State Serialization**: Ensure VM state is properly serialized and deserialized
- **Promise Handling**: Make sure promises are correctly handled in the QuickJS environment
- **Stack Processor Timing**: The stack processor might need to wait for async operations to complete
- **Database Indexes**: Verify indexes are set up for efficient querying of stack runs

## Best Practices

1. Always use async/await in task functions
2. Keep task execution time reasonable
3. Handle errors properly in nested calls
4. Use the task API to check status and retrieve results 