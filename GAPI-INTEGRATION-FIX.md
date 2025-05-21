# GAPI Integration Fix

This document describes the solution for fixing GAPI (Google API) integration issues in the Tasker system's ephemeral call queueing mechanism.

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

## Implementation Steps

1. **Fix Stack Processor**:
   ```bash
   deno run --allow-read --allow-write fix-stack-processor.ts
   deno run --allow-read --allow-write diff-stack-processor.ts
   ```
   Review the changes and apply them:
   ```bash
   mv supabase/functions/stack-processor/index.ts supabase/functions/stack-processor/index.ts.bak
   mv supabase/functions/stack-processor/index.fixed.ts supabase/functions/stack-processor/index.ts
   ```

2. **Run Direct GAPI Processor** to clear any backlog:
   ```bash
   deno run -A process-direct-gapi.ts
   ```

3. **Set Up GAPI Monitor** for continuous monitoring:
   ```bash
   mkdir -p logs
   deno run -A gapi-monitor.ts
   ```

4. **Configure Cron Job** for automated processing:
   ```bash
   chmod +x cron-gapi-monitor.sh
   ```
   Add to crontab (runs every 5 minutes):
   ```
   */5 * * * * /path/to/tasker/cron-gapi-monitor.sh >> /path/to/tasker/logs/cron.log 2>&1
   ```

## How It Works

1. When a task calls the Google API through the `__callHostTool__` function, an entry is created in the `stack_runs` table with status "pending".

2. The GAPI monitor periodically checks for pending stack runs, processes them by making direct API calls to `wrappedgapi`, and updates the results.

3. For parent stack runs that were waiting on GAPI calls, the monitor updates their VM state and sets them to "ready_to_resume", then triggers the stack processor to resume them.

4. For task runs associated with GAPI calls, the monitor ensures they are updated with the final results.

5. As a fallback, the direct processor is also run periodically to handle any runs that might have been missed by the monitor.

## Troubleshooting

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

## Future Improvements

1. Add more robust error handling and retries for transient API failures
2. Implement metrics and alerts for GAPI call performance and failures
3. Optimize the monitoring process to reduce database load
4. Add support for more Google API services in the direct processor 