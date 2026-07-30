import { searchYoucom } from '../engines/youcom/index.js';

async function testYoucomSearch() {
    console.log('Testing You.com search engine...');
    
    const query = 'TypeScript tutorials';
    const maxResults = 5;
    
    console.log(`Searching for: "${query}" (max results: ${maxResults})`);
    
    try {
        const results = await searchYoucom(query, maxResults);
        
        console.log(`\nResults found: ${results.length}`);
        
        results.forEach((result, index) => {
            console.log(`\n${index + 1}. ${result.title}`);
            console.log(`   URL: ${result.url}`);
            console.log(`   Source: ${result.source}`);
            console.log(`   Engine: ${result.engine}`);
            console.log(`   Description: ${result.description?.substring(0, 100)}...`);
        });
        
        if (results.length === 0) {
            console.log('\nNo results returned. This could be due to:');
            console.log('- Network connectivity issues');
            console.log('- Rate limiting (try setting YDC_API_KEY environment variable)');
            console.log('- API response format changes');
        }
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testYoucomSearch();
