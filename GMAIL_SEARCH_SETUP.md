# Comprehensive Gmail Search Setup Guide

## Overview
The `npm run test:comprehensive-gmail-search` command runs a comprehensive Gmail search across all Google Workspace domains and users. It demonstrates the Tasker system's ability to handle complex, multi-step workflows with VM suspend/resume functionality.

## How It Works
1. **Lists all Google Workspace domains** - Discovers all domains in your workspace
2. **Lists users for each domain** - Gets all users in each domain (up to maxUsersPerDomain)
3. **Searches Gmail for each user** - Performs Gmail search for each user with the specified query
4. **Aggregates results** - Combines all results into a comprehensive report

## Prerequisites

### 1. Docker Desktop
The test requires Docker Desktop to be running for local Supabase services:
- Install Docker Desktop from https://docs.docker.com/desktop
- Ensure Docker is running before starting the test

### 2. Supabase Services
The following services must be running:
- `tasks` - Task execution engine
- `stack-processor` - Handles task queue processing
- `quickjs` - JavaScript VM for task execution
- `wrappedgapi` - Google API wrapper service
- `wrappedkeystore` - Credential management service

### 3. Google API Credentials
Ensure you have valid Google service account credentials stored in the keystore:
- `GAPI_KEY` - Service account JSON credentials
- `GAPI_ADMIN_EMAIL` - Admin email for domain-wide delegation

## Running the Test

### Basic Usage
```bash
# Start all required services and run the test
npm run test:comprehensive-gmail-search
```

### Custom Parameters
```bash
# Search for specific content
npm run test:comprehensive-gmail-search -- --query "subject:meeting"

# Limit scope for faster testing
npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 2 --maxResultsPerUser 1

# Search emails from last 7 days
npm run test:comprehensive-gmail-search -- --query "in:inbox newer_than:7d"
```

### Available Options
- `--query, -q <query>` - Gmail search query (default: "in:inbox")
- `--maxResultsPerUser <number>` - Max email results per user (default: 3)
- `--maxUsersPerDomain <number>` - Max users to process per domain (default: 5)

## Expected Output

### Successful Execution
```
🎉 COMPREHENSIVE GMAIL SEARCH COMPLETED SUCCESSFULLY!
===================================================
📊 Execution Summary:
   🏢 Domains processed: 2
   👥 Users processed: 8
   📧 Total emails found: 24
   🔍 Search query: "in:inbox"

📋 Results by Domain:
   1. 🏢 example.com:
      👥 Users searched: 5
      📧 Emails found: 15
      👤 Users with messages:
         1. john@example.com (John Doe): 5 emails
         2. jane@example.com (Jane Smith): 10 emails

📬 Sample Messages:
   1. From: john@example.com (example.com)
      Snippet: Meeting reminder for tomorrow at 3pm...
```

### Common Issues

#### 1. Docker Not Running
```
Error: Cannot connect to the Docker daemon
Solution: Start Docker Desktop
```

#### 2. Services Not Available
```
❌ SUPABASE SERVICES NOT RUNNING
Solution: Run npm run gapi:serve in a separate terminal
```

#### 3. Authentication Errors
```
Error: Failed to get credentials
Solution: Ensure GAPI_KEY and GAPI_ADMIN_EMAIL are properly configured in keystore
```

## Architecture Details

### Task Flow
1. Task submitted to `/functions/v1/tasks/execute`
2. QuickJS VM executes the task code
3. When external API call needed, VM suspends state
4. Stack processor handles the API call
5. VM resumes with API results
6. Process repeats for each API call
7. Final results aggregated and returned

### Key Components
- **comprehensive-gmail-search.js** - Task implementation with checkpoint management
- **comprehensive-gmail-search-cli.js** - CLI interface for running and monitoring
- **wrappedgapi** - Handles Google API authentication and calls
- **stack-processor** - Manages task execution and suspend/resume

## Troubleshooting

### Enable Debug Logging
Add console.log statements in the task code to trace execution:
```javascript
console.log("🔧 DEBUG: checkpoint stage:", getCheckpoint().stage);
```

### Check Task Status Directly
Query the database for task status:
```bash
# Requires database access
SELECT * FROM task_runs WHERE id = 'YOUR_TASK_ID';
```

### Verify API Permissions
Ensure the service account has:
- Domain-wide delegation enabled
- Admin SDK API access
- Gmail API access
- Proper OAuth scopes configured

## Performance Considerations

- Large domains may take several minutes to process
- Use `maxUsersPerDomain` and `maxResultsPerUser` to limit scope
- The system handles API rate limits automatically through suspend/resume
- Each API call adds ~2-3 seconds due to suspend/resume overhead

## Security Notes

- Credentials are stored securely in the keystore
- Service account impersonates users for Gmail access
- All API calls use OAuth 2.0 authentication
- Results may contain sensitive email data - handle appropriately