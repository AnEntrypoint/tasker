/**
 * Comprehensive Gmail Search - ALL users and ALL emails across all Google Workspace domains
 * 
 * This enhanced version uses pagination to retrieve ALL users and ALL emails,
 * not just limited by maxResults parameters.
 * 
 * The QuickJS runtime automatically handles suspend/resume on each external call.
 *
 * @param {Object} input
 * @param {string} [input.gmailSearchQuery=""] - Gmail search query (empty = all emails)
 * @param {number} [input.pageSize=100] - Page size for API pagination
 * @returns {Promise<Object>} Comprehensive search results with all data
 */
module.exports = async function({ gmailSearchQuery = "", pageSize = 100 }) {
  console.log(`🚀 Starting comprehensive Gmail search (ALL users, ALL emails)`);
  console.log(`📧 Search Query: "${gmailSearchQuery}"`);
  console.log(`📄 Page Size: ${pageSize}`);

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
  
  console.log(`✅ Found ${domains.length} domains: ${domains.map(d => d.domain).join(', ')}`);

  // Step 2: For each domain, list ALL users using pagination
  console.log(`👥 Step 2: Listing ALL users for each domain (with pagination)...`);
  const allDomainUsers = [];
  let totalUserCount = 0;

  for (const domainInfo of domains) {
    const domain = domainInfo.domain;
    console.log(`👥 Listing users for domain: ${domain}`);
    
    const domainUsers = [];
    let pageToken = null;
    let userPageCount = 0;
    
    try {
      // Paginate through ALL users
      do {
        userPageCount++;
        console.log(`   📄 Fetching user page ${userPageCount} for domain ${domain}...`);
        
        const params = {
          customer: "my_customer",
          domain: domain,
          maxResults: pageSize,
          orderBy: "email"
        };
        
        if (pageToken) {
          params.pageToken = pageToken;
        }
        
        const usersResponse = await __callHostTool__("gapi", ["admin", "users", "list"], [params]);
        
        if (usersResponse?.users && Array.isArray(usersResponse.users)) {
          const users = usersResponse.users.map(user => ({
            email: user.primaryEmail,
            name: user.name?.fullName || user.primaryEmail,
            id: user.id,
            domain: domain,
            suspended: user.suspended || false
          }));
          
          domainUsers.push(...users);
          console.log(`   ✅ Found ${users.length} users in page ${userPageCount}`);
        }
        
        pageToken = usersResponse?.nextPageToken || null;
        
      } while (pageToken);
      
      allDomainUsers.push({
        domain: domain,
        users: domainUsers
      });
      
      totalUserCount += domainUsers.length;
      console.log(`✅ Found total of ${domainUsers.length} users in domain ${domain}`);
      
    } catch (error) {
      console.error(`❌ Failed to list users for domain ${domain}: ${error.message}`);
      allDomainUsers.push({
        domain: domain,
        users: [],
        error: error.message
      });
    }
  }
  
  console.log(`✅ User discovery completed: ${totalUserCount} total users across all domains`);

  // Step 3: Search Gmail for each user - get ALL emails using pagination
  console.log(`📧 Step 3: Searching Gmail for ALL emails for each user (with pagination)...`);
  const searchResults = [];
  let totalEmailCount = 0;
  let processedUserCount = 0;

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
      // Skip suspended users
      if (user.suspended) {
        console.log(`⏭️  Skipping suspended user: ${user.email}`);
        continue;
      }
      
      console.log(`📧 Searching Gmail for user: ${user.email}`);
      processedUserCount++;
      
      const userMessages = [];
      let emailPageToken = null;
      let emailPageCount = 0;
      
      try {
        // Paginate through ALL emails for this user
        do {
          emailPageCount++;
          console.log(`   📄 Fetching email page ${emailPageCount} for ${user.email}...`);
          
          const searchParams = {
            userId: user.email,
            q: gmailSearchQuery,
            maxResults: pageSize
          };
          
          if (emailPageToken) {
            searchParams.pageToken = emailPageToken;
          }
          
          const gmailResponse = await __callHostTool__("gapi", ["gmail", "users", "messages", "list"], [searchParams]);
          
          if (gmailResponse?.messages && Array.isArray(gmailResponse.messages)) {
            userMessages.push(...gmailResponse.messages);
            console.log(`   ✅ Found ${gmailResponse.messages.length} emails in page ${emailPageCount}`);
          }
          
          emailPageToken = gmailResponse?.nextPageToken || null;
          
        } while (emailPageToken);
        
        const userEmailCount = userMessages.length;
        totalEmailCount += userEmailCount;
        domainResult.totalMessages += userEmailCount;
        
        // Get details for a sample of messages (first 5)
        const sampleMessages = [];
        const samplesToGet = Math.min(userEmailCount, 5);
        
        for (let i = 0; i < samplesToGet; i++) {
          try {
            const messageId = userMessages[i].id;
            const messageDetail = await __callHostTool__("gapi", ["gmail", "users", "messages", "get"], [{
              userId: user.email,
              id: messageId,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date']
            }]);
            
            if (messageDetail) {
              sampleMessages.push({
                id: messageDetail.id,
                snippet: messageDetail.snippet || 'No snippet available',
                subject: getHeaderValue(messageDetail.payload?.headers, 'Subject') || 'No subject',
                from: getHeaderValue(messageDetail.payload?.headers, 'From') || 'Unknown sender',
                date: getHeaderValue(messageDetail.payload?.headers, 'Date') || 'Unknown date'
              });
            }
          } catch (messageError) {
            console.warn(`⚠️ Failed to get message detail: ${messageError.message}`);
          }
        }
        
        domainResult.users.push({
          email: user.email,
          name: user.name,
          messageCount: userEmailCount,
          messages: sampleMessages
        });
        
        console.log(`✅ Found ${userEmailCount} total emails for ${user.email}`);
        
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
    totalUsers: totalUserCount,
    processedUsers: processedUserCount,
    totalMessagesFound: totalEmailCount,
    searchQuery: gmailSearchQuery || "(all emails)"
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

  // Calculate statistics
  const statistics = {
    averageEmailsPerUser: processedUserCount > 0 ? Math.round(totalEmailCount / processedUserCount) : 0,
    domainsWithUsers: searchResults.filter(d => d.userCount > 0).length,
    usersWithEmails: searchResults.reduce((sum, d) => sum + d.users.filter(u => u.messageCount > 0).length, 0)
  };

  const finalResult = {
    summary,
    statistics,
    domainResults: searchResults,
    sampleMessages: sampleMessages.slice(0, 20), // Limit to first 20 sample messages
    executionInfo: {
      completedAt: new Date().toISOString(),
      totalApiCalls: calculateApiCalls(domains.length, totalUserCount, processedUserCount, totalEmailCount),
      description: "Comprehensive search with full pagination - ALL users and ALL emails retrieved"
    }
  };

  console.log(`🎉 Comprehensive Gmail search completed successfully!`);
  console.log(`📊 Final Summary:`);
  console.log(`   🏢 Domains: ${summary.totalDomains}`);
  console.log(`   👥 Total Users: ${summary.totalUsers}`);
  console.log(`   👤 Processed Users: ${summary.processedUsers}`);
  console.log(`   📧 Total Emails: ${summary.totalMessagesFound}`);
  console.log(`   📊 Average Emails/User: ${statistics.averageEmailsPerUser}`);
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
function calculateApiCalls(domains, totalUsers, processedUsers, totalEmails) {
  // 1 call to list domains
  // Multiple calls per domain to list users (with pagination)
  // Multiple calls per user to list emails (with pagination)
  // Up to 5 calls per user to get message details
  // Rough estimate based on pagination
  const userListCalls = domains * Math.ceil(totalUsers / 100); // Assuming 100 users per page
  const emailListCalls = processedUsers * Math.ceil(totalEmails / processedUsers / 100); // Average emails per user / 100
  const messageDetailCalls = processedUsers * 5; // Up to 5 sample messages per user
  
  return 1 + userListCalls + emailListCalls + messageDetailCalls;
}