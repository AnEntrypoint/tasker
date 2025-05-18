/**
 * @task stack-test
 * @description Tests the stack_runs table by calling a nested task
 * @param {object} input - The input object
 * @param {string} input.message - The message to echo
 * @returns {Promise<object>} - The result of the nested task
 */
module.exports = async function execute(input, { tools }) {
  console.log('[stack-test] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.message !== 'string') {
    throw new Error("Input must be an object with a 'message' property of type string.");
  }
  
  // Create a direct entry in the stack_runs table
  if (tools && tools.supabase) {
    try {
      console.log('[stack-test] Creating a direct entry in the stack_runs table');
      
      // Generate a unique ID for the stack run
      const stackRunId = crypto.randomUUID();
      
      // Create a stack run record
      const { error } = await tools.supabase.from('stack_runs').insert({
        id: stackRunId,
        module_name: 'tasks',
        method_name: 'execute',
        args: ['echo', { message: input.message }],
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      
      if (error) {
        console.error(`[stack-test] Failed to create stack run: ${error.message}`);
        throw new Error(`Failed to create stack run: ${error.message}`);
      }
      
      console.log(`[stack-test] Created stack run with ID: ${stackRunId}`);
      
      // Wait for the task to complete
      let status = 'pending';
      let result = null;
      let attempts = 0;
      
      while (status === 'pending' && attempts < 30) {
        // Wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check the status of the stack run
        const { data, error: checkError } = await tools.supabase
          .from('stack_runs')
          .select('*')
          .eq('id', stackRunId)
          .single();
        
        if (checkError) {
          console.error(`[stack-test] Failed to check stack run status: ${checkError.message}`);
          throw new Error(`Failed to check stack run status: ${checkError.message}`);
        }
        
        status = data.status;
        result = data.result;
        attempts++;
        
        console.log(`[stack-test] Stack run status: ${status} (attempt ${attempts})`);
      }
      
      if (status === 'completed') {
        console.log(`[stack-test] Stack run completed with result:`, result);
        return result;
      } else {
        throw new Error(`Stack run did not complete within the expected time (status: ${status})`);
      }
    } catch (error) {
      console.error(`[stack-test] Error working with stack_runs table: ${error.message}`);
      throw error;
    }
  } else {
    console.log('[stack-test] Supabase tools not available, falling back to direct execution');
    
    // Fall back to direct execution
    if (tools && tools.tasks) {
      const result = await tools.tasks.execute('echo', { message: input.message });
      console.log('[stack-test] Direct execution result:', result);
      return result;
    } else {
      throw new Error("The 'tools.tasks' object is not available in the environment.");
    }
  }
}
