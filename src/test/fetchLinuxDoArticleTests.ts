import { fetchLinuxDoArticle } from "../engines/linuxdo/fetchLinuxDoArticle.js";

async function testFetchLinuxDoArticle() {
  console.log('🔍 Starting Linux.do article fetch test...');

  try {
    // A real linux.do topic URL (standard Discourse format: /t/slug/id)
    const url = 'https://linux.do/t/welcome-to-linux-do/1';

    console.log(`📝 Fetching article from URL: ${url}`);

    const result = await fetchLinuxDoArticle(url);

    console.log(`🎉 Article fetched successfully!`);
    console.log(`\n📄 Content preview (first 200 chars):`);
    console.log(`   ${result.content.substring(0, 200)}`);
    console.log(`\n📊 Total content length: ${result.content.length} characters`);

    return result;
  } catch (error) {
    console.error('❌ Test failed:', error instanceof Error ? error.message : error);
    if (error && typeof error === 'object' && 'response' in error) {
      const resp = (error as any).response;
      console.error(`   HTTP Status: ${resp?.status}`);
      console.error(`   Status Text: ${resp?.statusText}`);
    }
    return { content: '' };
  }
}

async function testInvalidUrl() {
  console.log('\n🔍 Testing with invalid URL...');

  try {
    const invalidUrl = 'https://linux.do/invalid_path';

    console.log(`📝 Attempting to fetch from invalid URL: ${invalidUrl}`);

    const result = await fetchLinuxDoArticle(invalidUrl);
    console.log(`🎉 Result: ${result.content.substring(0, 100)}`);

    return result;
  } catch (error) {
    console.log('✅ Expected error for invalid URL:', error instanceof Error ? error.message : error);
    return { content: '' };
  }
}

async function runTests() {
  console.log('🧪 Running tests for fetchLinuxDoArticle function\n');

  await testFetchLinuxDoArticle();
  await testInvalidUrl();

  console.log('\n✅ All tests completed');
}

runTests().catch(console.error);
