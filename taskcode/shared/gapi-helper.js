/**
 * Helper module for safely calling Google API services from QuickJS tasks
 */

/**
 * Safely calls a GAPI service with a method path
 * @param {Object} context - The task context object
 * @param {string[]} path - Array of path segments (e.g., ["admin", "domains", "list"])
 * @param {Array<any>} args - Arguments to pass to the method
 * @returns {Promise<any>} - The result of the GAPI call
 */
async function callGapiService(context, path, args) {
  console.log(`Calling GAPI with path: [${path.join(", ")}]`);
  
  // Always prefer the direct __callHostTool__ approach
  // This is the most reliable way to call GAPI services
  if (typeof __callHostTool__ === "function") {
    console.log("Using __callHostTool__ for direct GAPI call");
    return await __callHostTool__("gapi", path, args || []);
  }
  
  // If __callHostTool__ is not available (which should not happen in normal operation),
  // fall back to object navigation as a last resort
  console.warn("WARNING: __callHostTool__ not available, falling back to object navigation");
  
  // Ensure we have the tools object
  if (!context || !context.tools) {
    throw new Error("Task context or tools object is undefined");
  }
  
  // Ensure we have the gapi service
  let current = context.tools.gapi;
  if (!current) {
    throw new Error("GAPI service is not available in tools object");
  }
  
  // Navigate to the nested property
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]];
    if (!current) {
      throw new Error(`GAPI path segment '${path[i]}' is not available`);
    }
  }
  
  // Get the final method
  const methodName = path[path.length - 1];
  const method = current[methodName];
  if (typeof method !== "function") {
    throw new Error(`GAPI method '${methodName}' is not a function`);
  }
  
  // Call the method with the provided arguments
  console.log(`Calling ${path.join('.')} via object navigation`);
  try {
    return await method.apply(current, args || []);
  } catch (error) {
    console.error(`Error calling ${path.join('.')}: ${error.message || String(error)}`);
    throw error;
  }
}

/**
 * Lists Google Workspace domains for the organization
 * @param {Object} context - The task context object
 * @param {Object} options - Options for the call
 * @param {string} options.customer - Customer ID, usually "my_customer"
 * @returns {Promise<Object>} - The domains list result
 */
async function listDomains(context, options = { customer: "my_customer" }) {
  console.log(`Listing domains for customer: ${options.customer}`);
  
  try {
    const result = await callGapiService(
      context, 
      ["admin", "domains", "list"], 
      [{ customer: options.customer }]
    );
    
    // Process and normalize the result
    const domains = result.domains || [];
    console.log(`Found ${domains.length} domains`);
    
    return {
      success: true,
      count: domains.length,
      domains: domains.map(domain => ({
        name: domain.domainName,
        isPrimary: !!domain.isPrimary,
        verified: !!domain.verified,
        creationTime: domain.creationTime,
        raw: domain
      }))
    };
  } catch (error) {
    console.error(`Error listing domains: ${error.message || String(error)}`);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
}

/**
 * Lists Gmail messages for a user
 * @param {Object} context - The task context object
 * @param {Object} options - Options for the call
 * @param {string} options.userId - User email address, usually "me"
 * @param {string} options.q - Search query
 * @param {number} options.maxResults - Maximum results to return
 * @returns {Promise<Object>} - The messages list result
 */
async function listGmailMessages(context, options = { userId: "me", q: "", maxResults: 10 }) {
  console.log(`Searching Gmail for user ${options.userId} with query: ${options.q}`);
  
  try {
    const result = await callGapiService(
      context,
      ["gmail", "users", "messages", "list"],
      [{
        userId: options.userId,
        q: options.q,
        maxResults: options.maxResults
      }]
    );
    
    // Process and normalize the result
    const messages = result.messages || [];
    console.log(`Found ${messages.length} Gmail messages`);
    
    return {
      success: true,
      count: messages.length,
      messages: messages,
      nextPageToken: result.nextPageToken
    };
  } catch (error) {
    console.error(`Error searching Gmail: ${error.message || String(error)}`);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
}

/**
 * Gets a Gmail message by ID
 * @param {Object} context - The task context object
 * @param {Object} options - Options for the call
 * @param {string} options.userId - User email address, usually "me"
 * @param {string} options.id - Message ID
 * @param {boolean} options.format - Format of the message (full, minimal, raw)
 * @returns {Promise<Object>} - The message details
 */
async function getGmailMessage(context, options) {
  if (!options || !options.id) {
    throw new Error("Message ID is required");
  }
  
  console.log(`Getting Gmail message ${options.id} for user ${options.userId || "me"}`);
  
  try {
    const result = await callGapiService(
      context,
      ["gmail", "users", "messages", "get"],
      [{
        userId: options.userId || "me",
        id: options.id,
        format: options.format || "full"
      }]
    );
    
    return {
      success: true,
      message: result
    };
  } catch (error) {
    console.error(`Error getting Gmail message: ${error.message || String(error)}`);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
}

// Export the helper functions
module.exports = {
  callGapiService,
  listDomains,
  listGmailMessages,
  getGmailMessage
}; 