// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { createResponse } from '../_shared/response.ts'

console.log("Hello from Functions!")

const GAPI_BASE_URL = 'https://www.googleapis.com'

interface GAPIRequest {
  service: string // e.g. 'drive', 'sheets', 'calendar'
  version: string // e.g. 'v3'
  endpoint: string // e.g. 'files', 'spreadsheets'
  method: string // HTTP method
  params?: Record<string, any>
  body?: any
}

async function getGAPIKey() {
  try {
    // First try keystore
    const keystoreResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/wrappedkeystore`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'get',
        key: 'GAPI_KEY',
        namespace: 'global'
      })
    })

    if (keystoreResponse.ok) {
      const data = await keystoreResponse.json()
      if (data.success && data.data && data.data.value) {
        return data.data.value
      }
    }

    // Fall back to environment variable
    return Deno.env.get('GAPI_KEY')
  } catch (error) {
    console.error('Error getting GAPI key:', error)
    return Deno.env.get('GAPI_KEY')
  }
}

async function handleGAPIRequest(req: GAPIRequest) {
  const apiKey = await getGAPIKey()
  if (!apiKey) {
    throw new Error('GAPI_KEY not found')
  }

  // Construct the API URL
  const url = new URL(`${GAPI_BASE_URL}/${req.service}/${req.version}/${req.endpoint}`)
  
  // Add API key and any additional parameters
  url.searchParams.append('key', apiKey)
  if (req.params) {
    Object.entries(req.params).forEach(([key, value]) => {
      url.searchParams.append(key, value.toString())
    })
  }

  // Make the request to Google API
  const response = await fetch(url.toString(), {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: req.body ? JSON.stringify(req.body) : undefined
  })

  // Return the response
  const data = await response.json()
  return {
    success: response.ok,
    status: response.status,
    data
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Parse request
    const input: GAPIRequest = await req.json()

    // Validate required fields
    if (!input.service || !input.version || !input.endpoint || !input.method) {
      throw new Error('Missing required fields: service, version, endpoint, method')
    }

    // Handle the request
    const result = await handleGAPIRequest(input)
    return createResponse(result)

  } catch (error: unknown) {
    console.error('Error in wrappedgapi:', error)
    return createResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    }, 500)
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:8000/functions/v1/wrappedgapi' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
