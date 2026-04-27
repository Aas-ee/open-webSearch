import { searchDuckDuckGo } from '../engines/duckduckgo/index.js';

async function testDuckDuckGoSearch() {
  console.log('🔍 Starting DuckDuckGo search test...');

  try {
    // const query = 'site:zhuanlan.zhihu.com websearch mcp';
    const query = 'site:linux.do websearch mcp';
    const maxResults = 30;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchDuckDuckGo(query, maxResults);

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
testDuckDuckGoSearch()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
