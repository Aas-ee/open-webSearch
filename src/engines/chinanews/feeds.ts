// Public publisher feeds, not arbitrary URLs supplied by a search request.
// The aliases translate broad search topics only; raw query/persona text is
// never sent to the publisher. Each result must still match its topic locally.
type FeedTopic = { query: RegExp; content: RegExp; feeds: string[] };

const topics: FeedTopic[] = [
    { query: /\b(literature|books?|publishing|author|novel)\b|文学|图书|出版|读书/i,
        content: /文学|图书|出版|读书|作家|小说|书店|新书|诗歌/, feeds: ['culture'] },
    { query: /\b(film|cinema|movies?)\b|电影|影片/i,
        content: /电影|影片|导演|影展|票房|银幕/, feeds: ['culture'] },
    { query: /\b(music|concert|album|song)\b|音乐|演出/i,
        content: /音乐|演奏|音乐节|演唱|歌曲|专辑/, feeds: ['culture'] },
    { query: /\b(history|culture|museum|heritage|archaeology)\b|历史|文化|博物馆|文物/i,
        content: /历史|文化|博物馆|文物|考古|遗产|遗址/, feeds: ['culture'] },
    { query: /\b(art|design|exhibition|gallery)\b|艺术|设计|展览/i,
        content: /艺术|设计|展览|美术|画展|摄影/, feeds: ['culture'] },
    { query: /\b(psychology|wellbeing|personal growth|mental health)\b|心理|成长|健康/i,
        content: /心理|健康|情绪|焦虑|抑郁|成长/, feeds: ['jk', 'life'] },
    { query: /\b(food|beverage|restaurant|coffee|tea|cooking)\b|饮食|餐饮|咖啡|美食/i,
        content: /饮食|餐饮|咖啡|美食|食品|餐厅|食物|烹饪|茶/, feeds: ['life', 'finance'] },
    { query: /\b(travel|outdoor|hiking|tourism)\b|旅行|旅游|户外/i,
        content: /旅行|旅游|户外|徒步|骑行|文旅/, feeds: ['culture', 'life'] },
    { query: /\b(sport|sports|fitness|running|swimming)\b|运动|体育|健身/i,
        content: /运动|体育|健身|跑步|游泳|比赛|足球|篮球/, feeds: ['sports'] },
    { query: /\b(urban|city|community)\b|城市|社区/i,
        content: /城市|社区|街区|公共空间|居民/, feeds: ['society'] },
    { query: /\b(finance|economy|markets?|investment)\b|财经|经济|投资/i,
        content: /金融|财经|经济|市场|投资|消费/, feeds: ['finance'] },
    { query: /\b(ai|agentic|artificial intelligence|technology|robotics?|science|space|software|devops|smartphone)\b|人工智能|科技|科学|航天|机器人/i,
        content: /人工智能|大模型|科技|科学|航天|太空|机器人|芯片|软件|手机/, feeds: ['finance', 'society'] },
    { query: /\b(games?|gaming)\b|游戏|电竞/i,
        content: /游戏|电竞/, feeds: ['finance', 'culture'] }
];

export function chinaNewsFeedPlan(query: string): { urls: string[]; matches: (text: string) => boolean } {
    const matched = topics.filter(topic => topic.query.test(query));
    const feeds = [...new Set(matched.flatMap(topic => topic.feeds))].slice(0, 3);
    return {
        urls: feeds.map(feed => `https://www.chinanews.com.cn/rss/${feed}.xml`),
        matches: text => matched.some(topic => topic.content.test(text))
    };
}
