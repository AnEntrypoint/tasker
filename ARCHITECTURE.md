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
   - wrappedsupabase
   - wrappedopenai
   - wrappedwebsearch
   - wrappedkeystore
   - wrappedgapi

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

## Testing & Deployment

1. Use `taskcode/publish.ts` to publish tasks to the database
2. Use the test script to verify task execution
3. Monitor execution with Supabase logs

## Security Model

- Tasks execute in an isolated QuickJS VM
- Access to external resources is only via authorized service proxies
- Service proxies enforce access controls and rate limits
- Keys are stored securely in the keystore service

## Limitations and Future Improvements

- Full VM state serialization is currently limited (complex objects may not serialize perfectly)
- Timeouts for individual stack runs need careful management
- System monitoring and observability could be enhanced
- Advanced error recovery for failed stack runs 