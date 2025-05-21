# GAPI Integration with Tasker

## Overview

This document explains how to properly integrate with Google API (GAPI) services in the Tasker system, which uses QuickJS for secure, sandboxed task execution.

## Key Concepts

1. **Module Calls and VM Suspension**: All service calls (including GAPI) should cause the QuickJS VM to suspend execution, save state, and resume after the call completes. These are not traditional JavaScript promises but rather VM suspension points.

2. **Method Path Arrays**: To reliably call GAPI services, use arrays of path segments rather than property chains. For example, use `["admin", "domains", "list"]` instead of `gapi.admin.domains.list`.

3. **Standard Helpers**: Use the shared helper modules in `taskcode/shared/gapi-helper.js` for consistent and reliable GAPI integration.

## Common Issues and Solutions

### Issue 1: Nested Property Access

**Problem**: The QuickJS environment doesn't properly build method chains when using nested property access like `gapi.admin.domains.list`.

**Solution**: Use the direct `__callHostTool__` approach or the `gapi-helper` module:

```javascript
// Direct approach
const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer: "my_customer" }]);

// Helper module approach
const gapiHelper = await context.tasks.require("../shared/gapi-helper");
const result = await gapiHelper.callGapiService(context, ["admin", "domains", "list"], [{ customer: "my_customer" }]);
```

### Issue 2: Promise Handling

**Problem**: QuickJS requires explicit job processing for promises, which can cause async operations to hang if not handled properly.

**Solution**: Using the VM suspension mechanism instead of direct promises ensures proper handling:

```javascript
// This will create a VM suspension point
const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer: "my_customer" }]);
```

## Best Practices

1. **Always Use Array Path Format**: When calling GAPI methods, always use array path format for method names:

```javascript
// GOOD:
const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [args]);

// AVOID:
const result = await context.tools.gapi.admin.domains.list(args);
```

2. **Use the Standard Helper Module**:

```javascript
// Load the helper
const gapiHelper = await context.tasks.require("../shared/gapi-helper");

// List domains
const domains = await gapiHelper.listDomains(context, { customer: "my_customer" });

// List Gmail messages
const messages = await gapiHelper.listGmailMessages(context, { 
  userId: "me", 
  q: "subject:important" 
});
```

3. **Add Robust Error Handling**:

```javascript
try {
  const domains = await gapiHelper.listDomains(context, { customer: "my_customer" });
  if (!domains.success) {
    console.error(`Error listing domains: ${domains.error}`);
    return { success: false, error: domains.error };
  }
  
  // Process successful result
  return { success: true, domains: domains.domains };
} catch (error) {
  console.error(`Unexpected error: ${error.message}`);
  return { success: false, error: error.message };
}
```

## Task Template

Here's a template for building tasks that integrate with GAPI:

```javascript
/**
 * @task my-gapi-task
 * @description Example task using GAPI integration
 * @param {object} input - Input parameters
 * @returns {object} Result object
 */
module.exports = async function execute(input, context) {
  console.log("Starting my-gapi-task");
  
  try {
    // Load the helper
    let gapiHelper;
    try {
      gapiHelper = await context.tasks.require("../shared/gapi-helper");
    } catch (error) {
      // Use the direct approach if the helper isn't available
      return await directApproach(input, context);
    }
    
    // Call GAPI methods using the helper
    const result = await gapiHelper.callGapiService(
      context,
      ["admin", "domains", "list"],
      [{ customer: input.customer || "my_customer" }]
    );
    
    // Process and return the result
    return {
      success: true,
      data: result
    };
  } catch (error) {
    console.error("Error:", error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

// Fallback approach without helper
async function directApproach(input, context) {
  try {
    const result = await __callHostTool__(
      "gapi", 
      ["admin", "domains", "list"], 
      [{ customer: input.customer || "my_customer" }]
    );
    
    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
```

## Important Notes

1. **VM State**: The QuickJS VM state is preserved between suspensions, allowing for sequential API calls.
2. **Task Context**: The context object provides access to the tools and tasks objects.
3. **Logging**: Use console.log/error in tasks for debugging; these are captured in task logs.
4. **Testing**: Use the provided CLI tools for testing GAPI integration directly.
5. **Service Role**: GAPI calls use the service role key for authentication. 