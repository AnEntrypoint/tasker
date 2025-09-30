# Architecture Standards and Naming Conventions

This document outlines the standardized architecture, naming conventions, and patterns used throughout the Tasker codebase to ensure consistency, maintainability, and clarity.

## Table of Contents

1. [Core Architectural Principles](#core-architectural-principles)
2. [Naming Conventions](#naming-conventions)
3. [Service Architecture](#service-architecture)
4. [File Organization](#file-organization)
5. [Error Handling Patterns](#error-handling-patterns)
6. [Logging and Monitoring](#logging-and-monitoring)
7. [Database Patterns](#database-patterns)
8. [API Response Standards](#api-response-standards)
9. [Performance Guidelines](#performance-guidelines)
10. [Development Workflow](#development-workflow)

## Core Architectural Principles

### 1. Service-Oriented Architecture
- All external integrations use wrapped edge functions
- Single responsibility principle for each service
- Consistent base class inheritance for all services
- Dependency injection through shared services

### 2. Configuration Over Code
- All behavior configurable through environment variables
- No hardcoded values in business logic
- Centralized configuration management via `ConfigService`

### 3. Unified Error Handling
- Standardized error types and formats
- Consistent error propagation
- Comprehensive error logging with context

### 4. Zero Code Duplication
- Shared utilities in `_shared` directory
- Base service class for common patterns
- Consolidated database operations

## Naming Conventions

### File Naming
- **Files**: kebab-case (`base-service.ts`, `config-service.ts`)
- **Classes**: PascalCase (`BaseService`, `ConfigService`)
- **Interfaces**: PascalCase with 'I' prefix (`IServiceConfig`, `IHealthCheckResult`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRY_ATTEMPTS`, `DEFAULT_TIMEOUT`)
- **Methods**: camelCase with descriptive verbs (`executeOperation`, `validateConfiguration`)
- **Variables**: camelCase (`serviceInstance`, `requestContext`)
- **Private Members**: camelCase with optional underscore prefix (`_config`, `privateMethod`)

### Method Naming Conventions
```typescript
// CRUD Operations
createTask()     // Create new resource
getTask()        // Retrieve single resource
listTasks()      // Retrieve multiple resources
updateTask()     // Update existing resource
deleteTask()     // Remove resource

// Service Operations
executeOperation()  // Execute business logic
validateInput()     // Validate request data
processRequest()    // Handle incoming request
performHealthCheck() // Check service health

// Utility Methods
sanitizeString()     // Clean input data
isValidUuid()        // Validate format
generateCorrelationId() // Create unique identifier
```

### Interface Naming
```typescript
interface IServiceConfig { ... }        // Service configuration
interface IApiResponse<T> { ... }      // API response structure
interface IHealthCheckResult { ... }   // Health check results
interface IDatabaseResult<T> { ... }   // Database operation result
```

## Service Architecture

### Base Service Class
All services extend `BaseService` for consistent behavior:

```typescript
class MyService extends BaseService {
  constructor() {
    super({
      name: 'my-service',
      version: '1.0.0',
      description: 'Service description',
      enableHealthCheck: true,
      enablePerformanceLogging: true,
      timeout: 30000,
      retries: 3
    });
  }

  public getOperations(): string[] {
    return ['operation1', 'operation2'];
  }

  @ServiceOperation('operationName')
  async operationName(param: string): Promise<ResultType> {
    return this.executeOperation(
      'operationName',
      async () => {
        // Business logic here
        return result;
      },
      { param } // Context for logging
    );
  }
}
```

### Service Components
1. **Service Class**: Business logic implementation
2. **HTTP Handler**: Request/response handling
3. **Health Checks**: Service-specific health monitoring
4. **Configuration**: Centralized config management
5. **Error Handling**: Standardized error types and responses

## File Organization

### Directory Structure
```
supabase/functions/
├── _shared/                    # Shared utilities and base classes
│   ├── base-service.ts        # Base service class
│   ├── config-service.ts      # Configuration management
│   ├── logging-service.ts     # Logging framework
│   ├── database-service.ts    # Database operations
│   ├── http-handler.ts        # HTTP request handling
│   ├── cors.ts               # CORS configuration
│   └── utils.ts              # General utilities
├── services/                   # Service implementations
│   ├── wrappedkeystore/       # Key-value store service
│   ├── wrappedsupabase/       # Database proxy service
│   ├── wrappedgapi/           # Google API wrapper
│   └── wrappedopenai/         # OpenAI API wrapper
├── tasks/                      # Task execution system
│   ├── registry/              # Task registration
│   ├── services/              # Task-related services
│   ├── handlers/              # Task execution handlers
│   └── types/                 # Task type definitions
└── admin-debug/               # Administrative debugging
```

### File Size Limits
- **Maximum**: 200 lines per file
- **Preferred**: 110 lines per file
- Split large files into focused modules
- Use descriptive file names

## Error Handling Patterns

### ServiceError Class
Standardized error handling with typed errors:

```typescript
// Error Types
enum ServiceErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  NOT_FOUND_ERROR = 'NOT_FOUND_ERROR',
  CONFLICT_ERROR = 'CONFLICT_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR'
}

// Usage
throw new ServiceError(
  ServiceErrorType.VALIDATION_ERROR,
  'Invalid input data',
  'VALIDATION_FAILED',
  { field: 'email', value: input.email },
  400
);
```

### Error Response Format
```typescript
interface IErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  metadata: {
    timestamp: string;
    duration: number;
    requestId?: string;
    version?: string;
  };
}
```

## Logging and Monitoring

### Logging Levels
- `debug`: Detailed debugging information
- `info`: General information about service operation
- `warn`: Warning conditions that don't prevent operation
- `error`: Error conditions that require attention

### Structured Logging
```typescript
logger.info('Operation completed', {
  operation: 'getUser',
  userId: '123',
  duration: 150,
  success: true
});
```

### Performance Monitoring
```typescript
// Automatic performance tracking
@ServiceOperation('methodName')
async methodName() {
  // Automatically logged with timing
}

// Manual performance tracking
const timerId = performance.startTimer('operation');
try {
  await performOperation();
  performance.endTimer(timerId, { success: true });
} catch (error) {
  performance.endTimer(timerId, { success: false, error: error.message });
}
```

## Database Patterns

### Database Service Usage
```typescript
class MyService extends BaseService {
  async getUserById(userId: string) {
    const result = await this.database.executeQuery(
      'getUserById',
      (client) => client
        .from('users')
        .select('*')
        .eq('id', userId)
        .single()
    );

    if (!result.success) {
      throw result.error;
    }

    return result.data;
  }
}
```

### Query Builder Patterns
```typescript
// Consistent method naming
createTask(taskData: Partial<Task>): Promise<DatabaseResult<Task>>
getTask(taskId: string): Promise<DatabaseResult<Task>>
updateTask(taskId: string, updates: Partial<Task>): Promise<DatabaseResult<Task>>
deleteTask(taskId: string): Promise<DatabaseResult<void>>
listTasks(options: QueryOptions): Promise<DatabaseResult<Task[]>>
```

## API Response Standards

### Success Response
```typescript
interface ISuccessResponse<T> {
  success: true;
  data: T;
  metadata: {
    timestamp: string;
    duration: number;
    requestId?: string;
    version?: string;
  };
}
```

### Error Response
```typescript
interface IErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  metadata: {
    timestamp: string;
    duration: number;
    requestId?: string;
    version?: string;
  };
}
```

### Response Utilities
```typescript
// Create standardized responses
const { response } = createSuccessApiResponse(data, 200);
const { response } = createErrorApiResponse('Error message', 400);

// Legacy support (deprecated)
createErrorResponse(message, statusCode, details)
createSuccessResponse(data, statusCode)
```

## Performance Guidelines

### Operation Timeout Standards
- **Default Timeout**: 30 seconds
- **Database Operations**: 10 seconds
- **External API Calls**: 30 seconds
- **Internal Service Calls**: 5 seconds

### Retry Logic
- **Default Retries**: 3 attempts
- **Retry Delay**: Exponential backoff
- **External Services**: Configure per service

### Connection Pooling
- **Database**: Connection pooling with cleanup
- **HTTP Clients**: Reuse client instances
- **Resource Management**: Proper cleanup on service shutdown

## Development Workflow

### Service Development Checklist
1. **Extend BaseService**: All services must extend `BaseService`
2. **Implement getOperations()**: Return list of available operations
3. **Use @ServiceOperation decorator**: For automatic logging
4. **Implement performHealthCheck()**: Service-specific health checks
5. **Follow naming conventions**: Consistent method and variable naming
6. **Handle errors properly**: Use ServiceError with appropriate types
7. **Add comprehensive logging**: Include context and timing
8. **Write unit tests**: Test all public methods
9. **Document interfaces**: Clear JSDoc comments
10. **Validate configuration**: Ensure required config is present

### Code Review Guidelines
- Check naming convention compliance
- Verify error handling patterns
- Ensure proper logging
- Validate interface definitions
- Check file size limits
- Review architectural consistency

### Migration Patterns
When updating existing code:
1. Maintain backward compatibility where possible
2. Use deprecation warnings for old patterns
3. Provide migration examples
4. Update documentation
5. Run comprehensive tests

## Constants and Configuration

### Environment Variables
```typescript
// Standard naming pattern
const GAPI_API_KEY = Deno.env.get('GAPI_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const LOG_LEVEL = Deno.env.get('LOG_LEVEL') || 'info';
const HTTP_TIMEOUT = parseInt(Deno.env.get('HTTP_TIMEOUT') || '30000');
```

### Service Configuration
```typescript
interface IServiceConfig {
  name: string;           // Service name (kebab-case)
  version: string;        // Semantic versioning
  description?: string;   // Brief service description
  enableHealthCheck: boolean;
  enablePerformanceLogging: boolean;
  timeout: number;        // Default timeout in milliseconds
  retries: number;        // Default retry count
}
```

## Best Practices

### 1. Dependency Management
- Use shared services instead of direct imports
- Inject dependencies through constructors
- Avoid circular dependencies
- Use lazy loading where appropriate

### 2. Memory Management
- Clean up resources in `cleanup()` method
- Use proper connection pooling
- Avoid memory leaks in long-running operations
- Monitor memory usage in production

### 3. Security
- Sanitize all input data
- Use parameterized queries
- Implement proper authentication
- Log security events appropriately
- Never log sensitive data

### 4. Testing
- Write unit tests for all public methods
- Mock external dependencies
- Test error conditions
- Verify logging output
- Test health check endpoints

### 5. Documentation
- Use JSDoc comments for all public methods
- Document interface contracts
- Provide usage examples
- Keep README files current
- Document configuration options

This architecture ensures consistency, maintainability, and scalability across the entire Tasker codebase while following modern software development best practices.