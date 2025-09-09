# Gmail Search Task Runner

A Gmail search task runner built on Supabase Edge Functions with automatic suspend/resume execution for infinite length tasks.

## Overview

This system implements a sophisticated task execution engine that can handle long-running Gmail searches across multiple Google Workspace domains without timeouts or memory issues. The core innovation is an automatic suspend/resume mechanism that breaks up work call by call, enabling infinite length task execution.

## Key Features

- **Automatic Suspend/Resume**: Tasks automatically suspend on external calls and resume with results
- **HTTP-Based Stack Processing**: No polling - pure HTTP chain reaction for task orchestration
- **Infinite Length Tasks**: Break up work call by call to handle unlimited task complexity
- **Real Testing Conditions**: No mocks or simulations - only real working conditions
- **Causality Preservation**: Parent tasks receive child results before making subsequent calls
- **Concurrent Gmail Search**: Process 98+ users across multiple domains automatically

## Architecture

### Core Components

**Task Execution Engine**
- `supabase/functions/tasks/` - Main task execution service that submits tasks and triggers stack processing
- `supabase/functions/deno-executor/` - Deno runtime with automatic suspend/resume for external calls
- `supabase/functions/simple-stack-processor/` - Sequential FIFO processor that chains HTTP calls (no polling)

**Service Wrappers**
- `supabase/functions/wrappedgapi/` - Google API integration with service account authentication
- `supabase/functions/wrappedkeystore/` - Key-value store for credentials (Google API keys, admin emails)
- `supabase/functions/wrappedsupabase/` - Database operations proxy

**Task Code**
- `taskcode/endpoints/comprehensive-gmail-search.js` - Main Gmail search task implementation
- `comprehensive-gmail-search-cli.js` - CLI tool for testing the Gmail search

### Suspension and Resume Mechanism

The core innovation is the automatic suspend/resume capability:

1. **External Call Detection**: `__callHostTool__(serviceName, methodPath, args)` triggers suspension
2. **Child Stack Run Creation**: External calls create child stack runs for API operations
3. **Parent Suspension**: Parent tasks marked `suspended_waiting_child` until children complete
4. **Task Suspension**: `TASK_SUSPENDED` error immediately stops task execution
5. **Child Processing**: simple-stack-processor handles external API calls
6. **Automatic Resume**: Child completion triggers parent resume with results via HTTP chain
7. **Causality Preservation**: Parents receive child results before making subsequent calls

This enables infinite length tasks by breaking up work call by call without timeouts or memory issues.

## Getting Started

### Prerequisites

- Node.js 18+
- Supabase CLI
- Google Workspace admin account with API access

### Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd tasker
```

2. **Install dependencies**
```bash
npm install
```

3. **Start Supabase**
```bash
supabase start
npm run serve
```

4. **Configure Google API credentials**
```bash
# Add your Google service account key and admin email to keystore
# See CLAUDE.md for detailed setup instructions
```

5. **Publish the Gmail search task**
```bash
npm run publish:task
```

### Quick Test

Run a simple Gmail search test:

```bash
npm run test:gmail-simple
```

Or use the CLI directly:

```bash
node comprehensive-gmail-search-cli.js --maxUsersPerDomain 2 --maxResultsPerUser 1
```

## Usage

### Running Gmail Searches

**Simple Test (2 users, 1 result each):**
```bash
npm run test:gmail-simple
```

**Full Test (98 users, 300 results each):**
```bash
npm run test:gmail
```

**Custom Search:**
```bash
node comprehensive-gmail-search-cli.js \
  --gmailSearchQuery "subject:important" \
  --maxUsersPerDomain 10 \
  --maxResultsPerUser 50
```

### Development Commands

**Start Infrastructure:**
```bash
supabase start              # Start local Supabase
npm run serve              # Start edge functions server
```

**Task Publishing:**
```bash
npm run publish:task       # Publish comprehensive Gmail search task to database
```

**Debugging:**
```bash
npm run debug:db               # Check database state
npm run debug:logs             # View recent logs
npm run debug:clear            # Clear database tables
```

## How It Works

### Task Execution Flow

1. **Submission**: CLI calls `/functions/v1/tasks/execute`
2. **Processing**: Task service creates task_run and triggers simple-stack-processor
3. **Execution**: deno-executor runs task code with `__callHostTool__` for external calls
4. **Suspension**: External calls throw `TASK_SUSPENDED` error with suspension data
5. **Child Creation**: deno-executor creates child stack_run and marks parent `suspended_waiting_child`
6. **Child Processing**: simple-stack-processor processes child stack_run for external API call
7. **Resume**: Child completion triggers parent resume with results via HTTP chain
8. **Continuation**: Parent task continues execution with child results
9. **Chaining**: Process repeats for each external call, maintaining causality

### Database Schema

**Core Tables:**
- `task_functions` - Stores published task code and metadata
- `task_runs` - Tracks task execution instances with suspension state
- `stack_runs` - Individual operation calls in task execution chain
- `keystore` - Credentials storage (Google API keys, admin emails)

**Important**: Never reset the database. Clear tables individually:
```bash
DELETE FROM stack_runs WHERE id > 0;
DELETE FROM task_runs WHERE id > 0;
# Keep task_functions and keystore intact
```

## Development Principles

**Performance Requirements:**
- Never wait more than 5 seconds for any step to run
- Use concurrently for running server and client together
- Client waits for server before running

**Testing Principles:**
- Never use mocks or fake data - only test with real working conditions
- Use MCP REPL tool instead of curl for debugging Deno functions
- Always check CLI output properly

**Stack Processing Rules:**
- Stack processor uses HTTP chaining, not polling
- Each process starts the next and exits immediately (fire-and-forget)
- Sequential processing with database locks
- External calls via `__callHostTool__` create child stack runs and suspend parent
- Parent tasks marked `suspended_waiting_child` until children complete
- Suspension mechanism preserves causality

## Documentation

- `CLAUDE.md` - Comprehensive development guide and architecture documentation
- `dev-tools/README.md` - Development tools and debugging guide
- See function-specific documentation in each `supabase/functions/` directory
