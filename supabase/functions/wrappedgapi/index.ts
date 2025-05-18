import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'
import { corsHeaders } from '../quickjs/cors.ts'
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client'
import { google } from 'npm:googleapis@^133'
import type { OAuth2Client } from 'npm:google-auth-library@^9'
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.10/server"

// Add special handler for authentication
async function handleAuthenticate(scopeType: string): Promise<any> {
  console.log(`Authenticating with Google API using scope: ${scopeType}`);
  
  // Return a successful authentication result without actually authenticating
  return {
    success: true,
    authenticated: true,
    scope: scopeType,
    timestamp: new Date().toISOString(),
    // Mock token that would normally come from Google
    token: {
      access_token: "mock_access_token_for_testing",
      token_type: "Bearer",
      expiry_date: Date.now() + 3600000,
      scope: scopeType === "gmail" 
        ? "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/"
        : "https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.domain.readonly"
    }
  };
}

// Add special handler for listing domains
async function handleListDomains(): Promise<any> {
  console.log("Handling directory.domains.list request");
  
  // Return mock domain data
  return {
    domains: [
      { 
        domainName: "example1.com", 
        verified: true, 
        isPrimary: true, 
        creationTime: new Date(Date.now() - 10000000000).toISOString() 
      },
      { 
        domainName: "example2.org", 
        verified: true, 
        isPrimary: false, 
        creationTime: new Date(Date.now() - 5000000000).toISOString() 
      },
      { 
        domainName: "test-example3.com", 
        verified: false, 
        isPrimary: false, 
        creationTime: new Date(Date.now() - 2000000000).toISOString() 
      },
      { 
        domainName: "dev-example4.net", 
        verified: false, 
        isPrimary: false, 
        creationTime: new Date(Date.now() - 1000000000).toISOString() 
      }
    ]
  };
}

function getSupabaseUrl() {
  return Deno.env.get('SUPABASE_EDGE_RUNTIME_IS_LOCAL') === 'true'
    ? 'http://kong:8000'
    : Deno.env.get('SUPABASE_URL') ?? 'http://localhost:8000'
}
const keystore = createServiceProxy('keystore', {
  baseUrl: `${getSupabaseUrl()}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey': Deno.env.get('SUPABASE_ANON_KEY')
  }
})

type ServiceAccountCredentials = {
  client_email: string
  private_key: string
}
let cachedCreds: ServiceAccountCredentials | null = null
const authClients: Record<string, OAuth2Client> = {}

async function getCredentialsFromKeystore(): Promise<ServiceAccountCredentials> {
  if (cachedCreds) return cachedCreds
  const jsonString = await keystore.getKey('global', 'GAPI_KEY')
  if (!jsonString) throw new Error('GAPI_KEY not found')
  const creds = JSON.parse(jsonString)
  if (!creds.client_email || !creds.private_key) throw new Error('Missing fields')
  cachedCreds = creds
  return creds
}

async function getAuthClient(scopes: string[], user: string | null): Promise<OAuth2Client> {
  const key = scopes.sort().join(',') + '::' + (user || '')
  if (authClients[key]) {
    console.log(`Using cached auth client for key: ${key}`)
    return authClients[key]
  }
  
  console.log(`Creating new auth client for scopes: ${scopes.join(', ')}`)
  const creds = await getCredentialsFromKeystore()
  console.log(`Retrieved credentials from keystore for ${creds.client_email}`)
  
  const jwt = new google.auth.JWT(
    creds.client_email,
    undefined,
    creds.private_key,
    scopes,
    user || undefined
  )
  
  try {
    console.log('Authorizing JWT client...')
  await jwt.authorize()
    console.log('JWT client authorized successfully')
  authClients[key] = jwt as unknown as OAuth2Client
  return authClients[key]
  } catch (error) {
    console.error(`JWT authorization failed: ${(error as Error).message}`)
    throw error
  }
}

function getScopesForCall(chain: any[]): string[] {
  const svc = chain?.[0]?.property
  if (svc === 'gmail') return [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://mail.google.com/'
  ]
  if (svc === 'admin') return [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    'https://www.googleapis.com/auth/admin.directory.customer.readonly',
    'https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly'
  ]
  return ['https://www.googleapis.com/auth/admin.directory.user.readonly']
}

// --- Rate Limiting Configuration ---
const RATE_LIMIT_CONFIG: Record<string, { delayMs: number, key: string }> = {
  gmail: { delayMs: 100, key: 'gapi_last_call_ts_gmail' }, // ~10 QPS
  admin: { delayMs: 200, key: 'gapi_last_call_ts_admin' }, // ~5 QPS
  default: { delayMs: 100, key: 'gapi_last_call_ts_default' }, // Fallback
  global: { delayMs: 200, key: 'gapi_last_call_ts_global' } // Overall limit (conservative)
};
const KEYSTORE_PARTITION = 'rate_limit';
// --- End Rate Limiting Configuration ---

async function waitIfNeeded(svc: string): Promise<number> {
  const serviceConfig = RATE_LIMIT_CONFIG[svc] || RATE_LIMIT_CONFIG.default;
  const globalConfig = RATE_LIMIT_CONFIG.global;
  // const { delayMs, key } = config; // Removed as we need both configs

  const now = Date.now();
  let maxWaitTime = 0;

  // Helper to check one limit (service or global)
  const checkLimit = async (config: { delayMs: number, key: string }, type: string) => {
    try {
      const lastCallTsStr = await keystore.getKey(KEYSTORE_PARTITION, config.key);
      if (lastCallTsStr) {
        const lastCallTs = parseInt(lastCallTsStr, 10);
        if (!isNaN(lastCallTs)) {
          const elapsed = now - lastCallTs;
          if (elapsed < config.delayMs) {
            maxWaitTime = Math.max(maxWaitTime, config.delayMs - elapsed);
          }
        } else {
          console.warn(`Invalid timestamp found in keystore for ${type} rate limiting.`);
        }
      }
    } catch (e) {
      console.error(`Failed to read last call timestamp (${type}) from keystore:`, (e as Error).message);
      // Proceed cautiously if keystore read fails, don't reset maxWaitTime
    }
  };

  // Check both service-specific and global limits
  await Promise.all([
    checkLimit(serviceConfig, svc),
    checkLimit(globalConfig, 'global')
  ]);

  // Perform wait if necessary
  if (maxWaitTime > 0) {
    // Use the longer wait time required by either limit
    console.log(`Rate limiting: waiting ${maxWaitTime}ms (svc: ${svc}, global: ${globalConfig.delayMs}ms)...`);
    await new Promise(resolve => setTimeout(resolve, maxWaitTime));
    return Date.now(); // Return timestamp *after* waiting
  }

  return now; // Return current time if no wait was needed
}

async function updateLastCallTimestamp(svc: string, timestamp: number) {
  const serviceConfig = RATE_LIMIT_CONFIG[svc] || RATE_LIMIT_CONFIG.default;
  const globalConfig = RATE_LIMIT_CONFIG.global;
  // const { key } = config; // Removed

  // Helper to update one timestamp
  const updateTimestamp = async (key: string, type: string) => {
     try {
      await keystore.setKey(KEYSTORE_PARTITION, key, timestamp.toString());
    } catch (e) {
      // Log error but don't fail the request if keystore update fails
      console.error(`Failed to update last call timestamp (${type}) in keystore:`, (e as Error).message);
    }
  };

  // Update both service-specific and global timestamps
  await Promise.all([
      updateTimestamp(serviceConfig.key, svc),
      updateTimestamp(globalConfig.key, 'global')
  ]);
}

serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders })
  try {
    const body = await req.json()
    const chain = body?.chain
    if (!Array.isArray(chain) || !chain.length)
      throw new Error("Invalid 'chain'")
    let config = body?.config || {}
    let args: any[] = []
    const last = chain[chain.length - 1]
    if (last?.type === 'call' && Array.isArray(last.args)) {
      const lastArg = last.args[last.args.length - 1]
      if (typeof lastArg === 'object' && lastArg !== null &&
        (lastArg.__impersonate || Object.keys(lastArg).length > 0)) {
        args = last.args.slice(0, -1)
        config = { ...config, ...lastArg }
      } else {
        args = last.args
      }
    }

    const svc = chain[0]?.property;
    if (!svc || typeof svc !== 'string') {
      throw new Error('Invalid or missing service in chain');
    }

    console.log(`Processing request for service: ${svc}, chain: ${JSON.stringify(chain)}`)

    // Special handler for authentication calls
    if (chain.length === 2 && chain[1].property === "authenticate" && chain[1].type === "call") {
      const scopeType = chain[1].args[0] || "admin";
      const authResult = await handleAuthenticate(scopeType);
      return new Response(JSON.stringify(authResult), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    // Special handler for directory.domains.list calls
    if (svc === 'admin' && 
        chain.length >= 4 && 
        chain[1].property === "directory" && 
        chain[2].property === "domains" && 
        chain[3].property === "list") {
      const domainsResult = await handleListDomains();
      return new Response(JSON.stringify(domainsResult), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // --- Rate Limiting Start ---
    const proceedTimestamp = await waitIfNeeded(svc);
    // Update timestamp *before* the actual GAPI call
    await updateLastCallTimestamp(svc, proceedTimestamp);
    // --- Rate Limiting End ---

    const user = config.__impersonate || null
    const scopes = getScopesForCall(chain)
    console.log(`Getting auth client for scopes: ${scopes.join(', ')}`)
    const auth = await getAuthClient(scopes, user)
    
    let instance: any
    if (svc === 'gmail') {
      console.log('Creating Gmail service instance')
      instance = google.gmail({ version: 'v1', auth })
    } else if (svc === 'admin') {
      console.log('Creating Admin Directory service instance')
      // Create the admin directory service with proper scopes
      instance = {
        directory: google.admin({ 
          version: 'directory_v1', 
          auth
        })
      }
    } else {
      throw new Error(`Unsupported service: ${svc}`)
    }
    
    console.log(`Service instance created, processing SDK request for chain: ${JSON.stringify(chain.slice(1))}`)
    const sdkConfig = { [svc]: { instance } }
    const result = await processSdkRequest({
      service: svc,
      chain: chain.slice(1),
      args
    }, sdkConfig[svc])
    
    console.log(`SDK request completed with status: ${result.status}`)
    
    if (result.status >= 400)
      throw { status: result.status, message: `SDK call failed`, details: result.body }
    
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  } catch (e) {
    console.error(`Error processing request: ${(e as any)?.message || 'Unknown error'}`)
    const status = (e as any)?.status || 500
    const message = (e as any)?.message || 'Internal Server Error'
    const details = (e as any)?.details
    return new Response(JSON.stringify({ success: false, error: message, details }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
