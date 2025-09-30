# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This is a Gmail search task runner built on Supabase Edge Functions with native Deno execution. The system implements automatic suspend/resume execution with HTTP-based stack processing chains, enabling infinite length tasks without timeouts or memory issues.

### Core Components

**Task Execution Engine**
- `supabase/functions/tasks/` - Main task execution service that submits tasks and triggers stack processing
- `supabase/functions/deno-executor/` - Deno runtime with automatic suspend/resume for external calls
- `supabase/functions/simple-stack-processor/` - Sequential FIFO processor that chains HTTP calls (no polling)

**Service Wrappers**
- `supabase/functions/wrappedgapi/` - Google API integration with service account authentication
- `supabase/functions/wrappedkeystore/` - Key-value store for credentials (Google API keys, admin emails)
- `supabase/functions/wrappedsupabase/` - Database operations proxy
- `supabase/functions/wrappedopenai/` - OpenAI API integration
- `supabase/functions/wrappedwebsearch/` - Web search API integration

**Task Code**
- `taskcode/endpoints/comprehensive-gmail-search.js` - Main Gmail search task implementation
- `taskcode/publish.ts` - Task publishing utility
- `comprehensive-gmail-search-cli.js` - CLI tool for testing the Gmail search

**Development Tools**
- `dev-tools/function-dev-server.js` - Development server for testing individual functions
- `dev-tools/function-tester.js` - Utility for testing edge functions
- `dev-tools/function-debugger.js` - Debugging tools for function development

### Stack Processing Architecture

The system uses HTTP chaining instead of polling with automatic suspend/resume:
1. Task submission triggers simple-stack-processor via HTTP
2. Tasks execute in deno-executor with `__callHostTool__` for external calls
3. External calls create child stack runs and suspend parent with `TASK_SUSPENDED` error
4. Parent stack runs marked as `suspended_waiting_child` until children complete
5. Child completion automatically resumes parent with results via HTTP chain
6. Sequential processing maintained with database locks
7. No `setInterval` polling - pure HTTP chain reaction with causality preservation

### Database Schema

**Core Tables:**
- `task_functions` - Stores published task code and metadata
- `task_runs` - Tracks task execution instances
- `stack_runs` - Individual operation calls in task execution chain
- `keystore` - Credentials storage (Google API keys, etc.)

**Important:** Never reset the database. Clear tables individually:
- `DELETE FROM stack_runs WHERE id > 0;`
- `DELETE FROM task_runs WHERE id > 0;`
- Keep `task_functions` and `keystore` intact

## Development Commands

**Start Infrastructure:**
```bash
supabase start              # Start local Supabase
npm run serve              # Start edge functions server
npm run gmail-search       # Start server and run Gmail search together
```

**Task Testing:**
```bash
npm run test:gmail         # Full Gmail search with concurrency (98 users, 300 results each)
npm run test:gmail-simple  # Simple test (2 users, 1 result each)
npm run test:deno          # Test deno-executor directly
npm run test:stack         # Test simple-stack-processor
npm run gmail-search       # Run concurrently: server + Gmail search CLI
npm run gmail-search:quick # Quick test with small parameters
npm run test:all           # List all available function tests
node comprehensive-gmail-search-cli.js --maxUsersPerDomain 98 --maxResultsPerUser 300
```

**Function Development:**
```bash
npm run dev:function       # Start development server for any function
npm run test:function      # Test individual functions
npm run debug:function     # Debug function execution
npm run dev:gapi           # Development server for wrappedgapi
npm run dev:keystore       # Development server for wrappedkeystore
npm run dev:supabase       # Development server for wrappedsupabase
npm run dev:deno           # Development server for deno-executor
npm run test:gapi          # Test wrappedgapi function
npm run test:keystore      # Test wrappedkeystore function
npm run test:deno          # Test deno-executor function
npm run test:stack         # Test simple-stack-processor function
```

**Task Publishing:**
```bash
npm run publish:task       # Publish comprehensive Gmail search task to database
```

**Debugging:**
```bash
npm run debug:db           # Check database state
npm run debug:logs         # View recent logs
npm run debug:clear        # Clear execution tables (preserves keystore/task_functions)
```

