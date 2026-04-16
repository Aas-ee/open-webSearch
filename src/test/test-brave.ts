import {searchBrave} from "../engines/brave/index.js";

async function testBraveSearch() {
  console.log('🔍 Starting Brave search test...');

  try {
    const query = 'websearchmcp';
    const maxResults = 30;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchBrave(query, maxResults);

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
testBraveSearch()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
