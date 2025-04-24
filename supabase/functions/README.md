# Supabase Edge Functions

This directory contains edge functions deployed to Supabase for the Tasker application.

## Available Functions

### 1. `wrappedkeystore`

A simplified keystore service that provides secure API key storage and retrieval. The function supports:

- Retrieving API keys (especially OpenAI API key)
- Getting server time (health check)
- Listing keys by namespace

### 2. `wrappedopenai`

A wrapper around the OpenAI API that:

- Securely retrieves API keys from the keystore function
- Handles API calls to OpenAI
- Provides error handling and logging

## Configuration

### Environment Variables

These functions require the following environment variables to be set in the Supabase dashboard:

1. `OPENAI_API_KEY`: Your OpenAI API key (starts with "sk-")

To set environment variables:
1. Navigate to the Supabase Dashboard
2. Go to Project Settings > API
3. Scroll down to "Environment Variables"
4. Add your environment variables

## Deployment

To deploy these functions, use the Supabase CLI:

```bash
# Install Supabase CLI if you haven't already
npm install -g supabase

# Login to Supabase
supabase login

# Deploy a function
supabase functions deploy wrappedkeystore --no-verify-jwt
supabase functions deploy wrappedopenai --no-verify-jwt
```

The `--no-verify-jwt` flag is used to allow public access without authentication for testing. In production, you might want to enable JWT verification.

## Testing

You can test these functions using the provided test script:

```bash
deno run --allow-net ./temp/simple-keystore-test.ts
```

This script tests:
1. Keystore server time function (health check)
2. Retrieving the OpenAI API key
3. Making a direct call to the OpenAI API

## Usage Examples

### Getting the OpenAI API Key

```javascript
const response = await fetch(
  "https://your-project-ref.supabase.co/functions/v1/wrappedkeystore",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ANON_KEY}`
    },
    body: JSON.stringify({
      path: ["getKey"],
      params: {
        namespace: "api_keys",
        key: "openai_api_key"
      }
    })
  }
);
```

### Making an OpenAI API Call

```javascript
const response = await fetch(
  "https://your-project-ref.supabase.co/functions/v1/wrappedopenai",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ANON_KEY}`
    },
    body: JSON.stringify({
      path: ["createChatCompletion"],
      params: {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: "Say hello" }],
        max_tokens: 50
      }
    })
  }
);
```

## Troubleshooting

1. **Invalid OpenAI API Key**: Make sure your `OPENAI_API_KEY` environment variable is set to a valid OpenAI API key that starts with "sk-".

2. **Function Not Found**: Ensure you've deployed the functions with the correct names.

3. **CORS Errors**: Both functions include CORS headers to allow requests from any origin. If you're still having CORS issues, check your request headers. 