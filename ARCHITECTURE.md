# Tasker Architecture

## Overview

Tasker is a modular content generation system using QuickJS for secure, sandboxed task execution. The system follows an asynchronous, database-driven execution model where tasks are broken down into individual "slices" that can be processed independently, allowing for complex nested tasks without hitting edge function execution limits.

## Key Components

### Database Schema

The system uses the following tables:

1. **task_functions**: Stores task definitions (code, name, description)
2. **task_runs**: Tracks overall task execution (parent-level tracking)
3. **stack_runs**: Stores individual execution slices
4. **keystore**: Securely stores API keys and other secrets

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

## QuickJS Executor

The QuickJS executor creates an isolated JavaScript environment for each task. Key features include:
- Standardized `__saveEphemeralCall__` helper function
- Fixed promise handling for ephemeral calls
- Handle tracking and cleanup with activeHandles array
- Improved error handling in critical functions
- Try/catch blocks to prevent uncaught exceptions in VM callback functions
- Enhanced memory management to prevent QuickJSUseAfterFree errors
- Fixed parent ID tracking and propagation

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