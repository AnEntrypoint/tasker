/**
 * QuickJS module for executing other tasks.
 * Relies on globally injected __hostFetch__(url, options)
 * and __runtimeConfig__.tasks object.
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

async function execute(taskName, input) {
    if (!taskName || typeof taskName !== 'string') {
        throw new Error("taskName (string) is required to execute a task.");
    }

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