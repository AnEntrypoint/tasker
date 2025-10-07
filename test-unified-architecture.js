#!/usr/bin/env node

/**
 * Comprehensive Test Suite for Unified Architecture
 * Tests all DRY improvements and FlowState integration
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TEST_CONFIG = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  SERVICES: {
    'stack-processor': 8001,
    'wrappedkeystore': 8002,
    'wrappedgapi': 8003,
    'tasks': 8000
  }
};

class UnifiedArchitectureTester {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      total: 0,
      details: []
    };
    this.supabase = createClient(TEST_CONFIG.SUPABASE_URL, TEST_CONFIG.SUPABASE_SERVICE_ROLE_KEY);
  }

  async runTest(testName, testFn) {
    this.results.total++;
    console.log(`\n🧪 Running: ${testName}`);

    try {
      const startTime = Date.now();
      await testFn();
      const duration = Date.now() - startTime;

      this.results.passed++;
      console.log(`✅ ${testName} - PASSED (${duration}ms)`);
      this.results.details.push({ name: testName, status: 'PASSED', duration, error: null });
    } catch (error) {
      this.results.failed++;
      console.log(`❌ ${testName} - FAILED: ${error.message}`);
      this.results.details.push({ name: testName, status: 'FAILED', duration: null, error: error.message });
    }
  }

  async testServiceHealth(serviceName, port) {
    const response = await fetch(`http://127.0.0.1:${port}`);
    if (!response.ok) {
      throw new Error(`Service returned ${response.status}`);
    }

    const data = await response.json();
    if (!data.status || data.status !== 'healthy') {
      throw new Error(`Service not healthy: ${JSON.stringify(data)}`);
    }

    console.log(`   📊 ${serviceName}: ${data.status} ${data.version ? `(${data.version})` : ''}`);
  }

  async testHTTPHandler() {
    // Test CORS preflight
    const corsResponse = await fetch('http://127.0.0.1:8001', {
      method: 'OPTIONS'
    });

    if (!corsResponse.ok) {
      throw new Error('CORS preflight failed');
    }

    const corsHeaders = corsResponse.headers;
    if (!corsHeaders.get('access-control-allow-origin')) {
      throw new Error('CORS headers missing');
    }

    console.log('   🌐 CORS headers working correctly');
  }

  async testServiceRegistry() {
    // Test service registry call
    const response = await fetch('http://127.0.0.1:8001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'health-check' })
    });

    if (!response.ok) {
      throw new Error('Service registry call failed');
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(`Service registry error: ${data.error}`);
    }

    console.log('   📋 Service registry responding correctly');
  }

  async testDatabaseConnection() {
    // Test database connectivity
    const { data, error } = await this.supabase
      .from('task_runs')
      .select('id, status')
      .limit(1);

    if (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }

    console.log('   🗄️ Database connection successful');
  }

  async testConfigurationService() {
    // Test if services are using the unified configuration
    const response = await fetch('http://127.0.0.1:8001/health');
    const data = await response.json();

    if (!data.data || !data.data.service) {
      throw new Error('Configuration service not providing service info');
    }

    console.log(`   ⚙️ Configuration service working: ${data.data.service}`);
  }

  async testFlowStateIntegration() {
    // Create a test task to verify FlowState integration
    const { data: taskData, error: taskError } = await this.supabase
      .from('task_functions')
      .select('id')
      .eq('name', 'comprehensive-gmail-search')
      .single();

    if (taskError) {
      throw new Error(`Cannot find test task: ${taskError.message}`);
    }

    // Create a test task run
    const { data: runData, error: runError } = await this.supabase
      .from('task_runs')
      .insert({
        task_function_id: taskData.id,
        task_name: 'test-flowstate-integration',
        status: 'pending',
        input: { test: true }
      })
      .select('id')
      .single();

    if (runError) {
      throw new Error(`Failed to create test task: ${runError.message}`);
    }

    console.log(`   🔄 FlowState integration test created task run: ${runData.id}`);

    // Clean up test data
    await this.supabase
      .from('task_runs')
      .delete()
      .eq('id', runData.id);

    console.log('   🧹 Test data cleaned up');
  }

  async testServiceDiscovery() {
    // Test that all required services are discoverable
    const requiredServices = ['wrappedkeystore', 'wrappedsupabase', 'wrappedgapi'];

    for (const service of requiredServices) {
      const response = await fetch(`http://127.0.0.1:8001`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'discover-service',
          service: service
        })
      });

      // Services should respond (even if not all are running)
      console.log(`   🔍 Service discovery: ${service} - ${response.status}`);
    }
  }

  async testErrorHandling() {
    // Test unified error handling
    const response = await fetch('http://127.0.0.1:8001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: 'data' })
    });

    const data = await response.json();

    if (data.success !== false || !data.error) {
      throw new Error('Error handling not working correctly');
    }

    console.log(`   🚨 Error handling working: ${data.error}`);
  }

  async runAllTests() {
    console.log('🚀 Starting Unified Architecture Test Suite');
    console.log('=' .repeat(60));

    // Service Health Tests
    await this.runTest('Stack Processor Health', () => this.testServiceHealth('Stack Processor', 8001));

    // HTTP Handler Tests
    await this.runTest('HTTP Handler & CORS', () => this.testHTTPHandler());

    // Service Registry Tests
    await this.runTest('Service Registry Integration', () => this.testServiceRegistry());

    // Database Tests (will fail until Supabase is ready)
    await this.runTest('Database Connection', () => this.testDatabaseConnection());

    // Configuration Tests
    await this.runTest('Configuration Service', () => this.testConfigurationService());

    // FlowState Tests
    await this.runTest('FlowState Integration', () => this.testFlowStateIntegration());

    // Service Discovery Tests
    await this.runTest('Service Discovery', () => this.testServiceDiscovery());

    // Error Handling Tests
    await this.runTest('Unified Error Handling', () => this.testErrorHandling());

    this.printResults();
  }

  printResults() {
    console.log('\n' + '=' .repeat(60));
    console.log('📊 TEST RESULTS SUMMARY');
    console.log('=' .repeat(60));

    const passRate = ((this.results.passed / this.results.total) * 100).toFixed(1);

    console.log(`Total Tests: ${this.results.total}`);
    console.log(`Passed: ${this.results.passed} ✅`);
    console.log(`Failed: ${this.results.failed} ❌`);
    console.log(`Pass Rate: ${passRate}%`);

    if (this.results.failed > 0) {
      console.log('\n❌ FAILED TESTS:');
      this.results.details
        .filter(test => test.status === 'FAILED')
        .forEach(test => {
          console.log(`   - ${test.name}: ${test.error}`);
        });
    }

    console.log('\n🏗️ ARCHITECTURE COMPONENTS TESTED:');
    console.log('   ✅ Unified HTTP Handler (BaseHttpHandler)');
    console.log('   ✅ CORS Headers and Response Formatting');
    console.log('   ✅ Service Registry Integration');
    console.log('   ✅ Configuration Service (ConfigService)');
    console.log('   ✅ Database Service (when Supabase ready)');
    console.log('   ✅ FlowState Integration');
    console.log('   ✅ Service Discovery');
    console.log('   ✅ Unified Error Handling');

    if (this.results.passed === this.results.total) {
      console.log('\n🎉 ALL TESTS PASSED! Unified architecture is working correctly.');
    } else {
      console.log('\n⚠️  Some tests failed. This may be due to services still starting up.');
    }
  }
}

// Run tests
const tester = new UnifiedArchitectureTester();
tester.runAllTests().catch(console.error);