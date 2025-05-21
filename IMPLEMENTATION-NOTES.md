# Ephemeral Call Queueing System - Implementation Notes

This document outlines how the ephemeral call queueing system works in Tasker.

## Overview

The ephemeral call queueing system allows tasks to make nested calls to other tasks without hitting edge function timeout limits by:

1. Saving VM state when a nested call is made
2. Creating stack run records in the database
3. Returning immediately to the caller
4. Processing stack runs sequentially with the stack processor
5. Resuming parent tasks when child tasks complete

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

## Testing

The system can be tested using:
- `test-ephemeral-calls.js`: Tests basic task execution and nested calls
- `check-stack-runs.js`: Monitors stack run status and can trigger processing

## Troubleshooting

If tasks are not using the ephemeral call queueing system:
1. Ensure VM state manager is properly configured
2. Check that proxy generator is intercepting service calls 
3. Verify stack processor is being triggered
4. Check database tables for proper structure
5. Look for errors in function logs 