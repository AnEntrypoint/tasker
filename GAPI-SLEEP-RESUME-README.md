# GAPI Sleep-Resume Feature with Domains List

This document describes the implementation and usage of the GAPI Sleep-Resume feature with Domains List display in the Tasker system.

## Overview

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

## Implementation Details

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

## Troubleshooting

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