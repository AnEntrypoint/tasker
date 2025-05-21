# Tasker Troubleshooting Guide

This document consolidates troubleshooting information for the Tasker system, particularly focusing on common issues and their resolutions.

## Common Issues

### 1. Stuck Tasks

Tasks may appear to get "stuck" in the execution pipeline, leading to:
- Tasks never completing (staying in "running" state)
- CPU time limit errors from accumulated polling
- Resource exhaustion

#### Diagnosis

- Tasks never progress beyond the "running" state
- Records in stack_runs table remain in "pending" status
- VM state is not being saved or restored properly

#### Root Causes

- Stack processor not running or not responding
- Database trigger not functioning
- VM state not being properly saved
- Missing database trigger
- Stack processor not properly handling pending runs
- Database access permissions issues

#### Diagnostic Tools

**Detect Stuck Tasks**:
```bash
deno run -A detect-stuck-tasks.ts
```

**Test Stack Processor Trigger**:
```bash
deno run -A check-stack-processor-trigger.ts
```

**Non-Polling GAPI Test**:
```bash
deno run -A test-gapi-no-polling.ts
```

#### Solutions

- Check if the stack processor is responsive
- Verify database trigger installation using `check-and-fix-trigger.ts`
- Fix database connectivity issues (often the primary cause)
- Ensure proper promise handling in QuickJS executor
- Implement proper timeout handling in all async operations
- Use progressive timeouts for status checks (increase interval over time)

### 2. Google API (GAPI) Issues

Google API access often results in CPU time limit errors in Edge Functions due to the computationally expensive JWT authentication process.

#### Symptoms

- `CPU time soft limit reached`
- `early termination has been triggered`
- `connection closed before message completed`
- `exit 137` (Out of memory error)

#### Root Cause

Google's JWT authentication process requires asymmetric cryptography operations that exceed Supabase Edge Function CPU limits.

#### Solutions

1. **Use Token Caching**: Implement aggressive token caching to minimize authentication operations
2. **Use Direct API Implementations**: Bypass the SDK abstraction for performance-critical operations
3. **Always use "my_customer"**: For Admin SDK operations, always use the string "my_customer" instead of email addresses
4. **Potential Architectural Solutions**:
   - Create a standalone service outside of Supabase for Google API authentication
   - Use a serverless platform with higher CPU/memory limits
   - Pre-generate tokens externally and store them in Supabase Keystore
   - For browser applications, use Google Identity Platform directly on the client side

### 3. QuickJS Promise Handling

Improper handling of promises in QuickJS is a common source of issues.

#### Symptoms

- Tasks get stuck at await points
- Promises never resolve
- VM state is not saved correctly

#### Root Causes

- QuickJS requires explicit job processing for promises
- Missing executePendingJob calls
- Improper bridging between host promises and VM promises

#### Solutions

1. **Always Use Async/Await** for asynchronous operations in tasks
2. **Properly Handle Promise Errors** with try/catch blocks
3. **Avoid Missing Await** when calling async functions
4. **Process Pending Jobs** properly in the QuickJS executor:

```typescript
// Process all pending jobs until none remain
function processJobs(rt) {
  let jobsProcessed = 0;
  let res;
  do {
    res = rt.executePendingJob();
    if (res !== null) {
      jobsProcessed++;
    }
  } while (res !== null);
  return jobsProcessed;
}
```

### 4. Database Connectivity Issues

Database connectivity problems are often at the root of stuck tasks and other issues.

#### Symptoms

- 404 errors when trying to access database tables
- Cannot perform database operations needed for task execution
- Tasks get stuck in "running" state indefinitely

#### Diagnostic Approach

Use the `test-db-connection.ts` script to verify Supabase connection:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'http://127.0.0.1:8000';
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 'your-service-role-key';

// Create client with explicit options
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});

// Test connection
const { data, error } = await supabase.from('task_runs').select('count(*)');
if (error) {
  console.error('Connection error:', error);
} else {
  console.log('Connection successful:', data);
}
```

#### Solutions

- Check Supabase project configuration and ensure database access is properly set up for edge functions
- Verify that environment variables are correctly set (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
- Ensure the service role key has proper permissions for the required tables
- Check for any network restrictions that might be blocking access

## Testing Strategies

### 1. Graduated Testing Approach

1. Start with the **echo** test type to eliminate Google API issues
2. Use the `detect-stuck-tasks.ts` tool to identify where tasks get stuck
3. Test the database trigger with `check-stack-processor-trigger.ts`
4. Try direct invocation of the stack processor
5. Check database tables for proper schema and triggers

### 2. Testing GAPI Sleep/Resume Functionality

The Tasker system uses a save/sleep/resume mechanism when accessing external services. To test this functionality:

**Standard Task Endpoint Test**:
```bash
npm run gapi:test
```

**Direct Stack Processor Test**:
```bash
npm run gapi:test-direct [testType]
```

Available test types:
- **echo** - Lightweight test that avoids actual API calls (default)
- **customer** - Gets basic customer information from Google Admin SDK
- **info** - Gets directory API information for a specific user

### 3. Avoiding Resource Exhaustion During Testing

To prevent resource exhaustion:
- Avoid excessive polling (use fire-and-forget approach)
- Use the non-polling approach demonstrated in `test-gapi-no-polling.ts`
- For browser-based testing, implement progressive timeouts (increase interval over time)
- Consider using the direct invocation approach for more detailed debugging

## Prevention Best Practices

1. **Proper Error Handling**: Implement comprehensive error handling in tasks and service proxies
2. **Timeouts and Retries**: Add proper timeout handling and retry logic for critical operations
3. **Health Checks**: Implement health check endpoints for monitoring system components
4. **Watchdog Service**: Consider implementing a watchdog service for detecting and recovering stuck tasks
5. **Progressive Polling**: Use progressive polling intervals to avoid resource exhaustion
6. **Token Caching**: Implement aggressive token caching for authentication-heavy services
7. **VM State Management**: Ensure proper VM state serialization and deserialization

## References

- [QuickJS Documentation](https://bellard.org/quickjs/quickjs.html)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Google Identity Platform](https://developers.google.com/identity) 