/**
 * A comprehensive test task that gets users from ALL domains with suspend/resume support
 * 
 * @param {Object} input - The input parameters
 * @returns {Object} The result of the GAPI calls including users from all domains
 */
module.exports = async function testGapiDomainsService(input = {}) {
  console.log("======= STARTING TASK: test-gapi-domains-service =======");
  
  let domainsResult;
  let allUsersResults = [];
  let currentDomainIndex = 0;
  let isResuming = false;
  
  // Check if we're resuming from a previous step
  if (globalThis.__resumeResult__ && globalThis.__checkpoint__) {
    console.log("RESUMING: Found resume data", JSON.stringify(globalThis.__checkpoint__, null, 2));
    isResuming = true;
    
    const pendingCall = globalThis.__checkpoint__.pendingServiceCall;
    const completedCall = globalThis.__checkpoint__.completedServiceCall;
    
    if (completedCall?.result && pendingCall?.method) {
      if (pendingCall.method === "admin.domains.list") {
        console.log("RESUMING: Using cached domains.list result");
        domainsResult = completedCall.result;
      } else if (pendingCall.method === "admin.users.list") {
        console.log("RESUMING: Processing users.list result for domain index", globalThis.__currentDomainIndex__);
        
        // Restore previous state
        domainsResult = globalThis.__domainsCache__;
        allUsersResults = globalThis.__usersCache__ || [];
        currentDomainIndex = globalThis.__currentDomainIndex__ || 0;
        
        console.log(`RESUMING: Restored state - currentDomainIndex: ${currentDomainIndex}, previous results: ${allUsersResults.length}`);
        
        // Add the completed users result
        const domainName = domainsResult.domains[currentDomainIndex]?.domainName;
        const newUserResult = {
          domain: domainName,
          users: completedCall.result.users || [],
          userCount: completedCall.result.users?.length || 0
        };
        
        allUsersResults.push(newUserResult);
        console.log(`RESUMING: Added users for domain ${domainName}: ${newUserResult.userCount} users`);
        
        // Move to next domain
        currentDomainIndex++;
        console.log(`RESUMING: Moving to next domain index: ${currentDomainIndex}`);
      }
    }
    // Fallback: check if the resume result itself is domains data
    else if (globalThis.__resumeResult__.domains) {
      console.log("RESUMING: Using direct resume result as domains data");
      domainsResult = globalThis.__resumeResult__;
    }
  }
  
  // Step 1: Get domains (only if we don't have cached result)
  if (!domainsResult) {
    console.log("STEP 1: Calling domains.list...");
    domainsResult = await tools.gapi.admin.domains.list({ customer: "my_customer" });
    console.log(`STEP 1: Domains call completed - found ${domainsResult.domains?.length || 0} domains`);
    
    // Cache domains for resume scenarios
    globalThis.__domainsCache__ = domainsResult;
  }
  
  // Step 2: Get users for ALL domains
  const domains = domainsResult.domains || [];
  console.log(`STEP 2: Processing users for ${domains.length} domains starting from index ${currentDomainIndex}`);
  console.log(`STEP 2: Already processed ${allUsersResults.length} domains`);
  
  // Check if we're done
  if (currentDomainIndex >= domains.length) {
    console.log("All domains processed! Calculating final results...");
  } else {
    console.log(`STEP 2: Will process domains ${currentDomainIndex} to ${domains.length - 1}`);
    
    for (let i = currentDomainIndex; i < domains.length; i++) {
      const domain = domains[i];
      console.log(`STEP 2.${i + 1}: Calling users.list for domain: ${domain.domainName} (index ${i})`);
      
      // Cache current state for potential resume
      globalThis.__usersCache__ = allUsersResults;
      globalThis.__currentDomainIndex__ = i;
      globalThis.__domainsCache__ = domainsResult;
      
      console.log(`STEP 2.${i + 1}: Cached state for domain index ${i}`);
      
      const usersResult = await tools.gapi.admin.users.list({
        domain: domain.domainName,
        maxResults: 10  // Reduced for faster testing
      });
      
      console.log(`STEP 2.${i + 1}: Users call completed for ${domain.domainName}`);
      
      allUsersResults.push({
        domain: domain.domainName,
        users: usersResult.users || [],
        userCount: usersResult.users?.length || 0
      });
      
      console.log(`STEP 2.${i + 1}: Found ${usersResult.users?.length || 0} users in domain ${domain.domainName}`);
      console.log(`STEP 2.${i + 1}: Total processed domains so far: ${allUsersResults.length}`);
    }
  }
  
  // Calculate totals
  const totalUsers = allUsersResults.reduce((sum, domainResult) => sum + domainResult.userCount, 0);
  const domainsWithUsers = allUsersResults.filter(domainResult => domainResult.userCount > 0).length;
  
  // Return comprehensive result
  const result = {
    totalDomains: domains.length,
    domainsProcessed: allUsersResults.length,
    domainsWithUsers: domainsWithUsers,
    totalUsers: totalUsers,
    domainDetails: allUsersResults.map(dr => ({
      domain: dr.domain,
      userCount: dr.userCount
    })),
    success: true,
    wasResuming: isResuming,
    finalDomainIndex: currentDomainIndex
  };
  
  console.log("======= TASK COMPLETED =======");
  console.log(`Summary: ${domains.length} total domains, processed ${allUsersResults.length} domains, ${totalUsers} total users across ${domainsWithUsers} domains with users`);
  
  // Clear cache
  delete globalThis.__usersCache__;
  delete globalThis.__currentDomainIndex__;
  delete globalThis.__domainsCache__;
  
  return result;
}; 