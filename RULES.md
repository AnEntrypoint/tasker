# Critical Rules and Policies for FlowState Integration

## Environment Variable Management
- **RULE**: All edge functions require complete Supabase environment variables
- **REQUIRED**: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY must be set
- **FAILURE**: Missing any required environment variable causes service startup failure
- **SOLUTION**: Always verify environment variables before starting services

## Port Management
- **RULE**: Each service must use unique ports to avoid conflicts
- **DEFAULTS**:
  - wrappedsupabase: 8000
  - simple-stack-processor: 8001
  - alternative processors: 8002, 8003
- **CONFLICT**: Multiple services on same port cause "AddrInUse" errors
- **SOLUTION**: Use PORT environment variable and verify port availability

## Service Dependencies
- **RULE**: Services depend on each other in specific order
- **ORDER**: wrappedsupabase → wrappedgapi → wrappedkeystore → simple-stack-processor → deno-executor → tasks
- **FAILURE**: Starting services out of order causes connection failures
- **SOLUTION**: Start services sequentially, verify each is healthy before starting next

## Database Connection Patterns
- **RULE**: Two approaches for database access - Supabase API vs Direct PostgreSQL
- **SUPABASE API**: Requires environment variables, network connectivity
- **DIRECT POSTGRESQL**: Requires psql command, database credentials
- **FALLBACK**: Create PostgreSQL-based processors when Supabase API fails
- **PREFERENCE**: Use direct PostgreSQL for reliability, Supabase API for convenience

## Process Management
- **RULE**: Multiple background processes create conflicts and resource contention
- **CLEANUP**: Kill unused/conflicting processes immediately
- **MONITORING**: Use background scripts to monitor processing status
- **IDENTIFICATION**: Track processes by PID to avoid confusion

## Task Processing Flow
- **RULE**: Stack processor must actively process pending tasks, not just detect them
- **FLOW**: pending → processing → completed OR pending → processing → suspended_waiting_child → resumed → completed
- **MONITORING**: Background scripts can detect stuck tasks
- **INTERVENTION**: Manual triggering required when automatic processing fails

## FlowState Integration Principles
- **RULE**: FlowState automatically pauses on fetches, no manual suspension needed
- **WRAPPER**: Services must be wrapped in functions that make HTTP calls automatically
- **SDK HTTP WRAPPER**: Use npm package for universal service proxying
- **REACT-FREE**: Server-side implementation must not depend on React

## Debugging Strategy
- **RULE**: Never assume services are working without verification
- **TESTING**: Use real services, not mocks or simulations
- **MONITORING**: Continuous monitoring essential for detecting issues
- **LOGS**: Check background script outputs for actual processing status

## Error Prevention
- **RULE**: Prevent duplicate implementations and conflicting processes
- **CONSOLIDATION**: Use single canonical implementation for each service
- **CLEANUP**: Remove unused files and processes immediately
- **VERIFICATION**: Always test end-to-end functionality after changes