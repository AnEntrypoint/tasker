/**
 * @task nested-task-caller
 * @description Calls the blog-generator task with the provided topic.
 * @param {object} input - The input object.
 * @param {string} input.topic - The topic to generate the blog post about.
 * @returns {Promise<object>} - The result from the blog-generator task.
 * @throws {Error} If the nested task execution fails.
 */
module.exports = async function execute(input, { tools }) {
  if (!input || typeof input.topic !== 'string') {
    throw new Error("Input must be an object with a 'topic' property of type string.");
  }
  if (!tools || !tools.tasks || typeof tools.tasks.execute !== 'function') {
      throw new Error("The 'tools.tasks' object with an 'execute' method is not available in the environment.");
  }

  const { topic } = input;
  console.log(`Calling blog-generator task with topic: ${topic}`);

  try {
    const result = await tools.tasks.execute('blog-generator', { topic });
    console.log('Received result from blog-generator task.');
    return result;
  } catch (error) {
    console.error(`Error calling blog-generator task: ${error.message}`);
    throw new Error(`Failed to execute nested task 'blog-generator': ${error.message}`);
  }
} 