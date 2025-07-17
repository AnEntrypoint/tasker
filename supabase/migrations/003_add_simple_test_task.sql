-- Insert a simple test task to debug the suspend/resume mechanism
INSERT INTO task_functions (name, code, description) VALUES (
    'simple-test-task',
    'module.exports = async function(input) {
  console.log("Starting simple test task");
  console.log("About to call __callHostTool__");
  
  try {
    const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer: "my_customer" }]);
    console.log("Got result from __callHostTool__:", JSON.stringify(result));
    return { success: true, result: result };
  } catch (error) {
    console.error("Error in __callHostTool__:", error.message);
    return { success: false, error: error.message };
  }
};',
    'Simple test task to debug suspend/resume mechanism'
) ON CONFLICT (name) DO UPDATE SET
    code = EXCLUDED.code,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;