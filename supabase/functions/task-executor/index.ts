// Update the task_runs record with the result from the stack processor
async function updateTaskRunWithResult(taskRunId: string, result: any, status: string = 'completed'): Promise<void> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    const { error } = await supabase
      .from('task_runs')
      .update({
        status,
        result,
        updated_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      })
      .eq('id', taskRunId);
    
    if (error) {
      console.error(`Error updating task run ${taskRunId}: ${error.message}`);
    }
  } catch (error) {
    console.error(`Exception updating task run ${taskRunId}: ${error}`);
  }
} 