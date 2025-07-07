/**
 * CORS handling for Edge Functions
 * 
 * Provides standardized CORS headers and utilities for all wrapped services.
 * 
 * @module supabase/functions/_shared/cors
 */

/**
 * Default CORS headers for all responses
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

/**
 * Handles OPTIONS preflight requests with proper CORS headers
 * 
 * @param request The request object
 * @param additionalHeaders Additional headers to include
 * @returns Response for preflight requests
 */
export function handleCorsOptions(
  request: Request,
  additionalHeaders: Record<string, string> = {}
): Response {
  // Get the Access-Control-Request-Headers from the request
  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  
  // Create merged headers
  const headers = {
    ...corsHeaders,
    ...additionalHeaders
  };
  
  // Add the requested headers to the allowed headers if provided
  if (requestHeaders) {
    headers["Access-Control-Allow-Headers"] = 
      `${headers["Access-Control-Allow-Headers"]}, ${requestHeaders}`;
  }
  
  // Return empty 204 response with CORS headers
  return new Response(null, {
    status: 204,
    headers
  });
}

/**
 * Add CORS headers to an existing Response
 * 
 * @param response The original response 
 * @param additionalHeaders Additional headers to include
 * @returns New response with CORS headers added
 */
export function addCorsHeaders(
  response: Response,
  additionalHeaders: Record<string, string> = {}
): Response {
  // Create new response headers
  const newHeaders = new Headers(response.headers);
  
  // Add all CORS headers
  const allHeaders = { ...corsHeaders, ...additionalHeaders };
  Object.entries(allHeaders).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  
  // Create new response with updated headers
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

/**
 * Create a standardized CORS response
 * 
 * @param body Response body
 * @param status HTTP status code
 * @param additionalHeaders Additional headers
 * @returns Response with CORS headers
 */
export function createCorsResponse(
  body: BodyInit | null,
  status: number = 200,
  additionalHeaders: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders,
      ...additionalHeaders
    }
  });
} 