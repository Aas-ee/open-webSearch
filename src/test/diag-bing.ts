/**
 * 诊断脚本：分析 Bing 搜索为何对指定查询返回 0 结果。
 * 运行: npx tsx src/test/diag-bing.ts
 */
import { getSharedBrowser, destroySharedBrowser } from '../engines/shared/browser.js';
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';
import { join } from 'path';

const QUERY = 'proot-xed signal 11 SIGSEGV bus error Android apk add bash post-install crash workaround';

async function diagnose() {
    console.log('=== Bing 搜索诊断 ===');
    console.log(`查询: "${QUERY}"`);
    console.log(`编码后: ${encodeURIComponent(QUERY)}`);
    console.log(`URL 长度: ${'https://www.bing.com/search?q='.length + encodeURIComponent(QUERY).length}`);
    console.log();

    const browser = await getSharedBrowser();
    const page = await browser.newPage();

    try {
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(QUERY)}`;
        console.log(`导航到: ${searchUrl}`);
        
        const response = await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log(`HTTP 状态码: ${response?.status()}`);
        console.log(`最终 URL: ${page.url()}`);
        
        await new Promise(r => setTimeout(r, 2000)); // 多等一会

        const html = await page.content();
        const outPath = join(process.cwd(), 'diag-bing-output.html');
        writeFileSync(outPath, html, 'utf8');
        console.log(`\n页面 HTML 已保存到: ${outPath} (${html.length} 字符)`);

        // 截图
        const screenshotPath = join(process.cwd(), 'diag-bing-screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`截图已保存到: ${screenshotPath}`);

        const $ = cheerio.load(html);
        
        console.log('\n=== 选择器分析 ===');
        console.log(`#b_results 是否存在: ${$('#b_results').length > 0}`);
        console.log(`#b_results 子元素数: ${$('#b_results').children().length}`);
        console.log(`#b_results h2 数量: ${$('#b_results h2').length}`);
        console.log(`#b_results li 数量: ${$('#b_results li').length}`);
        console.log(`#b_results .b_algo 数量: ${$('#b_results .b_algo').length}`);
        console.log(`所有 h2 数量: ${$('h2').length}`);
        console.log(`所有 h2 文本:`);
        $('h2').each((i, el) => {
            console.log(`  [${i}] ${$(el).text().trim().substring(0, 100)}`);
        });

        // 检查 Cookie 同意弹窗
        console.log('\n=== Cookie/弹窗检测 ===');
        const cookieSelectors = [
            '#bnp_container',       // Bing cookie banner
            '#bnp_btn_accept',      // Bing accept button
            '.bnp_btn_accept',
            '#consent-banner',
            '.consent-banner',
            '#onetrust-banner',
            '.cc-banner',
            '#cookie-banner',
            '#b_notificationContainer',
            'div[data-bm="1"]',     // Bing modal overlay
        ];
        for (const sel of cookieSelectors) {
            const count = $(sel).length;
            if (count > 0) {
                console.log(`  ✓ 发现弹窗元素: ${sel} (${count} 个)`);
                console.log(`    内容: ${$(sel).text().trim().substring(0, 200)}`);
            }
        }

        // 检查验证码
        console.log('\n=== 验证码/反爬检测 ===');
        const captchaSelectors = [
            '#captcha',
            '.captcha',
            '#cf-wrapper',          // Cloudflare challenge
            '#challenge-running',
            'form[action*="captcha"]',
            '#bnp_captcha',
        ];
        for (const sel of captchaSelectors) {
            const count = $(sel).length;
            if (count > 0) {
                console.log(`  ✓ 发现验证码元素: ${sel} (${count} 个)`);
            }
        }

        // 检查 "没有结果" 提示
        console.log('\n=== 无结果/错误提示检测 ===');
        const noResultSelectors = [
            '.b_no',                // Bing no results
            '.b_msg',
            '#b_results .b_ans',
        ];
        for (const sel of noResultSelectors) {
            const count = $(sel).length;
            if (count > 0) {
                console.log(`  ✓ 发现提示: ${sel}: "${$(sel).text().trim().substring(0, 200)}"`);
            }
        }

        // 检查是否被重定向到 cn.bing.com 或其他本地化版本
        console.log('\n=== URL/重定向分析 ===');
        const finalUrl = page.url();
        console.log(`最终 URL: ${finalUrl}`);
        if (!finalUrl.includes('www.bing.com')) {
            console.log('⚠️ 被重定向到了非 www.bing.com 的域名！');
        }

        // 输出页面 title
        console.log(`\n页面标题: ${$('title').text()}`);

        // 显示 body 的前 1000 个文本字符
        console.log('\n=== 页面正文前 500 字符 ===');
        const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
        console.log(bodyText.substring(0, 500));

        // 检查 #b_results 内部结构
        console.log('\n=== #b_results 内部结构 ===');
        $('#b_results').children().each((i, el) => {
            const tag = (el as any).tagName;
            const cls = $(el).attr('class') || '';
            const id = $(el).attr('id') || '';
            const h2Text = $(el).find('h2').first().text().trim().substring(0, 80);
            console.log(`  [${i}] <${tag}> class="${cls}" id="${id}" h2="${h2Text}"`);
            if (i > 15) {
                console.log('  ... (截断)');
                return false;
            }
        });

        // 看链接
        console.log('\n=== #b_results 中的 a[href^=http] ===');
        let linkCount = 0;
        $('#b_results a[href^="http"]').each((i, el) => {
            if (linkCount >= 10) return false;
            const href = $(el).attr('href');
            const text = $(el).text().trim().substring(0, 80);
            if (text) {
                console.log(`  [${linkCount}] "${text}" -> ${href?.substring(0, 120)}`);
                linkCount++;
            }
        });
        if (linkCount === 0) {
            console.log('  (无 http 链接)');
        }

    } finally {
        await page.close();
        await destroySharedBrowser();
    }
}

diagnose().catch(err => {
    console.error('诊断失败:', err);
    process.exit(1);
});
