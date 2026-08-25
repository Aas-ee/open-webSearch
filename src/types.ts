export interface SearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    sourceDomain?: string;
    dateText?: string;
    publishedAt?: string;
    engine: string;
    engines?: string[];
    score?: number;
}

export type SearchVertical = 'web' | 'news';
