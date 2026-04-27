import { searchJuejin } from '../engines/juejin/index.js';
import { SearchResult } from '../types.js';

async function testJuejin() {
  console.log('🔍 Starting Juejin search test...');

  try {
    const query = 'openwebsearch';
    const maxResults = 30;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchJuejin(query, maxResults);

    console.log(`🎉 Search completed, retrieved ${results.length} results:`);
    results.forEach((result: SearchResult, index: number) => {
      console.log(`\n${index + 1}. ${result.title}`);
      console.log(`   🔗 ${result.url}`);
      console.log(`   📄 ${result.description.substring(0, 150)}...`);
      console.log(`   👤 Author: ${result.source}`);
    });

    return results;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return [];
  }
}

// 运行测试
testJuejin()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
