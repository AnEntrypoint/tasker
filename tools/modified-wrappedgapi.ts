/**
 * modified-wrappedgapi.ts - Using external token service
 * 
 * This version of wrappedgapi would use an external token service
 * to avoid Edge Function CPU limits with JWT authentication.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders } from '../supabase/functions/quickjs/cors.ts'
import { google } from 'npm:googleapis@^133'
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client'
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.10/server"
import type { ChainItem } from "npm:sdk-http-wrapper@1.0.10/server"

// Configuration for the external token service
const TOKEN_SERVICE_URL = Deno.env.get('TOKEN_SERVICE_URL') || 'http://localhost:3000';

// Cache tokens to avoid unnecessary requests
let cachedTokens: Record<string, {token: string, expiry: number}> = {};
let cachedAdminEmail: string | null = null;

// Fast access to keystore for non-auth operations
const keystore = createServiceProxy('keystore', {
  baseUrl: `${Deno.env.get('SUPABASE_URL') || 'http://127.0.0.1:8000'}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey': Deno.env.get('SUPABASE_ANON_KEY')
  }
});

/**
 * Get a token from the external token service
 */
async function getTokenFromService(scopes: string[]): Promise<{token: string, expiry: number}> {
  // Check cache first
  const scopeKey = [...scopes].sort().join(',');
  const now = Date.now();
  
  if (cachedTokens[scopeKey] && cachedTokens[scopeKey].expiry > now + 60000) {
    return cachedTokens[scopeKey];
  }
  
  try {
    // Request token from external service
    const response = await fetch(`${TOKEN_SERVICE_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ scopes })
    });

    if (!response.ok) {
      throw new Error(`Token service returned ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    
    // Cache token
    cachedTokens[scopeKey] = {
      token: result.access_token,
      expiry: result.expiry
    };
    
    return cachedTokens[scopeKey];
  } catch (error) {
    console.error(`Token service error: ${(error as Error).message}`);
    throw new Error(`Failed to get token: ${(error as Error).message}`);
  }
}

/**
 * Get admin email from keystore (cached)
 */
async function getAdminEmail(): Promise<string> {
  if (!cachedAdminEmail) {
    cachedAdminEmail = await keystore.getKey('global', 'GAPI_ADMIN_EMAIL');
  }
  return cachedAdminEmail as string;
}

// Main server handler
serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Extract URL path for special endpoints
  const url = new URL(req.url);
  
  // Handle health check endpoint
  if (url.pathname.endsWith('/health')) {
    return new Response(
      JSON.stringify({ 
        status: 'ok', 
        mode: 'external-token-service',
        timestamp: new Date().toISOString() 
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  
  try {
    // Get request body
    const clonedReq = req.clone();
    const body = await clonedReq.json().catch(() => ({ method: 'unknown' }));
    
    // Handle echo request
    if (body?.method === 'echo') {
      return new Response(
        JSON.stringify({ 
          echo: body.args[0] || {}, 
          timestamp: new Date().toISOString()
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Handle domains.list directly - with external token
    if (body?.chain && 
        body.chain[0]?.property === 'admin' && 
        body.chain[1]?.property === 'domains' && 
        body.chain[2]?.property === 'list') {
      
      try {
        // Get admin email
        const adminEmail = await getAdminEmail();
        
        // Get token from external service
        const { token } = await getTokenFromService([
          'https://www.googleapis.com/auth/admin.directory.domain.readonly'
        ]);
        
        // Get customer ID from request or admin email
        const customerArgs = body.chain[2]?.args?.[0] || {};
        const customerId = encodeURIComponent(customerArgs.customer || adminEmail);
        
        // Make direct API call to Google
        const domainsUrl = `https://admin.googleapis.com/admin/directory/v1/customer/${customerId}/domains`;
        const response = await fetch(domainsUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        if (response.ok) {
          const result = await response.json();
          return new Response(
            JSON.stringify(result),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          throw new Error(`Google API returned ${response.status}: ${await response.text()}`);
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
    
    // For other Google API requests, use the SDK system
    // Process with SDK proxying (but using external token service)
    return await processSdkRequest(req, {
      sdkConfig: {
        gapi: {
          factory: async (chain: ChainItem[]) => {
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
            
            // Get token from external service
            const { token } = await getTokenFromService(scopes);
            
            // Get admin email
            const adminEmail = await getAdminEmail();
            
            // Create auth object using the pre-fetched token
            const auth = {
              getRequestHeaders: () => ({ 
                Authorization: `Bearer ${token}`
              })
            };
            
            // Create appropriate service with the auth object
            if (svc === 'admin') {
              return google.admin({ version: 'directory_v1', auth });
            } else if (svc === 'gmail') {
              return google.gmail({ version: 'v1', auth });
            } else {
              throw new Error(`Unsupported Google service: ${svc}`);
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