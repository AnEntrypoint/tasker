# Web Search Edge Function

## Overview
This edge function provides web search capabilities using DuckDuckGo's HTML API. It returns formatted search results with title, URL, and snippets from relevant web pages. Authentication is required using a valid Supabase JWT token in the Authorization header (typically the anon key).

## Features
- Web search using DuckDuckGo's public HTML API
- Requires standard JWT authentication like other Supabase functions
- Configurable result limits
- Detailed search result formatting with titles, URLs and snippets
- Error handling and logging

## Authentication
- Uses standard Supabase JWT authentication
- For client applications, use the anon key in the Authorization header
- For server-to-server or edge function communication, use valid JWT token

## Request Parameters
- `query` (required): The search query to perform
- `limit` (optional, default: 10): Maximum number of search results to return

## Response Structure
- `query`: The original search query
- `results`: Array of search results (title, URL, snippet)
- `timestamp`: When the search was performed
- `error`: Any errors encountered during the search

## Usage Examples

### Basic Search
```bash
curl -i --location --request POST 'https://[YOUR_PROJECT_REF].supabase.co/functions/v1/wrappedwebsearch' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer [YOUR_ANON_KEY]' \
  --data '{"path":["search"],"params":"javascript programming"}'
```

### Search with Options
```bash
curl -i --location --request POST 'https://[YOUR_PROJECT_REF].supabase.co/functions/v1/wrappedwebsearch' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer [YOUR_ANON_KEY]' \
  --data '{"path":["search"],"params":{"query":"javascript programming","limit":5}}'
```

### From JavaScript/TypeScript
```typescript
const response = await fetch("https://[YOUR_PROJECT_REF].supabase.co/functions/v1/wrappedwebsearch", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
  },
  body: JSON.stringify({
    path: ["search"],
    params: {
      query: "javascript programming",
      limit: 5
    }
  })
});

const data = await response.json();
console.log(data.result.results);
``` 