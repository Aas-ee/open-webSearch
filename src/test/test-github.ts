import { fetchGithubReadme } from '../engines/github/github.js';

/**
 * Test suite for GitHub README fetcher
 */

interface TestCase {
    url: string;
    description: string;
    shouldSucceed: boolean;
}

const testCases: TestCase[] = [
    {
        url: 'https://github.com/imsyy/SPlayer/blob/dev/README.md',
        description: 'GitHub URL with branch and file path',
        shouldSucceed: true
    },
    {
        url: 'https://github.com/Aas-ee/open-webSearch?tab=readme-ov-file',
        description: 'GitHub URL with query parameters',
        shouldSucceed: true
    },
    {
        url: 'https://github.com/facebook/react',
        description: 'Simple GitHub repository URL',
        shouldSucceed: true
    },
    {
        url: 'git@github.com:microsoft/vscode.git',
        description: 'SSH Git URL format',
        shouldSucceed: true
    },
    {
        url: 'https://github.com/invalid/nonexistent-repo',
        description: 'Non-existent repository (should fail gracefully)',
        shouldSucceed: false
    },
    {
        url: 'invalid-url',
        description: 'Invalid URL format (should fail gracefully)',
        shouldSucceed: false
    },
    {
        url: 'https://github.com/torvalds/linux',
        description: 'Large repository (Linux kernel)',
        shouldSucceed: true
    },
    {
        url: 'https://www.github.com/nodejs/node.git',
        description: 'URL with www prefix and .git suffix',
        shouldSucceed: true
    }
];

/**
 * Run individual test case
 */
async function runTestCase(testCase: TestCase): Promise<void> {
    console.log(`\n🧪 Testing: ${testCase.description}`);
    console.log(`📎 URL: ${testCase.url}`);

    try {
        const startTime = Date.now();
        const result = await fetchGithubReadme(testCase.url);
        const duration = Date.now() - startTime;

        if (result && testCase.shouldSucceed) {
            console.log(`✅ SUCCESS (${duration}ms) - README fetched (${result.length} characters)`);
            console.log(`📄 Preview: ${result.substring(0, 100).replace(/\n/g, ' ')}...`);
        } else if (!result && !testCase.shouldSucceed) {
            console.log(`✅ SUCCESS (${duration}ms) - Failed as expected`);
        } else if (result && !testCase.shouldSucceed) {
            console.log(`⚠️  UNEXPECTED SUCCESS (${duration}ms) - Expected to fail but got result`);
        } else {
            console.log(`❌ UNEXPECTED FAILURE (${duration}ms) - Expected success but failed`);
        }
    } catch (error) {
        if (testCase.shouldSucceed) {
            console.log(`❌ ERROR - Unexpected exception:`, error);
        } else {
            console.log(`✅ SUCCESS - Failed as expected with exception`);
        }
    }
}

/**
 * Run all tests
 */
async function runAllTests(): Promise<void> {
    console.log('🚀 Starting GitHub README Fetcher Test Suite');
    console.log('=' .repeat(60));

    let successCount = 0;
    let failureCount = 0;
    const startTime = Date.now();

    for (const testCase of testCases) {
        try {
            await runTestCase(testCase);
            successCount++;
        } catch (error) {
            console.log(`❌ Test case failed with exception:`, error);
            failureCount++;
        }

        // Add small delay between tests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const totalTime = Date.now() - startTime;

    console.log('\n' + '=' .repeat(60));
    console.log('📊 Test Results Summary:');
    console.log(`✅ Successful tests: ${successCount}`);
    console.log(`❌ Failed tests: ${failureCount}`);
    console.log(`⏱️  Total time: ${totalTime}ms`);
    console.log(`📈 Success rate: ${((successCount / testCases.length) * 100).toFixed(1)}%`);

    if (failureCount === 0) {
        console.log('🎉 All tests completed successfully!');
    } else {
        console.log('⚠️  Some tests failed. Please review the results above.');
    }
}

/**
 * Performance test with multiple concurrent requests
 */
async function runPerformanceTest(): Promise<void> {
    console.log('\n🏃‍♂️ Running Performance Test...');

    const testUrl = 'https://github.com/facebook/react';
    const concurrentRequests = 5;

    const startTime = Date.now();

    const promises = Array(concurrentRequests).fill(null).map(async (_, index) => {
        console.log(`🔄 Starting concurrent request ${index + 1}`);
        return fetchGithubReadme(testUrl);
    });

    try {
        const results = await Promise.all(promises);
        const endTime = Date.now();

        const successfulResults = results.filter(result => result !== null);

        console.log(`⚡ Performance Test Results:`);
        console.log(`📊 Concurrent requests: ${concurrentRequests}`);
        console.log(`✅ Successful requests: ${successfulResults.length}`);
        console.log(`⏱️  Total time: ${endTime - startTime}ms`);
        console.log(`📈 Average time per request: ${((endTime - startTime) / concurrentRequests).toFixed(1)}ms`);

    } catch (error) {
        console.log(`❌ Performance test failed:`, error);
    }
}

/**
 * Main test runner
 */
async function main(): Promise<void> {
    try {
        await runAllTests();
        await runPerformanceTest();
    } catch (error) {
        console.error('❌ Test suite failed:', error);
        process.exit(1);
    }
}


main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });


