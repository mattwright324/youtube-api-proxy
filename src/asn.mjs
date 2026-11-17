import fs from 'node:fs/promises';
import net from 'node:net';
import {join} from 'node:path';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {createLogger} from './log.mjs';

const gunzip = promisify(zlib.gunzip);

const SOURCE_URL = 'https://iptoasn.com/data/ip2asn-v4.tsv.gz';
const FILE_NAME = 'ip2asn-v4.tsv.gz';

function ipToInt(ip) {
    const parts = ip.split('.');
    return ((Number(parts[0]) << 24) >>> 0) + (Number(parts[1]) << 16) + (Number(parts[2]) << 8) + Number(parts[3]);
}

/**
 * Parses the TSV (range_start, range_end, AS_number, country_code, AS_description) into sorted typed arrays.
 * Network names are stored once per ASN.
 */
function parse(text) {
    const lines = text.split('\n');
    const starts = new Uint32Array(lines.length);
    const ends = new Uint32Array(lines.length);
    const asns = new Uint32Array(lines.length);
    const networks = new Map(); // asn -> {name, country}
    let count = 0;
    for (const line of lines) {
        if (!line) continue;
        const [start, end, asn, country, name] = line.split('\t');
        if (!net.isIPv4(start) || !net.isIPv4(end)) continue;
        const asnNumber = Number(asn);
        starts[count] = ipToInt(start);
        ends[count] = ipToInt(end);
        asns[count] = asnNumber;
        if (asnNumber && !networks.has(asnNumber)) {
            networks.set(asnNumber, {name: (name || '').trim(), country: country === 'None' ? '' : country});
        }
        count++;
    }
    return {starts: starts.subarray(0, count), ends: ends.subarray(0, count), asns: asns.subarray(0, count), networks};
}

/**
 * autoRefresh: download/check for a newer file on start and every refreshHours (off in tests).
 */
export function createAsnDatabase({dataDir, refreshHours = 24, autoRefresh = true, log = createLogger()}) {
    const filePath = join(dataDir, FILE_NAME);
    const etagPath = filePath + '.etag';
    let table = null;
    const status = {source: SOURCE_URL, ranges: 0, networks: 0, fileModified: null, lastCheck: null, lastError: null};

    async function loadFromDisk() {
        const [buffer, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
        const parsed = parse((await gunzip(buffer)).toString('utf8'));
        const modified = (await fs.readFile(etagPath + '.modified', 'utf8').catch(() => null)) || stat.mtime.toISOString();
        // Swap everything in at once so lookups and status never see a half-loaded state
        table = parsed;
        status.ranges = parsed.starts.length;
        status.networks = parsed.networks.size;
        status.fileModified = modified;
        log.info('asn data loaded', {ranges: status.ranges, networks: status.networks, modified: status.fileModified});
    }

    async function refresh() {
        status.lastCheck = new Date().toISOString();
        try {
            const etag = await fs.readFile(etagPath, 'utf8').catch(() => null);
            const response = await fetch(SOURCE_URL, {
                headers: etag && table ? {'If-None-Match': etag} : {},
                signal: AbortSignal.timeout(120000),
            });
            if (response.status === 304) {
                log.debug('asn data unchanged');
                status.lastError = null;
                return;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            await gunzip(buffer); // make sure the download is complete before replacing the old file
            await fs.mkdir(dataDir, {recursive: true});
            await fs.writeFile(filePath + '.tmp', buffer);
            await fs.rename(filePath + '.tmp', filePath);
            if (response.headers.get('etag')) {
                await fs.writeFile(etagPath, response.headers.get('etag'));
            }
            const modified = response.headers.get('last-modified');
            if (modified) {
                await fs.writeFile(etagPath + '.modified', new Date(modified).toISOString());
            }
            await loadFromDisk();
            status.lastError = null;
        } catch (e) {
            status.lastError = e.message;
            log.warn('asn data refresh failed', {error: e.message});
        }
    }

    /** Loads the copy on disk (if any), then checks for a newer one now and every refreshHours. */
    async function start() {
        await loadFromDisk().catch(() => (autoRefresh
            ? log.info('no asn data on disk yet, downloading', {dataDir})
            : log.warn('no asn data on disk', {dataDir})));
        if (autoRefresh) {
            refresh();
            setInterval(refresh, refreshHours * 60 * 60 * 1000).unref();
        }
    }

    /** {asn, name, country} for an IPv4 address, or null when unknown or the data isn't loaded. */
    function lookup(ip) {
        if (!table || !net.isIPv4(ip)) return null;
        const value = ipToInt(ip);
        let low = 0;
        let high = table.starts.length - 1;
        while (low <= high) {
            const mid = (low + high) >>> 1;
            if (table.ends[mid] < value) low = mid + 1;
            else if (table.starts[mid] > value) high = mid - 1;
            else {
                const asn = table.asns[mid];
                return asn ? {asn, ...table.networks.get(asn)} : {asn: 0, name: 'Not routed', country: ''};
            }
        }
        return null;
    }

    /** {name, country} for an AS number. */
    function network(asn) {
        return table?.networks.get(asn) || null;
    }

    /**
     * Network details for an IPv4 address, an "a.b.c.0/24" block or an "AS123" id, as {asn, name, country}.
     * null when unknown.
     */
    function describe(id) {
        if (typeof id !== 'string') return null;
        if (/^AS\d+$/.test(id)) {
            const asn = Number(id.slice(2));
            return {asn, ...(network(asn) || {name: asn ? '' : 'Not routed', country: ''})};
        }
        return lookup(id.split('/')[0]);
    }

    return {start, lookup, network, describe, status: () => ({...status, loaded: Boolean(table)})};
}
