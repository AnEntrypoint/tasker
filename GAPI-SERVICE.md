# Google API Integration in Tasker

This document explains how to use the optimized Google API (GAPI) integration in the Tasker system.

## Overview

The GAPI service is implemented as a Supabase Edge Function that provides access to Google APIs like Gmail and Admin Directory. The implementation includes token caching to avoid repeated JWT authentication, which is CPU-intensive and can cause resource limit errors in Edge Functions.

## Available APIs

The following Google APIs are currently supported:

- **Admin Directory API** (`admin`)
  - Domains (`domains.list`)
  - Users (`users.list`, `users.get`)
  - Customers (`customers.get`)

- **Gmail API** (`gmail`)
  - Messages (`messages.list`, `messages.get`)
  - Labels (`labels.list`)
  - Threads (`threads.list`, `threads.get`)

## Using the GAPI Service in Tasks

Here's how to use the GAPI service in your tasks:

```javascript
async function myTask(input, { tools }) {
  // Access the Google Admin API to list domains
  // IMPORTANT: Always use "my_customer" for the customer parameter, not email addresses
  const domains = await tools.gapi.admin.domains.list({ customer: "my_customer" });
  console.log(`Found ${domains.domains.length} domains`);
  
  // Access Gmail API to list messages
  const messages = await tools.gapi.gmail.users.messages.list({ 
    userId: "me", 
    maxResults: 10 
  });
  console.log(`Found ${messages.messages.length} messages`);
  
  return { 
    domains: domains.domains,
    messageCount: messages.messages.length
  };
}

export default myTask;
```

## Important Notes on Customer IDs

When working with Google Admin SDK API:

1. **Always use `"my_customer"` (not an email)**: When referring to the customer that the authenticated admin belongs to, always use the string `"my_customer"`, not the admin email address.

2. **Email addresses are not valid customer IDs**: Using an email address as a customer ID will result in a 400 Bad Request error from the Google API.

3. **Customer IDs for multi-tenant situations**: Only use specific customer ID values for multi-tenant situations where you're managing multiple Google Workspace domains.

## Direct Implementation for Performance Critical Operations

For performance-critical operations, the service includes direct implementations that bypass the SDK abstraction. Currently, the following operations have direct implementations:

- `admin.domains.list` - Directly calls the Admin API to list domains

## Status and Management Endpoints

The service includes several status and management endpoints:

- `GET /wrappedgapi/health` - Returns health status and token cache size
- `POST /wrappedgapi` with `method: "checkCredentials"` - Checks if credentials are properly loaded
- `POST /wrappedgapi` with `method: "getTokenInfo"` - Returns info about currently cached tokens
- `POST /wrappedgapi` with `method: "clearTokenCache"` - Clears the token cache (all tokens or specific scope)

## Configuration

The service requires the following configuration in the keystore:

- `global/GAPI_KEY` - Google service account credentials JSON
- `global/GAPI_ADMIN_EMAIL` - Admin email address for domain-wide delegation

## Testing

Several test scripts are available to test the GAPI service:

- `tests/gapi/test-gapi-health.ts` - Tests health and status endpoints
- `tests/misc/test-keystore.ts` - Tests keystore access for credentials
- `tests/gapi/test-gapi-domains-simple.ts` - Tests domains listing with `"my_customer"`

## Implementation Details

The implementation includes several optimizations:

1. **Token Caching**: Tokens are cached in memory with expiry tracking
2. **Direct API Implementations**: Performance-critical operations bypass the SDK abstraction
3. **Simplified Authentication**: Uses service account with domain-wide delegation
4. **Error Handling**: Detailed error reporting with full error context
5. **Health Monitoring**: Includes health endpoint for monitoring

These optimizations allow the service to work within Edge Function resource constraints while providing robust access to Google APIs. 