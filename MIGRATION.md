# Migration Guide: QuickJS to Deno Executor

This document outlines the migration from QuickJS-based task execution to native Deno execution.

## Overview

In August 2025, the task execution system was migrated from QuickJS VM to native Deno execution for improved performance, reliability, and maintainability.

## What Changed

### Core Components

| Old Component | New Component | Purpose |
|---------------|---------------|---------|
| `supabase/functions/quickjs/` | `supabase/functions/deno-executor/` | Task execution runtime |
| `supabase/functions/stack-processor/` | `supabase/functions/simple-stack-processor/` | Stack run processing |

### Suspension Mechanism

**Before (QuickJS):**
- Tasks suspended by setting VM state and returning placeholder values
- Complex VM state serialization and restoration
- Global state management for processing coordination

**After (Deno Executor):**
- Tasks suspend by throwing `TASK_SUSPENDED` error with suspension data
- Immediate task execution halt when external calls are needed
- Database-based coordination with proper locking

### Key Implementation Changes

1. **`__callHostTool__` Function:**
   - **Before:** Returned placeholder values and relied on VM state capture
   - **After:** Throws `TASK_SUSPENDED` error to immediately stop execution

2. **Suspension Data Handling:**
   - **Before:** Complex VM state serialization
   - **After:** Simple JSON suspension data with `__hostCallSuspended: true` flag

3. **Response Processing:**
   - **Before:** Direct suspension object handling
   - **After:** Nested response handling (`result.result` structure)

4. **Stack Run Status:**
   - **Before:** Various suspension states
   - **After:** Clear `suspended_waiting_child` status for waiting parents

## Benefits of Migration

### Performance Improvements
- **Faster Execution:** Native Deno is significantly faster than QuickJS VM
- **Lower Memory Usage:** No VM overhead or state serialization complexity
- **Better Resource Management:** Native garbage collection and memory handling

### Reliability Improvements
- **Simpler Error Handling:** Clear error-based suspension mechanism
- **Fewer Edge Cases:** Eliminated VM state corruption issues
- **Better Debugging:** Native stack traces and error reporting

### Maintainability Improvements
- **Cleaner Code:** Removed complex VM state management
- **Easier Testing:** Direct function calls instead of VM execution
- **Better Logging:** Native console.log and error reporting

## Compatibility

### Task Code Compatibility
- **No Changes Required:** Existing task code using `__callHostTool__` works unchanged
- **Same API:** All external service calls use the same interface
- **Same Results:** Tasks produce identical outputs

### Database Schema
- **Fully Compatible:** All existing database tables and relationships preserved
- **Same Stack Runs:** Stack run creation and processing logic unchanged
- **Same Task Runs:** Task run lifecycle and status management preserved

### Service Wrappers
- **No Changes:** All wrapped services (gapi, keystore, supabase) work unchanged
- **Same Interfaces:** Service call signatures and responses identical
- **Same Authentication:** Google API and Supabase authentication unchanged

## Migration Process

The migration was completed in a single update with no breaking changes:

1. **Replaced QuickJS executor** with native Deno executor
2. **Updated stack processor** to handle new suspension mechanism
3. **Enhanced error handling** for better reliability
4. **Improved logging** for better debugging
5. **Updated documentation** to reflect changes

## Verification

To verify the migration was successful:

1. **Run existing tests:**
   ```bash
   npm run test:gmail-simple
   ```

2. **Check suspension mechanism:**
   - Tasks should suspend on external calls
   - Parent stack runs should show `suspended_waiting_child` status
   - Child stack runs should complete and resume parents

3. **Monitor logs:**
   - Look for "Task suspended for external call" messages
   - Verify child stack run creation and completion
   - Confirm parent resume with results

## Troubleshooting

### Common Issues

1. **Tasks not suspending:**
   - Check that `__callHostTool__` is being called correctly
   - Verify deno-executor is handling suspension errors
   - Look for `TASK_SUSPENDED` error in logs

2. **Parent not resuming:**
   - Verify child stack run completed successfully
   - Check parent stack run status is `suspended_waiting_child`
   - Ensure simple-stack-processor is processing child completion

3. **Suspension data not detected:**
   - Check for nested response structure (`result.result`)
   - Verify `__hostCallSuspended: true` flag is present
   - Look for suspension detection logs in simple-stack-processor

### Debug Commands

```bash
# Check database state
npm run debug:db

# View recent logs
npm run debug:logs

# Clear database tables
npm run debug:clear
```

## Future Considerations

The new Deno-based architecture provides a solid foundation for:

- **Enhanced Performance:** Further optimizations possible with native execution
- **Better Scaling:** Improved resource utilization for concurrent tasks
- **Extended Functionality:** Easier integration of new features and services
- **Improved Monitoring:** Better observability and debugging capabilities

The migration preserves all existing functionality while providing significant improvements in performance, reliability, and maintainability.
