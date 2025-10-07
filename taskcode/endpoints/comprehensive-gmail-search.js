/**
 * Comprehensive Gmail Search across all Google Workspace domains and users
 *
 * This task demonstrates automatic suspend/resume by making multiple external module calls.
 * The deno-executor runtime will automatically suspend execution on each external call,
 * create child stack runs, process the call, and resume execution with results.
 *
 * This task contains NO suspend/resume logic - all handled by the runtime.
 *
 * @param {Object} input
 * @param {string} [input.gmailSearchQuery=""] - Gmail search query (empty = all emails)
 * @param {number} [input.maxResultsPerUser=3] - Maximum email results per user
 * @param {number} [input.maxUsersPerDomain=5] - Maximum users to process per domain
 * @returns {Object} Comprehensive search results with domain breakdown
 */
module.exports = async function({ gmailSearchQuery = "", maxResultsPerUser = 10, maxUsersPerDomain = 500 }) {
  // CRITICAL FIX: Enforce Google API limits to prevent errors
  // Google Admin API limits: maxResults must be between 1 and 500
  maxUsersPerDomain = Math.min(Math.max(maxUsersPerDomain, 1), 500);
  maxResultsPerUser = Math.min(Math.max(maxResultsPerUser, 1), 100); // Gmail API limit
  
  console.log('🚀 Starting comprehensive Gmail search');
  console.log('📧 Search Query: "' + gmailSearchQuery + '"');
  console.log('👥 Max Users Per Domain: ' + maxUsersPerDomain);
  console.log('📋 Max Results Per User: ' + maxResultsPerUser);

  // Step 1: Discover all Google Workspace domains (with suspend/resume)
  console.log('🏢 Step 1: Discovering Google Workspace domains...');
  
  const domainsResponse = await __callHostTool__("gapi", ["admin", "domains", "list"], [{
    customer: "my_customer"
  }]);
  
  if (!domainsResponse || !domainsResponse.domains || !Array.isArray(domainsResponse.domains)) {
    console.error("❌ Failed to retrieve domains or invalid response format");
    console.error("📊 Domains response type:", typeof domainsResponse);
    console.error("📊 Domains response value:", JSON.stringify(domainsResponse));
    return {
      success: false,
      error: "Failed to retrieve domains or invalid response format",
      debug: {
        responseType: typeof domainsResponse,
        responseValue: domainsResponse,
        hasDomainsProperty: domainsResponse ? domainsResponse.hasOwnProperty && domainsResponse.hasOwnProperty('domains') : false
      }
    };
  }
  
  const domains = domainsResponse.domains.map(function(domain) {
    return {
      domain: domain.domainName,
      verified: domain.verified,
      primary: domain.isPrimary
    };
  });
  
  console.log('✅ Found ' + domains.length + ' domains: ' + domains.map(function(d) { return d.domain; }).join(', '));

  // Step 2: For each domain, list users (with suspend/resume)
  console.log('👥 Step 2: Listing users for each domain...');
  
  const allDomainUsers = [];
  
  for (let i = 0; i < domains.length; i++) {
    const domainInfo = domains[i];
    const domain = domainInfo.domain;
    
    console.log('👥 Listing users for domain: ' + domain + ' (' + (i + 1) + '/' + domains.length + ')');
    
    // CRITICAL: Don't catch TASK_SUSPENDED - let suspend/resume work
    const usersResponse = await __callHostTool__("gapi", ["admin", "users", "list"], [{
      customer: "my_customer",
      domain: domain,
      maxResults: maxUsersPerDomain,
      orderBy: "email"
    }]);

    if (usersResponse && usersResponse.users && Array.isArray(usersResponse.users)) {
      const users = usersResponse.users.map(function(user) {
        return {
          email: user.primaryEmail,
          name: user.name ? user.name.fullName : user.primaryEmail,
          id: user.id,
          domain: domain
        };
      });

      allDomainUsers.push({
        domain: domain,
        users: users
      });

      console.log('✅ Found ' + users.length + ' users in domain ' + domain);
    } else {
      console.log('⚠️ No users found in domain ' + domain + ' or invalid response');
      allDomainUsers.push({
        domain: domain,
        users: []
      });
    }
  }
  
  console.log('✅ User discovery completed for all domains');

  // Step 3: Search Gmail for each user (with suspend/resume)
  console.log('📧 Step 3: Searching Gmail for each user...');
  const searchResults = [];
  let totalUsers = 0;
  let totalMessages = 0;

  for (let i = 0; i < allDomainUsers.length; i++) {
    const domainUserGroup = allDomainUsers[i];
    const domain = domainUserGroup.domain;
    const users = domainUserGroup.users || [];
    
    console.log('📧 Searching Gmail for ' + users.length + ' users in domain ' + domain);
    
    const domainResult = {
      domain: domain,
      users: [],
      totalMessages: 0,
      userCount: users.length
    };

    // Process all users (removed testing limitation)
    const usersToProcess = users;
    
    for (let j = 0; j < usersToProcess.length; j++) {
      const user = usersToProcess[j];
      console.log('📧 Searching Gmail for user: ' + user.email);
      totalUsers++;
      
      // CRITICAL: Don't catch TASK_SUSPENDED - let suspend/resume work
      // Search Gmail messages for this user
      const gmailResponse = await __callHostTool__("gapi", ["gmail", "users", "messages", "list"], [{
        userId: user.email,
        q: gmailSearchQuery,
        maxResults: maxResultsPerUser
      }]);

      let messageCount = 0;
      let messages = [];

      if (gmailResponse && gmailResponse.messages && Array.isArray(gmailResponse.messages)) {
        messageCount = gmailResponse.messages.length;
        totalMessages += messageCount;
        domainResult.totalMessages += messageCount;

        // Get details for all messages
        for (let k = 0; k < gmailResponse.messages.length; k++) {
          const messageId = gmailResponse.messages[k].id;
          const messageDetail = await __callHostTool__("gapi", ["gmail", "users", "messages", "get"], [{
            userId: user.email,
            id: messageId,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date']
          }]);

          if (messageDetail) {
            const headers = messageDetail.payload ? messageDetail.payload.headers : [];
            const getHeaderValue = function(headers, name) {
              if (!headers || !Array.isArray(headers)) return null;
              const header = headers.find(function(h) { return h.name && h.name.toLowerCase() === name.toLowerCase(); });
              return header ? header.value : null;
            };

            messages.push({
              id: messageDetail.id,
              snippet: messageDetail.snippet || 'No snippet available',
              subject: getHeaderValue(headers, 'Subject') || 'No subject',
              from: getHeaderValue(headers, 'From') || 'Unknown sender',
              date: getHeaderValue(headers, 'Date') || 'Unknown date'
            });
          }
        }
      }

      domainResult.users.push({
        email: user.email,
        name: user.name,
        messageCount: messageCount,
        messages: messages
      });

      console.log('✅ Found ' + messageCount + ' messages for ' + user.email);
    }
    
    searchResults.push(domainResult);
    console.log('✅ Gmail search completed for domain ' + domain + ': ' + domainResult.totalMessages + ' total messages');
  }
  
  console.log('✅ Gmail search completed for all users');

  // Step 4: Aggregate and format final results
  console.log('📊 Step 4: Aggregating results...');
  
  const summary = {
    totalDomains: domains.length,
    totalUsers: totalUsers,
    totalMessagesFound: totalMessages,
    searchQuery: gmailSearchQuery
  };

  // Collect sample messages from all domains
  const sampleMessages = [];
  for (let i = 0; i < searchResults.length; i++) {
    const domainResult = searchResults[i];
    for (let j = 0; j < domainResult.users.length; j++) {
      const user = domainResult.users[j];
      const messages = user.messages || [];
      for (let k = 0; k < messages.length; k++) {
        const message = messages[k];
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
    summary: summary,
    domainResults: searchResults,
    sampleMessages: sampleMessages.slice(0, 10), // Limit to first 10 sample messages
    executionInfo: {
      completedAt: new Date().toISOString(),
      totalApiCalls: 1 + domains.length + totalUsers + Math.min(totalMessages, totalUsers),
      description: "Task completed using automatic suspend/resume on each external module call"
    }
  };

  console.log('🎉 Comprehensive Gmail search completed successfully!');
  console.log('📊 Final Summary:');
  console.log('   🏢 Domains: ' + summary.totalDomains);
  console.log('   👥 Users: ' + summary.totalUsers);
  console.log('   📧 Messages: ' + summary.totalMessagesFound);
  console.log('   🔍 Query: "' + summary.searchQuery + '"');
  console.log('   📡 Total API calls: ' + finalResult.executionInfo.totalApiCalls);

  return finalResult;
};