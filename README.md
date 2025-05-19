# Tasker: Ephemeral Task Execution System

Tasker is a modular task execution system that uses QuickJS for secure, sandboxed JavaScript execution. It features an ephemeral call queueing system that enables tasks to make nested calls to other tasks or external services while maintaining a clean execution state.

## Architecture

### Core Components

1. **QuickJS Executor**: A sandboxed JavaScript environment that executes tasks securely, with support for promises and async/await.

2. **Stack Processor**: Manages the execution of stack runs (ephemeral calls) and maintains proper parent-child relationships.

3. **VM State Manager**: Handles serialization and deserialization of VM state for tasks that are paused during nested calls.

4. **Task Manager**: Publishes tasks to the database and provides information about available tasks.

5. **Service Proxies**: Wrap external services like Google API, OpenAI, Supabase, and web search, providing a secure interface for tasks.

### Database Schema

The system uses two primary tables to track execution:

- **task_runs**: Persistent records of task executions, storing inputs, results, and logs.
- **stack_runs**: Ephemeral records for nested calls within tasks, automatically cleaned up when execution completes.

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