## Critical Development Principles

**Performance Requirements:**
- Never wait more than 5 seconds for any step to run
- Use concurrently for running server and client together
- Client waits for server before running
- Always run the server and client with concurrently to enforce restart

**Testing Principles:**
- Never use mocks or fake data - only test with real working conditions
- Use development tools (`dev-tools/function-tester.js`) instead of curl for debugging
- Always check CLI output properly - We dont want mocks, fakes simulations or fallbacks cause it hides issues
- Test individual functions using `npm run test:function` before integration testing
- Verify complete end-to-end execution with real data before declaring success
- Use `dev-tools/` directory for function development with hot reload
- Development tools provide immediate feedback without full stack execution

**Stack Processing Rules:**
- Stack processor uses HTTP chaining, not polling
- Each process starts the next and exits immediately (fire-and-forget)
- Sequential processing with database locks (no global state)
- External calls via `__callHostTool__` create child stack runs and suspend parent
- Parent tasks marked `suspended_waiting_child` until children complete
- Child completion triggers parent resume with results
- Suspension mechanism preserves causality - parents receive child results before continuing

**Google API Integration:**
- Credentials stored in keystore (GAPI_KEY, GAPI_ADMIN_EMAIL)
- maxUsersPerDomain limited to 500 (Google's API limit)
- Service account authentication with domain impersonation

**Database Management:**
- Clear execution tables individually, never reset entire database
- Preserve task_functions and keystore tables
- Stack runs chain via parent_stack_run_id relationships

**Supabase Integration:**
- All code that uses Supabase should use wrappedsupabase via the service wrappers

**Code Access Principles:**
- Dont make it direct access anything that uses a library or external code of any kind should be used through their single point of reference in their wrapped edge functions
- All external integrations (Google API, Supabase, Keystore) must go through service wrappers
- Direct library calls are prohibited - always use wrapped edge functions for external services

## Task Execution Flow

1. **Submission:** CLI calls `/functions/v1/tasks/execute`
2. **Processing:** Task service creates task_run and triggers simple-stack-processor
3. **Execution:** deno-executor runs task code with `__callHostTool__` for external calls
4. **Suspension:** External calls throw `TASK_SUSPENDED` error with suspension data
5. **Child Creation:** deno-executor creates child stack_run and marks parent `suspended_waiting_child`
6. **Child Processing:** simple-stack-processor processes child stack_run for external API call
7. **Resume:** Child completion triggers parent resume with results via HTTP chain
8. **Continuation:** Parent task continues execution with child results
9. **Chaining:** Process repeats for each external call, maintaining causality

The system processes Gmail searches for 98 users across 4 domains automatically without manual intervention, breaking up work call by call for infinite length tasks.

## Suspension and Resume Mechanism

The core innovation of this system is the automatic suspend/resume capability that enables infinite length tasks:

### How Suspension Works

1. **External Call Detection:** When task code calls `__callHostTool__(serviceName, methodPath, args)`, the deno-executor detects this as an external call
2. **Child Stack Run Creation:** A new child stack_run is created for the external service call
3. **Parent Suspension:** The parent stack_run is marked as `suspended_waiting_child` and linked to the child
4. **Task Suspension:** A `TASK_SUSPENDED` error is thrown with suspension data, immediately stopping task execution
5. **Suspension Response:** The deno-executor returns suspension data to simple-stack-processor instead of continuing

### How Resume Works

1. **Child Processing:** simple-stack-processor processes the child stack_run for the external API call
2. **Child Completion:** When child completes, it triggers parent resume via HTTP chain
3. **Result Injection:** Child results are injected into parent's resume payload
4. **Task Continuation:** Parent task resumes execution with the external call results
5. **Causality Preservation:** Parent receives child results before making subsequent calls

### Key Implementation Details

- **Immediate Suspension:** `__callHostTool__` throws `TASK_SUSPENDED` error to stop execution immediately
- **Nested Response Handling:** simple-stack-processor handles suspension data nested in `result.result`
- **Status Management:** Parent stack runs use `suspended_waiting_child` status while waiting
- **Database Locks:** Task chains use database locks instead of global state for concurrency control
- **HTTP Chaining:** No polling - each completion triggers next operation via HTTP call

This mechanism enables tasks to break up work call by call, allowing for infinite length task execution without timeouts or memory issues.

## Recent Architecture Changes

### Migration to Deno Executor (August 2025)

The system was migrated from QuickJS to native Deno execution for improved performance and reliability:

**Current Architecture:**
- **`supabase/functions/deno-executor/`** - Native Deno task execution runtime
- **`supabase/functions/simple-stack-processor/`** - HTTP-based stack run processing
- **Immediate suspension mechanism:** `__callHostTool__` throws `TASK_SUSPENDED` error for instant task suspension
- **Nested response handling:** simple-stack-processor handles suspension data from deno-executor
- **Database coordination:** Uses database locks for reliable concurrency control

**Suspension Mechanism Improvements:**
1. **Immediate Task Suspension:** When `__callHostTool__` is called, it immediately throws a `TASK_SUSPENDED` error to stop task execution
2. **Proper Error Handling:** deno-executor catches the suspension error and returns suspension data to simple-stack-processor
3. **Nested Response Detection:** simple-stack-processor handles suspension data that may be nested in `result.result`
4. **Status Management:** Parent stack runs are properly marked as `suspended_waiting_child` while waiting for children
5. **Causality Preservation:** Parent tasks receive child results before making subsequent calls

**Current Benefits:**
- **High Performance:** Native Deno execution with optimal resource utilization
- **Excellent Reliability:** Robust error handling and edge case management
- **Clean Architecture:** Streamlined suspension/resume flow
- **Superior Debugging:** Comprehensive logging and error reporting
- **Infinite Length Tasks:** Full support for tasks that break up work call by call

Tasks make external calls via `__callHostTool__` and the system automatically handles suspension, child stack run creation, and parent resume with results.

when testing: 
Verify that the comprehensive Gmail search task executes completely from start to finish without any issues or manual intervention. The verification must confirm that:

1. **Complete End-to-End Execution**: The task progresses through all phases:
   - Domain discovery (admin.domains.list API calls)
   - User enumeration for each domain (admin.users.list API calls) 
   - Gmail message search for each user (gmail.users.messages.list API calls)
   - Message detail retrieval (gmail.users.messages.get API calls)
   - Final result aggregation and storage

2. **Proper Result Generation**: The task produces a complete, non-empty result containing:
   - Domain information with actual data
   - User lists with real user accounts
   - Gmail messages with proper metadata (subject, from, date, snippet)
   - Accurate summary statistics (total domains, users, messages)

3. **Automatic Processing**: The entire workflow operates without manual triggers:
   - Stack processor automatically processes all pending stack runs
   - Suspend/resume mechanism works correctly for all external API calls
   - Parent tasks properly resume after child calls complete
   - Task status updates to "completed" automatically

4. **No Critical Issues**: Identify and fix any problems that prevent complete execution:
   - API calls returning empty results when data should exist
   - Tasks completing prematurely before all steps finish
   - Suspend/resume failures causing execution to halt
   - Result storage issues preventing final output


Do not declare success until you can demonstrate a complete task run that produces meaningful Gmail search results with actual email data from real user accounts across multiple domains. If any step fails or produces empty results when data should exist, diagnose and fix the root cause before proceeding.

## Database Schema Updates

The database schema has been enhanced with recent migrations:

**Recent Additions:**
- `suspended_at` timestamp column for tracking suspension timing
- `resume_payload` column for storing parent task resume data
- `waiting` column to optimize suspended task queries
- `task_locks` table for preventing concurrent execution conflicts

**Migration Files:**
- `006_add_suspended_at_column.sql` - Added suspension timing tracking
- `005_add_resume_payload_column.sql` - Added resume data storage
- `004_add_waiting_column_to_stack_runs.sql` - Added waiting status optimization
- `20250826113115_create_task_locks_table.sql` - Added execution locking mechanism

## FlowState Integration

The project now integrates FlowState library for advanced task state management:

**FlowState Components:**
- `supabase/functions/deno-executor/flowstate-storage.ts` - Custom Supabase storage adapter for FlowState
- Enhanced task execution with FlowState persistence and recovery
- Improved suspend/resume mechanism with state serialization
- Better handling of long-running tasks with state checkpointing

**FlowState Benefits:**
- More reliable task state persistence
- Enhanced error recovery capabilities
- Improved debugging and monitoring
- Better resource management for long-running tasks

## Additional Service Components

**Other Wrapped Services:**
- `supabase/functions/wrappedwebsearch/` - Web search integration wrapper
- `supabase/functions/wrappedopenai/` - OpenAI API integration wrapper
- `supabase/functions/admin-debug/` - Administrative debugging interface

**Task Registry System:**
- `supabase/functions/tasks/registry/` - Task registration and discovery system
- `supabase/functions/tasks/services/` - Database and module generation services
- `supabase/functions/tasks/handlers/` - Task execution handlers

**Development Infrastructure:**
- `dev-tools/` - Hot reload development server and testing tools
- Task code publishing system via `taskcode/publish.ts`

# Core Functionality
- This is a Gmail search task runner built on Supabase Edge Functions with native Deno execution, using HTTP-based stack processing chains instead of polling for automatic suspend/resume execution.
- The codebase should prioritize being small, maintainable, and easy to understand while preserving the ability to break tasks up call by call for infinite length tasks.
- Parent tasks must receive results from child calls before making subsequent calls to maintain proper causality and prevent parallel execution issues.

**Task Registry System:**
- `supabase/functions/tasks/registry/` - Task registration and discovery system
- `supabase/functions/tasks/services/` - Database and module generation services
- `supabase/functions/tasks/handlers/` - Task execution handlers

**Development Infrastructure:**
- `dev-tools/` - Hot reload development server and testing tools
- Task code publishing system via `taskcode/publish.ts`

# Core Functionality
- This is a Gmail search task runner built on Supabase Edge Functions with native Deno execution using FlowState for advanced task state management, using HTTP-based stack processing chains instead of polling for automatic suspend/resume execution.
- The codebase prioritizes being small, maintainable, and easy to understand while preserving the ability to break tasks up call by call for infinite length tasks.
- Parent tasks must receive results from child calls before making subsequent calls to maintain proper causality and prevent parallel execution issues.

# Project Details
- The project uses wrapped edge functions for all external integrations (wrappedgapi, wrappedkeystore, wrappedsupabase, wrappedwebsearch, wrappedopenai) and requires real testing conditions without mocks or simulations.
- Development requires concurrently running server and client with 5-second max wait times, and uses development tools instead of curl for debugging Deno edge functions.
- FlowState library integration provides enhanced task state persistence and recovery capabilities.

## Testing Verification Requirements

When testing Gmail search functionality, verify complete end-to-end execution:

1. **Complete Execution Flow**: Domain discovery → User enumeration → Message search → Detail retrieval → Result aggregation
2. **Non-empty Results**: Must return actual domain data, user accounts, and email messages
3. **Automatic Processing**: No manual intervention required - stack processor handles all suspensions/resumes
4. **Causality Preservation**: Parent tasks receive child results before making subsequent calls
5. **FlowState Integration**: Task state properly persisted and recovered during suspension/resume

## Development Tools Architecture

The `dev-tools/` directory provides specialized utilities for function development:

- **function-dev-server.js**: Starts individual function servers for isolated testing
- **function-tester.js**: Runs automated tests against specific functions
- **function-debugger.js**: Provides debugging capabilities for function execution

These tools replace manual curl operations and provide better integration with the Deno edge function environment.

# Core Functionality
- This is a Gmail search task runner built on Supabase Edge Functions with native Deno execution using FlowState for advanced task state management, using HTTP-based stack processing chains instead of polling for automatic suspend/resume execution.
- The codebase prioritizes being small, maintainable, and easy to understand while preserving the ability to break tasks up call by call for infinite length tasks.
- Parent tasks must receive results from child calls before making subsequent calls to maintain proper causality and prevent parallel execution issues.

# Project Details
- The project uses wrapped edge functions for all external integrations and requires real testing conditions without mocks or simulations.
- Development requires concurrently running server and client with 5-second max wait times, and uses development tools instead of curl for debugging Deno edge functions.
- FlowState library integration provides enhanced task state persistence and recovery capabilities.
