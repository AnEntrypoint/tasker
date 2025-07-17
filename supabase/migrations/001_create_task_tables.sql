-- Create task_functions table
CREATE TABLE IF NOT EXISTS task_functions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    code TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create task_runs table
CREATE TABLE IF NOT EXISTS task_runs (
    id SERIAL PRIMARY KEY,
    task_function_id INTEGER REFERENCES task_functions(id),
    task_name VARCHAR(255) NOT NULL,
    input JSONB,
    result JSONB,
    status VARCHAR(50) DEFAULT 'queued',
    error JSONB,
    logs TEXT[],
    vm_logs TEXT[],
    waiting_on_stack_run_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP
);

-- Create stack_runs table
CREATE TABLE IF NOT EXISTS stack_runs (
    id SERIAL PRIMARY KEY,
    parent_task_run_id INTEGER REFERENCES task_runs(id),
    parent_stack_run_id INTEGER REFERENCES stack_runs(id),
    service_name VARCHAR(100) NOT NULL,
    method_name VARCHAR(100) NOT NULL,
    args JSONB,
    result JSONB,
    status VARCHAR(50) DEFAULT 'pending',
    error JSONB,
    vm_state JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP
);

-- Insert the comprehensive Gmail search task
INSERT INTO task_functions (name, code, description) VALUES (
    'comprehensive-gmail-search',
    '/**
 * Comprehensive Gmail Search across all Google Workspace domains and users
 * 
 * This task demonstrates automatic suspend/resume by making multiple external module calls.
 * The QuickJS runtime will automatically suspend execution on each external call,
 * save VM state, process the call, and resume execution with results.
 * 
 * This task contains NO suspend/resume logic - all handled by the runtime.
 *
 * @param {Object} input
 * @param {string} [input.gmailSearchQuery=""] - Gmail search query (empty = all emails)
 * @param {number} [input.maxResultsPerUser=3] - Maximum email results per user
 * @param {number} [input.maxUsersPerDomain=5] - Maximum users to process per domain
 * @returns {Promise<Object>} Comprehensive search results with domain breakdown
 */
module.exports = async function({ gmailSearchQuery = "", maxResultsPerUser = 10, maxUsersPerDomain = 1000 }) {
  console.log(`🚀 Starting comprehensive Gmail search`);
  console.log(`📧 Search Query: "${gmailSearchQuery}"`);
  console.log(`👥 Max Users Per Domain: ${maxUsersPerDomain}`);
  console.log(`📋 Max Results Per User: ${maxResultsPerUser}`);

  // Step 1: Discover all Google Workspace domains
  console.log(`🏢 Step 1: Discovering Google Workspace domains...`);
  
  const domainsResponse = await __callHostTool__("gapi", ["admin", "domains", "list"], [{
    customer: "my_customer"
  }]);
  
  if (!domainsResponse?.domains || !Array.isArray(domainsResponse.domains)) {
    throw new Error("Failed to retrieve domains or invalid response format");
  }
  
  const domains = domainsResponse.domains.map(domain => ({
    domain: domain.domainName,
    verified: domain.verified,
    primary: domain.isPrimary
  }));
  
  console.log(`✅ Found ${domains.length} domains: ${domains.map(d => d.domain).join('', '')}`);

  // Step 2: For each domain, list users
  console.log(`👥 Step 2: Listing users for each domain...`);
  const allDomainUsers = [];

  for (const domainInfo of domains) {
    const domain = domainInfo.domain;
    console.log(`👥 Listing users for domain: ${domain}`);
    
    try {
      const usersResponse = await __callHostTool__("gapi", ["admin", "users", "list"], [{
        customer: "my_customer",
        domain: domain,
        maxResults: maxUsersPerDomain,
        orderBy: "email"
      }]);
      
      if (usersResponse?.users && Array.isArray(usersResponse.users)) {
        const users = usersResponse.users.map(user => ({
          email: user.primaryEmail,
          name: user.name?.fullName || user.primaryEmail,
          id: user.id,
          domain: domain
        }));
        
        allDomainUsers.push({
          domain: domain,
          users: users
        });
        
        console.log(`✅ Found ${users.length} users in domain ${domain}`);
      } else {
        console.log(`⚠️ No users found in domain ${domain} or invalid response`);
        allDomainUsers.push({
          domain: domain,
          users: []
        });
      }
    } catch (error) {
      console.error(`❌ Failed to list users for domain ${domain}: ${error.message}`);
      allDomainUsers.push({
        domain: domain,
        users: [],
        error: error.message
      });
    }
  }
  
  console.log(`✅ User discovery completed for all domains`);

  // Step 3: Search Gmail for each user
  console.log(`📧 Step 3: Searching Gmail for each user...`);
  const searchResults = [];
  let totalUsers = 0;
  let totalMessages = 0;

  for (const domainUserGroup of allDomainUsers) {
    const domain = domainUserGroup.domain;
    const users = domainUserGroup.users || [];
    
    console.log(`📧 Searching Gmail for ${users.length} users in domain ${domain}`);
    
    const domainResult = {
      domain: domain,
      users: [],
      totalMessages: 0,
      userCount: users.length
    };

    for (const user of users) {
      console.log(`📧 Searching Gmail for user: ${user.email}`);
      totalUsers++;
      
      try {
        // Search Gmail messages for this user
        const gmailResponse = await __callHostTool__("gapi", ["gmail", "users", "messages", "list"], [{
          userId: user.email,
          q: gmailSearchQuery,
          maxResults: maxResultsPerUser
        }]);
        
        let messageCount = 0;
        let messages = [];
        
        if (gmailResponse?.messages && Array.isArray(gmailResponse.messages)) {
          messageCount = gmailResponse.messages.length;
          totalMessages += messageCount;
          domainResult.totalMessages += messageCount;
          
          // Get message details for a few sample messages
          for (let i = 0; i < Math.min(messageCount, 2); i++) {
            try {
              const messageId = gmailResponse.messages[i].id;
              const messageDetail = await __callHostTool__("gapi", ["gmail", "users", "messages", "get"], [{
                userId: user.email,
                id: messageId,
                format: ''metadata'',
                metadataHeaders: [''Subject'', ''From'', ''Date'']
              }]);
              
              if (messageDetail) {
                messages.push({
                  id: messageDetail.id,
                  snippet: messageDetail.snippet || ''No snippet available'',
                  subject: getHeaderValue(messageDetail.payload?.headers, ''Subject'') || ''No subject'',
                  from: getHeaderValue(messageDetail.payload?.headers, ''From'') || ''Unknown sender'',
                  date: getHeaderValue(messageDetail.payload?.headers, ''Date'') || ''Unknown date''
                });
              }
            } catch (messageError) {
              console.warn(`⚠️ Failed to get message detail for user ${user.email}: ${messageError.message}`);
            }
          }
        }
        
        domainResult.users.push({
          email: user.email,
          name: user.name,
          messageCount: messageCount,
          messages: messages
        });
        
        console.log(`✅ Found ${messageCount} messages for ${user.email}`);
        
      } catch (error) {
        console.error(`❌ Failed to search Gmail for user ${user.email}: ${error.message}`);
        domainResult.users.push({
          email: user.email,
          name: user.name,
          messageCount: 0,
          messages: [],
          error: error.message
        });
      }
    }
    
    searchResults.push(domainResult);
    console.log(`✅ Gmail search completed for domain ${domain}: ${domainResult.totalMessages} total messages`);
  }
  
  console.log(`✅ Gmail search completed for all users`);

  // Step 4: Aggregate and format final results
  console.log(`📊 Step 4: Aggregating results...`);
  
  const summary = {
    totalDomains: domains.length,
    totalUsers: totalUsers,
    totalMessagesFound: totalMessages,
    searchQuery: gmailSearchQuery
  };

  // Collect sample messages from all domains
  const sampleMessages = [];
  for (const domainResult of searchResults) {
    for (const user of domainResult.users) {
      for (const message of user.messages || []) {
        sampleMessages.push({
          userEmail: user.email,
          userName: user.name,
          domain: domainResult.domain,
          subject: message.subject,
          snippet: message.snippet,
          from: message.from,
          date: message.date
        });
      }
    }
  }

  const finalResult = {
    summary,
    domainResults: searchResults,
    sampleMessages: sampleMessages.slice(0, 10), // Limit to first 10 sample messages
    executionInfo: {
      completedAt: new Date().toISOString(),
      totalApiCalls: calculateApiCalls(domains.length, totalUsers, totalMessages),
      description: "Task completed using automatic suspend/resume on each external module call"
    }
  };

  console.log(`🎉 Comprehensive Gmail search completed successfully!`);
  console.log(`📊 Final Summary:`);
  console.log(`   🏢 Domains: ${summary.totalDomains}`);
  console.log(`   👥 Users: ${summary.totalUsers}`);
  console.log(`   📧 Messages: ${summary.totalMessagesFound}`);
  console.log(`   🔍 Query: "${summary.searchQuery}"`);
  console.log(`   📡 Total API calls: ${finalResult.executionInfo.totalApiCalls}`);

  return finalResult;
};

/**
 * Helper function to get header value from Gmail message headers
 */
function getHeaderValue(headers, name) {
  if (!headers || !Array.isArray(headers)) {
    return null;
  }
  
  const header = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : null;
}

/**
 * Calculate total API calls made during execution
 */
function calculateApiCalls(domains, users, messages) {
  // 1 call to list domains
  // 1 call per domain to list users
  // 1 call per user to search messages
  // Up to 2 calls per user to get message details
  return 1 + domains + users + Math.min(messages, users * 2);
}',
    'Comprehensive Gmail search across all Google Workspace domains and users with automatic suspend/resume'
) ON CONFLICT (name) DO UPDATE SET
    code = EXCLUDED.code,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;