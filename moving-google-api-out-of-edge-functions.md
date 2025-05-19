# Moving Google API Access Out of Edge Functions

## Problem Summary

Our tests conclusively show that Google API access via JWT authentication is too CPU-intensive for Supabase Edge Functions. The repeated pattern of errors:

- `CPU time soft limit reached`
- `early termination has been triggered`
- `connection closed before message completed`
- `exit 137` (Out of memory error)

This is happening during the JWT authentication step, which is computationally expensive and cannot be optimized further within the Edge Function environment.

## Recommended Solution Architecture

The recommended approach is to move the Google API authentication and API calls out of Edge Functions into:

1. **A dedicated microservice** with more CPU/memory resources
2. **A serverless function with higher resource limits** (e.g., AWS Lambda with higher memory allocation)
3. **A client-side solution** for browser-based applications

## Implementation Options

### Option 1: Dedicated Authentication Server

Create a standalone service (e.g., Node.js) outside of Supabase that:
- Handles authentication with Google APIs
- Maintains token caching
- Provides a simple REST API for your application
- Has appropriate resources allocated

This can be deployed on:
- A VPS (DigitalOcean, Linode, etc.)
- Kubernetes
- Render, Fly.io, Railway, or similar PaaS

### Option 2: Use Higher-Resource Serverless

Switch to a serverless platform with higher CPU/memory limits:
- AWS Lambda with increased memory (which proportionally increases CPU)
- Google Cloud Functions with higher resource allocation
- Azure Functions with premium plans

### Option 3: Pre-Generate Tokens for Use in Edge Functions

1. Generate Google API tokens externally
2. Store them in Supabase Keystore
3. Have Edge Functions only use the pre-generated tokens, not handle authentication

### Option 4: Move to Client for Auth Apps

For browser-based applications, use the Google Identity Platform directly on the client side:
- Google Sign-In
- OAuth 2.0 for client-side
- Keep sensitive API keys out of client code by using limited scope tokens

## Next Steps

1. Choose one of the approaches above based on your specific requirements
2. Refactor the GAPI wrapper to be a standalone service
3. Update the integration points in your application to use the new service
4. Implement proper token caching to minimize authentication overhead

## Conclusion

The fundamental issue is that Google's JWT authentication process is computationally expensive, requiring asymmetric cryptography operations that exceed Supabase Edge Function CPU limits. By moving this process out of Edge Functions, we can achieve reliable Google API integration without timeouts or resource limit errors. 