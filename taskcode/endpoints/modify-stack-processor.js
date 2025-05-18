/**
 * @task modify-stack-processor
 * @description Modifies the stack processor to insert records into the task_runs table
 * @param {object} input - The input object
 * @param {number} input.limit - The number of recent stack runs to process (default: 10)
 * @returns {Promise<object>} - The result of the modification
 */
module.exports = async function execute(input, { tools }) {
  console.log('[modify-stack-processor] Starting with input:', JSON.stringify(input));
  
  const limit = input?.limit || 10;
  
  // Check if Supabase tools are available
  if (!tools || !tools.supabase) {
    throw new Error("The 'tools.supabase' object is not available in the environment.");
  }
  
  try {
    // Get recent stack runs
    console.log(`[modify-stack-processor] Getting recent stack runs (limit: ${limit})...`);
    
    const { data: stackRuns, error: stackRunsError } = await tools.supabase
      .from('stack_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (stackRunsError) {
      console.error(`[modify-stack-processor] Error getting stack runs: ${stackRunsError.message}`);
      throw new Error(`Failed to get stack runs: ${stackRunsError.message}`);
    }
    
    console.log(`[modify-stack-processor] Found ${stackRuns.length} stack runs`);
    
    // Process each stack run
    const processedRuns = [];
    
    for (const stackRun of stackRuns) {
      // Check if this is a tasks.execute call
      if (stackRun.module_name === 'tasks' && stackRun.method_name === 'execute' && stackRun.status === 'completed') {
        const taskName = stackRun.args[0];
        const taskInput = stackRun.args[1];
        
        console.log(`[modify-stack-processor] Processing stack run for task: ${taskName}`);
        
        // Insert a record into the task_runs table
        const { data: insertData, error: insertError } = await tools.supabase
          .from('task_runs')
          .insert({
            name: taskName,
            args: taskInput,
            status: 'completed',
            result: stackRun.result,
            created_at: stackRun.created_at,
            updated_at: stackRun.updated_at
          })
          .select();
        
        if (insertError) {
          console.error(`[modify-stack-processor] Error inserting record for task ${taskName}: ${insertError.message}`);
        } else {
          console.log(`[modify-stack-processor] Record inserted for task ${taskName}:`, insertData);
          processedRuns.push({
            stackRunId: stackRun.id,
            taskName,
            insertedRecord: insertData
          });
        }
      }
    }
    
    // Get records from task_runs table
    console.log('[modify-stack-processor] Getting records from task_runs table...');
    
    const { data: taskRuns, error: taskRunsError } = await tools.supabase
      .from('task_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (taskRunsError) {
      console.error(`[modify-stack-processor] Error getting task runs: ${taskRunsError.message}`);
    } else {
      console.log(`[modify-stack-processor] Found ${taskRuns.length} task runs`);
    }
    
    return {
      success: true,
      processedRuns,
      taskRuns
    };
  } catch (error) {
    console.error(`[modify-stack-processor] Error: ${error.message}`);
    throw error;
  }
}
