# Edge Function Development Tools

This directory contains development tools to make testing and iterating on Supabase Edge Functions faster and easier.

## Quick Start

### 1. Start Supabase
```bash
npm run start
```

### 2. Develop Individual Functions with Hot Reload
```bash
# Start wrappedgapi with hot reload
npm run dev:gapi

# Start wrappedkeystore with hot reload  
npm run dev:keystore

# Start any function with custom options
npm run dev:function -- --function wrappedgapi --port 8002 --verbose
```

### 3. Test Functions Directly
```bash
# See all available tests
npm run test:all

# Test wrappedgapi echo
npm run test:gapi

# Test keystore
npm run test:keystore

# Test with custom payload
npm run test:function -- --function wrappedgapi --payload '{"method":"echo","args":[{"test":"data"}]}'
```

### 4. Debug and Monitor
```bash
# View database state
npm run debug:db

# View recent logs
npm run debug:logs

# Clear database tables
npm run debug:clear

# Check function health
npm run debug:function -- --function wrappedgapi --action state
```

## Tools Overview

### 1. Function Development Server (`function-dev-server.js`)

Runs individual edge functions with hot reload for rapid development.

**Features:**
- Hot reload on file changes
- Isolated function testing
- Custom port configuration
- Verbose logging option
- Watches both function and shared directories

**Usage:**
```bash
npm run dev:function -- --function <name> [options]

Options:
  --function <name>    Function to run (required)
  --port <number>      Port to run on (default: 8001)
  --no-watch          Disable file watching
  --verbose           Enable verbose logging
```

**Examples:**
```bash
# Basic usage
npm run dev:function -- --function wrappedgapi

# Custom port with verbose logging
npm run dev:function -- --function deno-executor --port 8003 --verbose

# No hot reload
npm run dev:function -- --function wrappedkeystore --no-watch
```

### 2. Function Tester (`function-tester.js`)

Directly tests edge functions with predefined or custom payloads.

**Features:**
- Predefined test cases for each function
- Custom JSON payload support
- Payload file loading
- Response timing and formatting
- Verbose request/response logging

**Usage:**
```bash
npm run test:function -- [options]

Options:
  --function <name>       Function to test (required)
  --test <name>          Predefined test to run
  --payload <json>       Custom JSON payload
  --payload-file <file>  Load payload from file
  --verbose              Enable verbose logging
  --list-tests           List all available tests
```

**Examples:**
```bash
# List all tests
npm run test:function -- --list-tests

# Run predefined test
npm run test:function -- --function wrappedgapi --test echo

# Custom payload
npm run test:function -- --function deno-executor --payload '{"taskName":"test-task","taskRunId":1,"stackRunId":1}'

# Load from file
npm run test:function -- --function wrappedgapi --payload-file test-payloads/gapi-domains.json
```

### 3. Function Debugger (`function-debugger.js`)

Debugging and monitoring tools for edge functions.

**Features:**
- Database state inspection
- Function health checks
- Log viewing
- Database cleanup
- Interactive function testing
- Performance metrics

**Usage:**
```bash
npm run debug:function -- --action <action> [options]

Actions:
  logs        Show recent logs from functions
  state       Show function health and performance
  database    Show database state (stack_runs, task_runs)
  clear-db    Clear database tables
  inspect     Interactive function testing
  trace       Enable detailed tracing

Options:
  --function <name>    Function to debug (required for some actions)
  --limit <number>     Limit results (default: 50)
  --output <file>      Save output to file
```

**Examples:**
```bash
# View database state
npm run debug:function -- --action database

# Check function health
npm run debug:function -- --function wrappedgapi --action state

# View recent logs
npm run debug:function -- --action logs --limit 100

# Interactive testing
npm run debug:function -- --function wrappedgapi --action inspect
```

## Predefined Tests

### wrappedgapi
- `echo` - Test echo functionality
- `test-domains` - Test Google Admin SDK domains list

### wrappedkeystore  
- `get-key` - Test getting a key from keystore
- `list-keys` - Test listing all keys

### wrappedsupabase
- `test-connection` - Test Supabase connection

### deno-executor
- `simple-test` - Test Deno execution with simple task
- `test-suspension` - Test task suspension and resume mechanism

### simple-stack-processor
- `test-boot` - Test simple stack processor boot
- `test-processing` - Test stack run processing

## Development Workflow

### Rapid Function Development
1. Start the function with hot reload: `npm run dev:gapi`
2. Make changes to the function code
3. Test automatically reloads and shows results
4. Use the tester for specific scenarios: `npm run test:gapi`

### Debugging Issues
1. Check database state: `npm run debug:db`
2. View recent logs: `npm run debug:logs`
3. Test function health: `npm run debug:function -- --function wrappedgapi --action state`
4. Clear database if needed: `npm run debug:clear`

### Testing New Features
1. Use custom payloads: `npm run test:function -- --function wrappedgapi --payload '{"test":"data"}'`
2. Save payloads to files for reuse
3. Use interactive mode: `npm run debug:function -- --function wrappedgapi --action inspect`

## Tips

- **Hot Reload**: The development server watches both the function directory and the `_shared` directory
- **Port Conflicts**: Use different ports when running multiple functions simultaneously
- **Database State**: Always check database state when debugging complex issues
- **Verbose Mode**: Use `--verbose` flag to see detailed request/response information
- **Custom Payloads**: Save frequently used payloads as JSON files for easy reuse

## Troubleshooting

### Function Won't Start
- Check if Supabase is running: `npm run start`
- Verify function name is correct
- Check for port conflicts

### Tests Failing
- Verify Supabase is running and accessible
- Check service role key is correct
- Use `--verbose` to see detailed error information

### Database Issues
- Clear database tables: `npm run debug:clear`
- Check database state: `npm run debug:db`
- Verify keystore has required keys
