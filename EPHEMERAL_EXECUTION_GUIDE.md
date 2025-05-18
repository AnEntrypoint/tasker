# Tasker: Ephemeral Task Execution Guide

## Overview

Tasker implements a hierarchical task execution system with persistent task runs and ephemeral stack runs. This architecture enables complex nested workflows with pause/resume capabilities, allowing tasks to execute for extended periods without hitting edge function timeouts.

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

## Best Practices

1. **Task Design**
   - Make tasks modular and focused on specific functions
   - Use nested task calls for complex workflows
   - Handle errors properly to ensure parent tasks can recover

2. **Performance**
   - Keep individual task steps small and focused
   - Use asynchronous operations where possible
   - Monitor stack run counts to avoid excessive nesting

3. **Development Testing**
   - Use the `npm run ephemeral` command to test the system
   - Check task logs for execution flow issues
   - Monitor the `stack_runs` table during development

## Debugging

- Check QuickJS logs for VM execution issues
- Monitor stack processor logs for processing errors
- Examine database tables to track execution flow
- Use database queries to find stuck or failed runs

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