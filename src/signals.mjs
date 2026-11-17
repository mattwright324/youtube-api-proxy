const DEFAULT_UA_PATTERNS = [
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'python', 'node', 'undici', 'axios',
    'curl', 'wget', 'go-http-client', 'okhttp', 'java/', 'apache-httpclient', 'libwww', 'httpie', 'postman',
    'insomnia', 'scrapy', 'php', 'ruby', 'perl', 'powershell', 'deno', 'bun/', 'bot', 'spider', 'crawler',
];

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function createScriptDetector({corsWhitelist = [], expectedParams = [], extraUaPatterns = []} = {}) {
    const origins = new Set(corsWhitelist.filter(Boolean));
    const params = expectedParams.filter(Boolean);
    const uaPattern = new RegExp([...DEFAULT_UA_PATTERNS, ...extraUaPatterns.filter(Boolean)].map(escapeRegex).join('|'), 'i');

    function classify(req) {
        const signals = [];
        const userAgent = req.get('user-agent');
        if (!userAgent || uaPattern.test(userAgent)) signals.push('non-browser-ua');

        const origin = req.get('origin');
        if (!origin) signals.push('no-origin');
        else if (origins.size && !origins.has(origin)) signals.push('unlisted-origin');

        if (!req.get('sec-fetch-mode')) signals.push('no-sec-fetch');

        if (params.length && req.path.startsWith('/v3/') && params.some(param => !Object.hasOwn(req.query, param))) {
            signals.push('missing-params');
        }
        return signals;
    }

    return {
        classify,
        settings: {expectedParams: params, extraUaPatterns: extraUaPatterns.filter(Boolean), origins: [...origins]},
    };
}
