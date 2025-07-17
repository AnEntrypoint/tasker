/**
 * QuickJS module for executing other tasks.
 * Supports both direct execution and ephemeral call queueing.
 * Relies on globally injected __hostFetch__(url, options),
 * __runtimeConfig__.tasks object, and __saveEphemeralCall__ function.
 */

if (typeof __hostFetch__ !== 'function') {
    throw new Error("Host function '__hostFetch__' is not available in QuickJS environment.");
}
if (typeof __runtimeConfig__ === 'undefined' || typeof __runtimeConfig__.tasks === 'undefined') {
     throw new Error("Global '__runtimeConfig__.tasks' is not available in QuickJS environment.");
}

console.log('[QuickJS Tasks] Initializing tasks module...');

const { baseUrl, headers } = __runtimeConfig__.tasks;
const tasksUrl = baseUrl; // Assuming POST to the main tasks endpoint URL provided

/**
 * Execute a task using ephemeral call queueing or direct execution
 * @param {string} taskName - The name of the task to execute
 * @param {object} input - The input parameters for the task
 * @returns {Promise<any>} - The result of the task execution
 */
async function execute(taskName, input) {
    if (!taskName || typeof taskName !== 'string') {
        throw new Error("taskName (string) is required to execute a task.");
    }

    // Check if ephemeral call queueing is available
    if (typeof __saveEphemeralCall__ === 'function') {
        console.log(`[QuickJS Tasks] Executing task '${taskName}' via ephemeral call queueing`);

        try {
            // Save the ephemeral call and get the result
            // This will suspend the VM execution and resume when the call completes
            const result = await __saveEphemeralCall__('tasks', 'execute', [taskName, input || {}]);
            console.log(`[QuickJS Tasks] Received ephemeral call result for task '${taskName}'`);
            return result;
        } catch (error) {
            console.error(`[QuickJS Tasks] Error during ephemeral execution of task ${taskName}:`, error);
            throw new Error(`Failed to execute task ${taskName}: ${error.message || error}`);
        }
    } else {
        // Fall back to direct execution if ephemeral call queueing is not available
        console.log(`[QuickJS Tasks] Ephemeral call queueing not available, falling back to direct execution for task '${taskName}'`);
        return directExecute(taskName, input);
    }
}

/**
 * Execute a task directly using host fetch
 * @param {string} taskName - The name of the task to execute
 * @param {object} input - The input parameters for the task
 * @returns {Promise<any>} - The result of the task execution
 */
async function directExecute(taskName, input) {
    const payload = {
        taskName: taskName,
        input: input || {} // Ensure input is at least an empty object
    };
    const body = JSON.stringify(payload);

    console.log(`[QuickJS Tasks] Executing task '${taskName}' via host fetch: POST ${tasksUrl}`);

    try {
        const response = await __hostFetch__(tasksUrl, {
            method: 'POST',
            headers: {
                ...(headers || {}), // Include base headers from config
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: body
        });

        // Assuming __hostFetch__ returns the parsed JSON response or throws on network/HTTP error
        console.log(`[QuickJS Tasks] Received response for task '${taskName}'. Success: ${response?.success}`);

        if (!response || typeof response.success !== 'boolean') {
             throw new Error(`Invalid response structure received from tasks endpoint for ${taskName}`);
        }

        if (!response.success) {
             const error = new Error(response.error?.message || `Task execution failed for ${taskName}`);
             if (response.error?.code) error.code = response.error.code;
             // Avoid adding huge external stacks if not useful
             // if (response.error?.stack) error.stack = response.error.stack;
             console.error(`[QuickJS Tasks] Task '${taskName}' failed:`, error);
             throw error;
        }
        return response.result; // Return the result part of the task response
    } catch (error) {
       // Catch errors from __hostFetch__ or response processing
       console.error(`[QuickJS Tasks] Error during execution of task ${taskName}:`, error);
       throw new Error(`Failed to execute task ${taskName}: ${error.message || error}`);
    }
}

console.log('[QuickJS Tasks] Tasks module initialized.');

module.exports = {
    execute
};