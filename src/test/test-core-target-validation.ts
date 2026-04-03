import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../core/validation/targetValidation.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function testValidateArticleUrl(): void {
    assert(
        validateArticleUrl('https://linux.do/t/topic/123.json', 'linuxdo'),
        'linuxdo json endpoint should be valid'
    );
    assert(
        !validateArticleUrl('https://linux.do/t/topic/123', 'linuxdo'),
        'linuxdo non-json endpoint should be invalid'
    );

    assert(
        validateArticleUrl('https://blog.csdn.net/user/article/details/123456', 'csdn'),
        'csdn article details url should be valid'
    );
    assert(
        !validateArticleUrl('https://www.csdn.net/article/details/123456', 'csdn'),
        'non-blog.csdn.net host should be invalid for csdn article fetch'
    );

    assert(
        validateArticleUrl('https://juejin.cn/post/1234567890', 'juejin'),
        'juejin post url should be valid'
    );
    assert(
        !validateArticleUrl('https://juejin.cn/pin/1234567890', 'juejin'),
        'juejin non-post url should be invalid'
    );

    console.log('✅ validateArticleUrl');
}

function testValidateGithubRepositoryUrl(): void {
    assert(
        validateGithubRepositoryUrl('https://github.com/Aas-ee/open-webSearch'),
        'https github repo url should be valid'
    );
    assert(
        validateGithubRepositoryUrl('git@github.com:Aas-ee/open-webSearch.git'),
        'ssh github repo url should be valid'
    );
    assert(
        !validateGithubRepositoryUrl('https://github.com/Aas-ee'),
        'single-segment github path should be invalid'
    );
    assert(
        !validateGithubRepositoryUrl('https://gitlab.com/Aas-ee/open-webSearch'),
        'non-github host should be invalid'
    );

    console.log('✅ validateGithubRepositoryUrl');
}

function testValidatePublicWebUrl(): void {
    assert(
        validatePublicWebUrl('https://example.com/docs'),
        'public https url should be valid'
    );
    assert(
        !validatePublicWebUrl('http://127.0.0.1:3000'),
        'loopback url should be rejected'
    );
    assert(
        !validatePublicWebUrl('file:///etc/passwd'),
        'non-http scheme should be rejected'
    );

    console.log('✅ validatePublicWebUrl');
}

function main(): void {
    testValidateArticleUrl();
    testValidateGithubRepositoryUrl();
    testValidatePublicWebUrl();
    console.log('\nCore target validation tests passed.');
}

main();
