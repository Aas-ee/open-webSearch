import { config, getAcceptLanguage } from '../config.js';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function main(): void {
    assertEqual(config.locale, process.env.OPEN_WEBSEARCH_LOCALE?.trim() || 'en-US', 'default locale');
    assertEqual(getAcceptLanguage('zh-CN'), 'zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN keeps the previous header');
    assertEqual(getAcceptLanguage('en-US'), 'en-US,en;q=0.9', 'en-US');
    assertEqual(getAcceptLanguage('en'), 'en', 'bare en');
    assertEqual(getAcceptLanguage('ja-JP'), 'ja-JP,ja;q=0.9,en;q=0.8', 'ja-JP');
    console.log('✅ locale Accept-Language headers');
}

main();
