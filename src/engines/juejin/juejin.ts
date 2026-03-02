import axios from 'axios';
import { SearchResult } from '../../types.js';
import { config } from '../../config.js';

interface JuejinSearchResponse {
    err_no: number;
    err_msg: string;
    data: Array<{
        result_type: number;
        result_model: {
            article_id: string;
            article_info: {
                title: string;
                brief_content: string;
                view_count: number;
                digg_count: number;
                comment_count: number;
                ctime: string;
            };
            author_user_info: {
                user_name: string;
                avatar_large: string;
                description: string;
            };
            category: {
                category_name: string;
            };
            tags: Array<{
                tag_name: string;
            }>;
        };
        title_highlight: string;
        content_highlight: string;
    }>;
    cursor: string;
    has_more: boolean;
}

export async function searchJuejin(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let cursor = '0';

    try {
        while (allResults.length < limit) {
            console.error(`🔍 Searching Juejin with query: "${query}", cursor: ${cursor}`);

            const response = await axios.get<JuejinSearchResponse>('https://api.juejin.cn/search_api/v1/search', {
                timeout: config.requestTimeout,
                params: {
                    aid: '2608',
                    uuid: '7259393293459605051',
                    spider: '0',
                    query: query,
                    id_type: '0',
                    cursor: cursor,
                    limit: Math.min(20, limit - allResults.length),
                    search_type: '0',
                    sort_type: '0',
                    version: '1'
                },
                headers: {
                    'pragma': 'no-cache',
                    'priority': 'u=1, i',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
                    'content-type': 'application/json',
                    'Accept': '*/*',
                    'Host': 'api.juejin.cn',
                    'Connection': 'keep-alive'
                }
            });

            const responseData = response.data;

            if (responseData.err_no !== 0) {
                console.error(`❌ Juejin API error: ${responseData.err_msg}`);
                break;
            }

            if (!responseData.data || !Array.isArray(responseData.data)) {
                console.error('⚠️ No more results from Juejin API');
                break;
            }

            const results: SearchResult[] = responseData.data
                .filter((item) => item.result_model?.article_info && item.result_model?.author_user_info)
                .map((item) => {
                const { result_model, title_highlight, content_highlight } = item;
                const { article_info, author_user_info, category, tags } = result_model;

                // 移除HTML标签的高亮标记
                const cleanTitle = (title_highlight || article_info.title || '').replace(/<\/?em>/g, '');
                const cleanContent = (content_highlight || article_info.brief_content || '').replace(/<\/?em>/g, '');

                const tagNames = (tags || []).map(tag => tag.tag_name).join(', ');
                const description = `${cleanContent} | 分类: ${category?.category_name ?? ''} | 标签: ${tagNames} | 👍 ${article_info.digg_count} | 👀 ${article_info.view_count}`;

                return {
                    title: cleanTitle,
                    url: `https://juejin.cn/post/${result_model.article_id}`,
                    description: description,
                    source: author_user_info.user_name,
                    engine: 'juejin'
                };
            });

            allResults = allResults.concat(results);

            // 检查是否有下一页
            if (!responseData.has_more || !responseData.cursor || results.length === 0) {
                console.error('⚠️ No more results, ending search');
                break;
            }

            cursor = responseData.cursor;
        }

        console.error(`✅ Juejin search completed, found ${allResults.length} results`);
        return allResults.slice(0, limit);

    } catch (error) {
        const msg = axios.isAxiosError(error)
            ? [error.code, error.message, error.response?.status && `HTTP ${error.response.status}`].filter(Boolean).join(' - ')
            : (error instanceof Error ? error.message : String(error));
        console.error(`❌ Juejin search failed: ${msg}`);
        return [];
    }
}
