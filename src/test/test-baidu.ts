import { searchBaidu } from '../engines/baidu/index.js';
import { destroySharedBrowser } from '../engines/shared/browser.js';

async function testBaiduSearch() {
  console.log('🔍 Starting Baidu search test...');

  try {
    const query = 'websearch mcp';
    const maxResults = 25;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchBaidu(query, maxResults);

    console.log(`🎉 Search completed, retrieved ${results.length} results:`);
    results.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.title}`);
      console.log(`   🔗 ${result.url}`);
      console.log(`   📄 ${result.description.substring(0, 100)}...`);
      console.log(`   🌐 Source: ${result.source}`);
    });

    return results;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return [];
  }
}

// Run the test
testBaiduSearch().catch(console.error).finally(async () => { await destroySharedBrowser(); process.exit(0); });
