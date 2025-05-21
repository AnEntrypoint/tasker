import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders } from '../quickjs/cors.ts'
import { JWT } from 'npm:google-auth-library@^9'
import { google } from 'npm:googleapis@^133'
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.10/server"
import type { ChainItem } from "npm:sdk-http-wrapper@1.0.10/server"

// In-memory token cache by scope - persists between requests
const tokenCache = new Map<string, {
  token: string;
  expiry: number;
}>();

// Cached credentials and admin email
let cachedCreds: any = null;
let cachedAdminEmail: string | null = null;

// Get keystore base URL
const keystoreUrl = `${Deno.env.get('SUPABASE_URL') || 'http://127.0.0.1:8000'}/functions/v1/wrappedkeystore`;

// Cache control values
const TOKEN_REFRESH_BUFFER = 300000; // Refresh token 5 minutes before expiry

/**
 * Get credentials from keystore with caching
 */
async function getCredentials(): Promise<any> {
  if (cachedCreds) return cachedCreds;
  
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  
  const response = await fetch(keystoreUrl, {
    method: "POST",
  headers: {
      "Content-Type": "application/json",
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': anonKey
    },
    body: JSON.stringify({
      action: "getKey",
      namespace: "global",
      key: "GAPI_KEY"
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get credentials: ${response.status}`);
  }
  
  try {
    // Get response text
    const credText = await response.text();
    console.log(`Got credentials response, length: ${credText.length}`);
    
    // The keystore service returns a double-quoted JSON string
    // First, parse the outer JSON string
    const unquotedText = JSON.parse(credText);
    
    // Then parse the actual credential JSON
    cachedCreds = JSON.parse(unquotedText);
    
    console.log(`Loaded credentials for ${cachedCreds.client_email}`);
    return cachedCreds;
  } catch (error) {
    console.error(`Credential parsing error: ${(error as Error).message}`);
    throw new Error(`Failed to parse credentials: ${(error as Error).message}`);
  }
}

/**
 * Get admin email with caching
 */
async function getAdminEmail(): Promise<string> {
  if (cachedAdminEmail) return cachedAdminEmail;
  
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  
  const response = await fetch(keystoreUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': anonKey
    },
    body: JSON.stringify({
      action: "getKey",
      namespace: "global",
      key: "GAPI_ADMIN_EMAIL"
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get admin email: ${response.status}`);
  }
  
  try {
    const responseText = await response.text();
    console.log(`Got admin email response, length: ${responseText.length}`);
    
    // Parse the JSON string
    const emailValue = JSON.parse(responseText);
    
    if (!emailValue || emailValue.trim() === '') {
      throw new Error('Empty or invalid admin email received');
    }
    
    // Ensure we have a non-null string
    const email: string = emailValue;
    cachedAdminEmail = email;
    console.log(`Loaded admin email: ${cachedAdminEmail}`);
    return cachedAdminEmail;
  } catch (error) {
    console.error(`Admin email parsing error: ${(error as Error).message}`);
    throw new Error(`Failed to parse admin email: ${(error as Error).message}`);
  }
}

/**
 * Get access token with caching
 */
async function getAccessToken(scopes: string[]): Promise<string> {
  // Sort scopes to ensure consistent cache key
  const scopeKey = [...scopes].sort().join(',');
  
  // Check cache first
  const now = Date.now();
  const cachedData = tokenCache.get(scopeKey);
  
  if (cachedData && cachedData.expiry > now + TOKEN_REFRESH_BUFFER) {
    console.log(`Using cached token for ${scopeKey}`);
    return cachedData.token;
  }
  
  console.log(`Generating new token for ${scopeKey}`);
  const creds = await getCredentials();
  const adminEmail = await getAdminEmail();
  
  // Create JWT client with the requested scopes
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: scopes,
    subject: adminEmail
  });
  
  // Get token - this is the CPU-intensive part
  await jwt.authorize();
  
  if (!jwt.credentials.access_token || !jwt.credentials.expiry_date) {
    throw new Error('Failed to get valid token');
  }
  
  // Cache the token
  tokenCache.set(scopeKey, {
    token: jwt.credentials.access_token as string,
    expiry: jwt.credentials.expiry_date as number
  });
  
  const expiryDate = new Date(jwt.credentials.expiry_date as number).toISOString();
  console.log(`Generated new token, expires at ${expiryDate}`);
  return jwt.credentials.access_token as string;
}

