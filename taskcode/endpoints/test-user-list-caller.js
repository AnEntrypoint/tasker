/**
 * @task test-user-list-caller
 * @description Calls the simple-user-list-test task.
 * @param {object} input - The input object (currently unused).
 * @returns {Promise<object>} - The result from the simple-user-list-test task.
 * @throws {Error} If the nested task execution fails.
 */
module.exports = async function execute(input = {}, { tools }) {
  console.log('[test-user-list-caller] Starting task...');

  if (!tools || !tools.tasks || typeof tools.tasks.execute !== 'function') {
      console.error('[test-user-list-caller] The \'tools.tasks\' object with an \'execute\' method is not available.');
      throw new Error("The 'tools.tasks' object with an 'execute' method is not available in the environment.");
  }

  console.log('Calling simple-user-list-test task...');

  try {
    // Input for simple-user-list-test is currently optional, pass empty object
    const result = await tools.tasks.execute('simple-user-list-test', {});
    console.log('[test-user-list-caller] Received result from simple-user-list-test task:');
    console.log(JSON.stringify(result, null, 2)); // Log the result for verification
    return result;
  } catch (error) {
    console.error(`[test-user-list-caller] Error calling simple-user-list-test task: ${error.message}`);
    // Log the stack trace if available
    if (error.stack) {
        console.error(error.stack);
    }
    throw new Error(`Failed to execute nested task 'simple-user-list-test': ${error.message}`);
  }
} 