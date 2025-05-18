/**
 * @task task-caller
 * @description Calls the echo task with the provided input using ephemeral call queueing
 * @param {object} input - The input object to pass to the echo task
 * @returns {Promise<object>} - The result from the echo task
 * @throws {Error} If the nested task execution fails
 */
module.exports = async function execute(input, { tools }) {
  console.log('[task-caller] Starting with input:', JSON.stringify(input));
  
  if (!tools || !tools.tasks || typeof tools.tasks.execute !== 'function') {
    throw new Error("The 'tools.tasks' object with an 'execute' method is not available in the environment.");
  }
  
  try {
    // Check if __saveEphemeralCall__ is available
    if (typeof globalThis.__saveEphemeralCall__ === 'function') {
      console.log('[task-caller] __saveEphemeralCall__ function is available, using it directly');

      // Use __saveEphemeralCall__ directly
      console.log('[task-caller] Calling __saveEphemeralCall__ with args:', JSON.stringify(['echo', input]));
      const result = await globalThis.__saveEphemeralCall__('tasks', 'execute', ['echo', input]);
      console.log('[task-caller] Received result from echo task via ephemeral call queueing.');
      return result;
    } else {
      console.log('[task-caller] __saveEphemeralCall__ function is not available, falling back to tools.tasks.execute');
      
      // Fall back to tools.tasks.execute
      const result = await tools.tasks.execute('echo', input);
      console.log('[task-caller] Received result from echo task via direct execution.');
      return result;
    }
  } catch (error) {
    console.error(`[task-caller] Error calling echo task: ${error.message}`);
    throw new Error(`Failed to execute nested task 'echo': ${error.message}`);
  }
}
