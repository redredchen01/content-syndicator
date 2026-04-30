import { ContentAgent } from './agent/core';
import { logger } from './utils/logger';

async function testAgent() {
  logger.info('=== Content Agent Test ===');

  const agent = new ContentAgent({
    maxIterations: 5,
    enableReflection: true,
    enableLearning: true,
    verbose: true,
  });

  try {
    // Test with a simple task
    const result = await agent.run('Scrape and publish content from URL', {
      url: 'https://example.com',
    });

    logger.success('=== Agent Test Complete ===');
    console.log('Final State:', agent.getState());
    console.log('Iterations:', agent.getIterationCount());
    console.log('Context:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    logger.error('Agent test failed:', error);
  }
}

// Run test if this file is executed directly
if (require.main === module) {
  testAgent().then(() => {
    console.log('Test finished');
    process.exit(0);
  }).catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  });
}
