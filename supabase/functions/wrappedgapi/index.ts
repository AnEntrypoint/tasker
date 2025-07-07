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
async function getAccessToken(scopes: string[], impersonatedUserEmail?: string): Promise<string> {
  // Sort scopes and include user email to ensure consistent and correct cache key
  const scopeUserKey = impersonatedUserEmail 
    ? [...scopes].sort().join(',') + `_for_${impersonatedUserEmail}`
    : [...scopes].sort().join(',');
  
  // Check cache first
  const now = Date.now();
  const cachedData = tokenCache.get(scopeUserKey);
  
  if (cachedData && cachedData.expiry > now + TOKEN_REFRESH_BUFFER) {
    console.log(`Using cached token for ${scopeUserKey}`);
    return cachedData.token;
  }
  
  console.log(`Generating new token for ${scopeUserKey}`);
  const creds = await getCredentials();
  
  // Determine the subject for impersonation
  const subjectToImpersonate = impersonatedUserEmail || await getAdminEmail();
  console.log(`Attempting to impersonate: ${subjectToImpersonate} for scopes: ${scopes.join(', ')}`);
  
  // Create JWT client with the requested scopes
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: scopes,
    subject: subjectToImpersonate // Use dynamic subject
  });
  
  // Get token - this is the CPU-intensive part
  await jwt.authorize();
  
  if (!jwt.credentials.access_token || !jwt.credentials.expiry_date) {
    throw new Error('Failed to get valid token');
  }
  
  // Cache the token
  tokenCache.set(scopeUserKey, {
    token: jwt.credentials.access_token as string,
    expiry: jwt.credentials.expiry_date as number
  });
  
  const expiryDate = new Date(jwt.credentials.expiry_date as number).toISOString();
  console.log(`Generated new token for ${scopeUserKey}, expires at ${expiryDate}`);
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
    if ((body?.chain?.[0]?.property === 'admin' && 
        body.chain[1]?.property === 'domains' && 
        body.chain[2]?.property === 'list') ||
        (body?.methodChain && 
         body.methodChain[0] === 'admin' && 
         body.methodChain[1] === 'domains' && 
         body.methodChain[2] === 'list')) {
      
      try {
        // Get parameters from the request (handle both formats)
        const domainsArgs = body.methodChain ? 
          (body.args?.[0] || {}) :                    // methodChain format  
          (body.chain?.[2]?.args?.[0] || {});         // chain format
        
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
        const customerArgs = domainsArgs; // Use the same args we already parsed
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
    
    // Admin users direct implementation with token caching
    if ((body?.chain?.[0]?.property === 'admin' && 
        body.chain[1]?.property === 'users' && 
         body.chain[2]?.property === 'list') ||
        (body?.chain?.[0]?.property === 'admin' && 
         body.chain[1]?.property === 'directory' &&
         body.chain[2]?.property === 'users' &&
         body.chain[3]?.property === 'list') ||
        (body?.methodChain && 
         body.methodChain[0] === 'admin' && 
         body.methodChain[1] === 'users' && 
         body.methodChain[2] === 'list')) {
      
      try {
        // Get admin email - cached after first call
        const adminEmail = await getAdminEmail();
        
        // Get token with appropriate scopes for user management
        const token = await getAccessToken([
          'https://www.googleapis.com/auth/admin.directory.user.readonly'
        ]);
        
        // Get parameters from the request - handle both admin.users.list and admin.directory.users.list and methodChain format
        const usersArgs = body.methodChain ? 
          (body.args?.[0] || {}) :             // methodChain format
          (body.chain[2]?.property === 'list' ? 
            (body.chain[2]?.args?.[0] || {}) :  // admin.users.list format
            (body.chain[3]?.args?.[0] || {}));   // admin.directory.users.list format
        
        console.log(`Processing users.list request with args:`, usersArgs);
        
        // Build query parameters
        const queryParams = new URLSearchParams();
        
        // Add domain parameter if specified
        if (usersArgs.domain) {
          queryParams.set('domain', usersArgs.domain);
          console.log(`Filtering users by domain: ${usersArgs.domain}`);
        }
        
        // Add maxResults parameter if specified (default to 100 if not specified)
        const maxResults = usersArgs.maxResults || 100;
        queryParams.set('maxResults', maxResults.toString());
        
        // Add customer parameter - use my_customer if not specified
        if (usersArgs.customer) {
          queryParams.set('customer', usersArgs.customer);
        } else {
          queryParams.set('customer', 'my_customer');
        }
        
        // Add orderBy parameter if specified
        if (usersArgs.orderBy) {
          queryParams.set('orderBy', usersArgs.orderBy);
        }
        
        // Add query parameter if specified
        if (usersArgs.query) {
          queryParams.set('query', usersArgs.query);
        }
        
        // Add showDeleted parameter if specified
        if (usersArgs.showDeleted) {
          queryParams.set('showDeleted', usersArgs.showDeleted.toString());
        }
        
        // Add viewType parameter if specified
        if (usersArgs.viewType) {
          queryParams.set('viewType', usersArgs.viewType);
        }
        
        console.log(`Listing users with params: ${queryParams.toString()}`);
        
        // Make direct API call using cached token
        const usersUrl = `https://admin.googleapis.com/admin/directory/v1/users?${queryParams.toString()}`;
        console.log(`Making API call to: ${usersUrl}`);
        
        const response = await fetch(usersUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        console.log(`API response status: ${response.status}`);
        
        if (response.ok) {
          const data = await response.json();
          console.log(`Successfully retrieved ${data.users?.length || 0} users`);
          return new Response(
            JSON.stringify(data),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          const errorBody = await response.text();
          console.error(`Google API error: ${response.status} - ${errorBody}`);
          throw new Error(`Google API returned ${response.status}: ${errorBody}`);
        }
      } catch (error) {
        console.error(`User list error: ${(error as Error).message}`);
        return new Response(
          JSON.stringify({ 
            error: `User list error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Gmail users messages list direct implementation with token caching
    if ((body?.chain?.[0]?.property === 'gmail' && 
        body.chain[1]?.property === 'users' && 
        body.chain[2]?.property === 'messages' &&
        body.chain[3]?.property === 'list') ||
        (body?.method === 'gmail.users.messages.list') ||
        (body?.methodChain && 
         body.methodChain[0] === 'gmail' && 
         body.methodChain[1] === 'users' && 
         body.methodChain[2] === 'messages' && 
         body.methodChain[3] === 'list')) {
      
      try {
        // Get parameters from the request
        const messagesArgs = body.chain?.[3]?.args?.[0] || body.args?.[0] || {};
        
        // Extract the target userId for impersonation.
        // If messagesArgs.userId is present and not 'me', use it. 
        // Otherwise, the service account acts on its own behalf or as the default admin for 'me'.
        const impersonationSubject = (messagesArgs.userId && messagesArgs.userId !== 'me') 
          ? messagesArgs.userId 
          : await getAdminEmail(); // Fallback to admin email if userId is 'me' or not provided for impersonation context

        console.log(`Targeting user for impersonation (if applicable for scopes): ${impersonationSubject}`);
              
        // Get token with Gmail scopes, passing the specific user to impersonate
        const token = await getAccessToken(
          [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://mail.google.com/'
          ],
          impersonationSubject 
        );
        
        console.log(`Processing gmail.users.messages.list request with args:`, messagesArgs);
        
        // Build query parameters
        const queryParams = new URLSearchParams();
        
        // Add required userId parameter (default to 'me' if not specified, which Gmail API interprets as the authenticated user)
        const userIdForApiCall = messagesArgs.userId || 'me'; // This is for the API path
        
        // Add q parameter (search query) if specified
        if (messagesArgs.q) {
          queryParams.set('q', messagesArgs.q);
          console.log(`Gmail search query: ${messagesArgs.q}`);
        }
        
        // Add maxResults parameter if specified (default to 100 if not specified)
        const maxResults = messagesArgs.maxResults || 100;
        queryParams.set('maxResults', maxResults.toString());
        
        // Add pageToken parameter if specified (for pagination)
        if (messagesArgs.pageToken) {
          queryParams.set('pageToken', messagesArgs.pageToken);
              }
              
        // Add labelIds parameter if specified
        if (messagesArgs.labelIds && Array.isArray(messagesArgs.labelIds)) {
          messagesArgs.labelIds.forEach((labelId: string) => {
            queryParams.append('labelIds', labelId);
          });
        }
        
        // Add includeSpamTrash parameter if specified
        if (messagesArgs.includeSpamTrash !== undefined) {
          queryParams.set('includeSpamTrash', messagesArgs.includeSpamTrash.toString());
        }
        
        console.log(`Listing Gmail messages for user ${userIdForApiCall} with params: ${queryParams.toString()}`);
        
        // Make direct API call using cached token
        const messagesUrl = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userIdForApiCall)}/messages?${queryParams.toString()}`;
        console.log(`Making Gmail API call to: ${messagesUrl}`);
        
        const response = await fetch(messagesUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        console.log(`Gmail API response status: ${response.status}`);
        
        if (response.ok) {
          const data = await response.json();
          console.log(`Successfully retrieved ${data.messages?.length || 0} messages`);
          return new Response(
            JSON.stringify(data),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
              } else {
          const errorBody = await response.text();
          console.error(`Gmail API error: ${response.status} - ${errorBody}`);
          throw new Error(`Gmail API returned ${response.status}: ${errorBody}`);
              }
            } catch (error) {
        console.error(`Gmail messages list error: ${(error as Error).message}`);
        return new Response(
          JSON.stringify({ 
            error: `Gmail messages list error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // For other Google API requests, return an error message to force direct implementation
    console.error(`Unsupported GAPI request format:`, JSON.stringify(body, null, 2));
    return new Response(
      JSON.stringify({ 
        error: `Unsupported GAPI request format. Only direct admin.domains.list, admin.users.list, and gmail.users.messages.list are supported.`,
        request: body,
        timestamp: new Date().toISOString()
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
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
