/**
 * google-token-service.js
 * 
 * A standalone microservice that handles Google API token generation
 * and caching to avoid CPU limits in Edge Functions.
 * 
 * This service would run on a dedicated server or higher-resource
 * serverless environment.
 */
const express = require('express');
const { JWT } = require('google-auth-library');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// In-memory token cache - in production use Redis or similar
const tokenCache = {
  // scope_key: { token, expiry }
};

// Service credentials - in production use secure env vars or secret management
let serviceAccountCredentials = null;
let adminEmail = null;

// Initialize credentials from env vars or a secure source
function initCredentials() {
  try {
    if (!serviceAccountCredentials) {
      // In production, load from secure environment variables or secret manager
      serviceAccountCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      adminEmail = process.env.GOOGLE_ADMIN_EMAIL;
      
      if (!serviceAccountCredentials || !adminEmail) {
        throw new Error('Missing credentials or admin email');
      }
      
      console.log('Credentials loaded successfully');
    }
  } catch (error) {
    console.error('Failed to initialize credentials:', error);
    throw error;
  }
}

/**
 * Generate a Google API token with the specified scopes
 */
async function generateToken(scopes) {
  try {
    // Ensure credentials are loaded
    initCredentials();
    
    // Create a sorted scope key for caching
    const scopeKey = Array.isArray(scopes) ? [...scopes].sort().join(',') : scopes;
    
    // Check cache first
    const now = Date.now();
    if (tokenCache[scopeKey] && tokenCache[scopeKey].expiry > now + 60000) {
      console.log(`Using cached token for scopes: ${scopeKey}`);
      return {
        access_token: tokenCache[scopeKey].token,
        expiry: tokenCache[scopeKey].expiry,
        cached: true
      };
    }
    
    // Create JWT client
    console.log(`Generating new token for scopes: ${scopeKey}`);
    const jwt = new JWT({
      email: serviceAccountCredentials.client_email,
      key: serviceAccountCredentials.private_key,
      scopes: Array.isArray(scopes) ? scopes : [scopes],
      subject: adminEmail
    });
    
    // Generate token
    await jwt.authorize();
    
    // Cache the token
    tokenCache[scopeKey] = {
      token: jwt.credentials.access_token,
      expiry: jwt.credentials.expiry_date
    };
    
    return {
      access_token: jwt.credentials.access_token,
      expiry: jwt.credentials.expiry_date,
      cached: false
    };
  } catch (error) {
    console.error('Token generation error:', error);
    throw error;
  }
}

// API Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Token generation endpoint
app.post('/token', async (req, res) => {
  try {
    const { scopes } = req.body;
    
    if (!scopes) {
      return res.status(400).json({ 
        error: 'Missing required parameter: scopes',
        timestamp: new Date().toISOString()
      });
    }
    
    const tokenData = await generateToken(scopes);
    
    res.json({
      access_token: tokenData.access_token,
      expiry: tokenData.expiry,
      cached: tokenData.cached,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Cache management - clear specific scope or all
app.delete('/token', (req, res) => {
  const { scope } = req.query;
  
  if (scope) {
    delete tokenCache[scope];
    res.json({ message: `Cache cleared for scope: ${scope}` });
  } else {
    // Clear all cache
    Object.keys(tokenCache).forEach(key => delete tokenCache[key]);
    res.json({ message: 'All token cache cleared' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Google Token Service running on port ${port}`);
}); 