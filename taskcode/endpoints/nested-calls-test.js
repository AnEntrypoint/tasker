/**
 * A test task that demonstrates nested calls with the ephemeral call queueing system
 * @param {Object} input - The input parameters
 * @param {number} input.depth - How many levels of nested calls to make
 * @param {number} input.branches - How many branches to create at each level
 * @returns {Object} Results from the nested call tree
 */
export default async function nestedCallsTest(input) {
  console.log(`Starting nested calls test with depth=${input.depth}, branches=${input.branches}`);
  
  // Base case - no more nesting
  if (input.depth <= 0) {
    return {
      level: 0,
      message: "Reached bottom of call tree",
      timestamp: new Date().toISOString()
    };
  }
  
  // Make nested calls if we have depth remaining
  const results = [];
  
  for (let i = 0; i < input.branches; i++) {
    console.log(`Making branch ${i+1}/${input.branches} at depth ${input.depth}`);
    
    // This is the key part - making a nested call to tasks.execute
    // This will be intercepted and processed via the ephemeral call system
    const result = await tools.tasks.execute("nested-calls-test", {
      depth: input.depth - 1,
      branches: input.branches
    });
    
    results.push({
      branchId: i + 1,
      result
    });
  }
  
  // Include information about this level
  return {
    level: input.depth,
    branches: results,
    timestamp: new Date().toISOString()
  };
} 