# Service Registry Import Map

This document provides a comprehensive map of all available services in the unified HTTP service registry system, their methods, and how to call them.

## Overview

The service registry system provides a unified way to access all external services through HTTP calls, eliminating direct imports and ensuring proper FlowState integration. All services are accessed via `serviceRegistry.call(serviceName, methodName, args)`.

## Available Services

### 1. **Database Service** (`database`)
**Location**: `supabase/functions/wrappedsupabase/index.ts`
**Purpose**: Proxy for Supabase database operations
**Methods**:
- `select(table, columns, options)` - Query database table
- `insert(table, data, options)` - Insert records
- `update(table, data, filter, options)` - Update records
- `delete(table, filter, options)` - Delete records
- `rpc(name, params)` - Call stored procedures

**Usage Examples**:
```typescript
// Query data
const result = await serviceRegistry.call('database', 'select', [
  'task_runs',
  'id, status, created_at',
  { limit: 10 }
]);

// Insert data
const result = await serviceRegistry.call('database', 'insert', [
  'stack_runs',
  { task_run_id: '123', status: 'pending' }
]);

// Update data
const result = await serviceRegistry.call('database', 'update', [
  'stack_runs',
  { status: 'completed' },
  { id: 456 }
]);
```

### 2. **Keystore Service** (`keystore`)
**Location**: `supabase/functions/wrappedkeystore/index.ts`
**Purpose**: Key-value storage for credentials and configuration
**Methods**:
- `getKey(namespace, key)` - Get stored value
- `setKey(namespace, key, value)` - Store value
- `listKeys(namespace)` - List all keys in namespace
- `hasKey(namespace, key)` - Check if key exists
- `listNamespaces()` - List all namespaces
- `getServerTime()` - Get current server time

**Usage Examples**:
```typescript
// Get API key
const result = await serviceRegistry.call('keystore', 'getKey', [
  'global',
  'OPENAI_API_KEY'
]);

// Store configuration
const result = await serviceRegistry.call('keystore', 'setKey', [
  'gmail',
  'last_sync_time',
  new Date().toISOString()
]);

// List all keys in namespace
const result = await serviceRegistry.call('keystore', 'listKeys', ['global']);
```

### 3. **Google API Service** (`gapi`)
**Location**: `supabase/functions/wrappedgapi/index.ts`
**Purpose**: Google API integration with automatic token management
**Methods**:
- `admin.domains.list(params)` - List Google Workspace domains
- `admin.users.list(params)` - List Google Workspace users
- `gmail.users.messages.list(params)` - List Gmail messages
- `gmail.users.messages.get(params)` - Get Gmail message details
- `checkCredentials()` - Verify Google API credentials
- `getTokenInfo()` - Get cached token information
- `clearTokenCache(scope?)` - Clear cached tokens

**Usage Examples**:
```typescript
// List domains
const result = await serviceRegistry.call('gapi', 'admin.domains.list', [
  { customer: 'my_customer' }
]);

// List users in domain
const result = await serviceRegistry.call('gapi', 'admin.users.list', [
  { domain: 'example.com', maxResults: 100 }
]);

// Search Gmail messages
const result = await serviceRegistry.call('gapi', 'gmail.users.messages.list', [
  { userId: 'me', q: 'from:sender@example.com' }
]);
```

### 4. **OpenAI Service** (`openai`)
**Location**: `supabase/functions/wrappedopenai/index.ts`
**Purpose**: OpenAI API integration
**Methods**:
- `chat.completions.create(params)` - Create chat completion
- `embeddings.create(params)` - Create embeddings
- `models.list()` - List available models
- `models.retrieve(modelId)` - Get model details

**Usage Examples**:
```typescript
// Create chat completion
const result = await serviceRegistry.call('openai', 'chat.completions.create', [
  {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello!' }],
    max_tokens: 100
  }
]);

// Create embeddings
const result = await serviceRegistry.call('openai', 'embeddings.create', [
  {
    model: 'text-embedding-ada-002',
    input: 'Hello world'
  }
]);
```

### 5. **Web Search Service** (`websearch`)
**Location**: `supabase/functions/wrappedwebsearch/index.ts`
**Purpose**: Web search integration
**Methods**:
- `search(query, options)` - Perform web search
- `getDetails(url)` - Get page details

**Usage Examples**:
```typescript
// Search web
const result = await serviceRegistry.call('websearch', 'search', [
  'Deno runtime tutorial',
  { limit: 10, safe: true }
]);

// Get page details
const result = await serviceRegistry.call('websearch', 'getDetails', [
  'https://deno.land'
]);
```

## Service Registry API

### Core Method
```typescript
await serviceRegistry.call(serviceName: string, methodName: string, args: any[]): Promise<ServiceResponse>
```

### Response Format
```typescript
interface ServiceResponse {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: {
    duration: number;
    retries: number;
    serviceCall?: {
      serviceName: string;
      methodPath: string;
    };
  };
}
```

### Error Handling
```typescript
const result = await serviceRegistry.call('database', 'select', ['users', '*']);
if (!result.success) {
  console.error('Service call failed:', result.error);
  // Handle error
  return;
}
const data = result.data;
```

## FlowState Integration

The service registry automatically integrates with FlowState for external calls:

```typescript
// This call will automatically trigger FlowState pause/resume if needed
const result = await serviceRegistry.call('gapi', 'admin.users.list', [
  { domain: 'example.com' }
]);
```

## Configuration

Services are configured through the `config-service.ts` and environment variables:

- `SUPABASE_URL` - Supabase instance URL
- `SUPABASE_SERVICE_ROLE_KEY` - Database service role key
- `SUPABASE_ANON_KEY` - Database anonymous key

## Port Mappings

All services are available as Supabase Edge Functions at:

- Database: `{SUPABASE_URL}/functions/v1/wrappedsupabase`
- Keystore: `{SUPABASE_URL}/functions/v1/wrappedkeystore`
- Google API: `{SUPABASE_URL}/functions/v1/wrappedgapi`
- OpenAI: `{SUPABASE_URL}/functions/v1/wrappedopenai`
- Web Search: `{SUPABASE_URL}/functions/v1/wrappedwebsearch`
- Tasks: `{SUPABASE_URL}/functions/v1/tasks`

## Migration from Direct Imports

### Before (Direct Imports)
```typescript
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(url, key);
const { data } = await supabase.from('users').select('*');
```

### After (Service Registry)
```typescript
import { serviceRegistry } from "../_shared/service-registry.ts";
const result = await serviceRegistry.call('database', 'select', ['users', '*']);
const data = result.success ? result.data : null;
```

## Best Practices

1. **Always check response success**: Handle both success and error cases
2. **Use proper error handling**: Check `result.success` before accessing `result.data`
3. **Leverage caching**: Many services (like gapi) include automatic caching
4. **Use FlowState integration**: External calls automatically pause/resume tasks
5. **Monitor performance**: Response metadata includes duration and retry information

## Health Checks

All services provide health check endpoints:

```typescript
// Direct HTTP call
const health = await fetch(`${SUPABASE_URL}/functions/v1/wrappedgapi/health`);
const status = await health.json();

// Through service registry (if implemented)
const result = await serviceRegistry.call('gapi', 'healthCheck');
```

This import map provides a complete reference for accessing all services through the unified HTTP service registry system, ensuring zero direct imports and proper FlowState integration.