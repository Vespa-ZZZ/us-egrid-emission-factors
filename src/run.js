import {
    DETAILED_DATA, HISTORICAL_DATA, discoverWorkbooks, normalizeInput, parseWorkbook, sanitize,
} from './egrid.js';

const REQUEST_INTERVAL_MS = 2350;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const LISTING_BYTES = 2 * 1024 * 1024;
const WORKBOOK_BYTES = 64 * 1024 * 1024;
const USER_AGENT = 'us-egrid-emission-factors-actor/1.0';

class SourceError extends Error {}

function retryAfterMs(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

async function readBody(response, url, maxBytes) {
    if (!response.body) throw new SourceError('Empty response from ' + url + '.');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks, length);
            length += value.length;
            if (length > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new SourceError('Response exceeds the download limit for ' + url + '.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
}

export async function runActor(rawInput, {
    actor, fetch = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), warn = () => {},
}) {
    const input = normalizeInput(rawInput);
    let madeRequest = false;

    async function download(url, maxBytes) {
        let delay = madeRequest ? REQUEST_INTERVAL_MS : 0;
        for (let attempt = 0; ; attempt++) {
            if (delay) await sleep(delay);
            madeRequest = true;
            let retryAfter = 0;
            let failure;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                if (response.status === 200) return await readBody(response, url, maxBytes);
                await response.body?.cancel().catch(() => {});
                failure = 'EPA returned HTTP ' + response.status + ' for ' + url + '.';
                if (response.status !== 429 && (response.status < 500 || response.status > 599)) {
                    throw new SourceError(failure);
                }
                retryAfter = retryAfterMs(response.headers.get('retry-after'));
            } catch (error) {
                if (error instanceof SourceError) throw error;
                failure = 'Request failed for ' + url + ' (' + sanitize(error?.message ?? error) + ').';
            }
            if (attempt === MAX_RETRIES) throw new SourceError(failure);
            if (retryAfter > MAX_RETRY_AFTER_MS) {
                throw new SourceError(failure + ' EPA requested a retry delay longer than 60 seconds. Run again later.');
            }
            delay = Math.max(REQUEST_INTERVAL_MS * 2 ** attempt, retryAfter);
            warn(failure + ' Retrying in ' + delay / 1000 + ' seconds.');
        }
    }

    async function list(url) {
        return discoverWorkbooks((await download(url, LISTING_BYTES)).toString('utf8'), url);
    }

    const current = await list(DETAILED_DATA);
    const years = input.dataYears.length ? input.dataYears : [Math.max(...current.keys())];
    const archive = years.some((year) => !current.has(year)) ? await list(HISTORICAL_DATA) : new Map();
    const available = new Map([...archive, ...current]);
    const unavailable = years.filter((year) => !available.has(year));
    if (unavailable.length) {
        const published = [...available.keys()].sort((a, b) => b - a);
        throw new Error('No standalone EPA eGRID XLSX for ' + unavailable.join(', ')
            + '. Available data years: ' + published.join(', ') + '.');
    }

    const workbooks = new Map();
    const records = [];
    for (const year of years) {
        const book = available.get(year);
        // Cache parsed workbook data per URL for this run and release the downloaded bytes after parsing.
        if (!workbooks.has(book.sourceUrl)) {
            const bytes = await download(book.sourceUrl, WORKBOOK_BYTES);
            workbooks.set(book.sourceUrl, await parseWorkbook(bytes, input, book));
        }
        records.push(...workbooks.get(book.sourceUrl));
    }

    const result = await actor.pushData(records);
    if (result?.eventChargeLimitReached) {
        warn('Pay-per-event charge limit reached during dataset output.');
        return result.chargedCount;
    }
    return records.length;
}