// Main server handler
serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Fast health check
    const url = new URL(req.url);
    if (url.pathname.endsWith('/health')) {
      return new Response(
        JSON.stringify({ 
          status: 'ok', 
        cache_size: tokenCache.size,
          timestamp: new Date().toISOString() 
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
  try {
    // Get request body
    const body = await req.json().catch(() => ({ method: 'unknown' }));
    
    // Echo for testing
    if (body?.method === 'echo') {
      return new Response(
        JSON.stringify({ echo: body.args[0] || {} }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Handle credentials check
    if (body?.method === 'checkCredentials') {
      try {
        const adminEmail = await getAdminEmail();
        const creds = await getCredentials();
        
        return new Response(
          JSON.stringify({
            status: 'ok',
            adminEmail: adminEmail,
            clientEmail: creds.client_email,
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: 'error',
            error: (error as Error).message,
            timestamp: new Date().toISOString()
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Handle token info - returns info about cached tokens
    if (body?.method === 'getTokenInfo') {
      const tokenInfo = Array.from(tokenCache.entries()).map(([scope, data]) => ({
        scope,
        expires: new Date(data.expiry).toISOString(),
        valid: data.expiry > Date.now()
      }));
      
      return new Response(
        JSON.stringify({
          tokens: tokenInfo,
          count: tokenInfo.length,
          timestamp: new Date().toISOString()
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Handle clear token cache
    if (body?.method === 'clearTokenCache') {
      const scope = body.args?.[0];
      
      if (scope) {
        tokenCache.delete(scope);
        return new Response(
          JSON.stringify({
            status: 'ok',
            message: `Cleared token cache for scope: ${scope}`,
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } else {
        tokenCache.clear();
        return new Response(
          JSON.stringify({ 
            status: 'ok',
            message: 'Cleared all token caches',
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Admin domains direct implementation with token caching
    if (body?.chain?.[0]?.property === 'admin' && 
        body.chain[1]?.property === 'domains' && 
        body.chain[2]?.property === 'list') {
      
      try {
        // Get admin email - cached after first call
        const adminEmail = await getAdminEmail();
        
        // Get token - will use cache if available
        const token = await getAccessToken([
          'https://www.googleapis.com/auth/admin.directory.domain.readonly'
        ]);
        
        // Get customer ID from request or use 'my_customer' as default
        // IMPORTANT: For Google Admin API, use 'my_customer' to refer to the customer
        // that the authenticated admin belongs to. Do not use admin email as customer ID.
        // Only use specific customer ID values for multi-tenant situations.
        const customerArgs = body.chain[2]?.args?.[0] || {};
        let customerId: string;
        
        if (customerArgs.customer) {
          if (customerArgs.customer === adminEmail) {
            // If someone passed the admin email as customer, convert it to my_customer
            customerId = 'my_customer';
            console.log(`Converting admin email to my_customer`);
          } else {
            customerId = encodeURIComponent(customerArgs.customer);
          }
        } else {
          customerId = 'my_customer';
        }
        
        console.log(`Using customer ID: ${customerId}`);
        
        // Make direct API call using cached token
        const domainsUrl = `https://admin.googleapis.com/admin/directory/v1/customer/${customerId}/domains`;
        const response = await fetch(domainsUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          return new Response(
            JSON.stringify(data),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          const errorBody = await response.text();
          throw new Error(`Google API returned ${response.status}: ${errorBody}`);
        }
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: `Domain list error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // For all other Google API requests, use the SDK processor
    return await processSdkRequest(req, {
      sdkConfig: {
        gapi: {
          factory: async (chain: ChainItem[]) => {
            try {
              // Get service type
              const svc = chain[0]?.property;
              
              // Get appropriate scopes
              const scopes = [];
              if (svc === 'gmail') {
                scopes.push('https://www.googleapis.com/auth/gmail.readonly');
                scopes.push('https://mail.google.com/');
              } else if (svc === 'admin') {
                scopes.push('https://www.googleapis.com/auth/admin.directory.user.readonly');
                scopes.push('https://www.googleapis.com/auth/admin.directory.domain.readonly');
                scopes.push('https://www.googleapis.com/auth/admin.directory.customer.readonly');
              }
              
              // Get token - will use cache if available
              const token = await getAccessToken(scopes);
              
              // Create Google service with accessToken auth
              if (svc === 'admin') {
                return google.admin({
                  version: 'directory_v1',
                  auth: new google.auth.GoogleAuth({
                    credentials: { access_token: token } as unknown as object
                  })
                });
              } else if (svc === 'gmail') {
                return google.gmail({
                  version: 'v1',
                  auth: new google.auth.GoogleAuth({
                    credentials: { access_token: token } as unknown as object
                  })
                });
              } else {
                throw new Error(`Unsupported Google service: ${svc}`);
              }
            } catch (error) {
              console.error(`Service factory error: ${(error as Error).message}`);
              throw error;
            }
          },
          methodWrapper: async (svc: any, method: any, args: any[]) => {
            try {
              return await method(...args);
            } catch (error) {
              throw new Error(`API call failed: ${(error as Error).message}`);
            }
          }
        }
      },
      corsHeaders
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        error: (error as Error).message || "Unknown error",
        timestamp: new Date().toISOString()
      }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
