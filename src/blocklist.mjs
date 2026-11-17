// IPs, /24 blocks and networks (ASNs) whose requests are rejected outright, before any limits or statistics.
// Entries are stored in Postgres (see persistence.mjs); this module keeps them in memory for matching and counts hits.

import net from 'node:net';
import {pacificDay} from './limits.mjs';

export const KINDS = ['ip', 'block', 'asn'];
export const EXPIRY_DAYS = 30;

/**
 * Checks and normalizes a value for its kind. Returns the stored form or throws with a message for the user.
 *   ip:    1.2.3.4
 *   block: 1.2.3.0/24 (also accepts 1.2.3.4/24 or 1.2.3)
 *   asn:   AS12345 (also accepts 12345)
 */
export function normalizeEntry(kind, rawValue) {
    const value = String(rawValue ?? '').trim();
    if (kind === 'ip') {
        if (!net.isIPv4(value)) throw new Error('Not an IPv4 address');
        return value;
    }
    if (kind === 'block') {
        const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?(?:\/24)?$/.exec(value);
        const base = match && `${match[1]}.${match[2]}.${match[3]}.0`;
        if (!base || !net.isIPv4(base)) throw new Error('Not a /24 block, e.g. 203.0.113.0/24');
        return `${base}/24`;
    }
    if (kind === 'asn') {
        const match = /^(?:AS)?(\d{1,10})$/i.exec(value);
        if (!match || Number(match[1]) === 0 || Number(match[1]) > 4294967295) throw new Error('Not an AS number, e.g. AS64500');
        return `AS${Number(match[1])}`;
    }
    throw new Error(`Kind must be one of ${KINDS.join(', ')}`);
}

export function createBlocklist() {
    // `${kind}|${value}` -> entry {id, kind, value, note, createdAt, expiresAt, hitsTotal, hitsToday, hitsDay, lastHit, dirty}
    const entries = new Map();
    const keyOf = (kind, value) => `${kind}|${value}`;
    const expired = (entry, now) => entry.expiresAt != null && entry.expiresAt <= now;

    function put(row) {
        entries.set(keyOf(row.kind, row.value), {
            id: Number(row.id),
            kind: row.kind,
            value: row.value,
            note: row.note || '',
            createdAt: row.createdAt,
            expiresAt: row.expiresAt ?? null,
            hitsTotal: Number(row.hitsTotal) || 0,
            hitsToday: row.hitsDay === pacificDay() ? Number(row.hitsToday) || 0 : 0,
            hitsDay: pacificDay(),
            lastHit: row.lastHit ?? null,
            dirty: false,
        });
    }

    return {
        /** Replaces all entries (at startup). Rows: {id, kind, value, note, createdAt, expiresAt, hitsTotal, hitsToday, hitsDay, lastHit}. */
        load(rows) {
            entries.clear();
            for (const row of rows) put(row);
        },
        /** Adds or replaces one entry (after it has been stored). */
        add(row) {
            put(row);
        },
        remove(id) {
            for (const [key, entry] of entries) {
                if (entry.id === Number(id)) entries.delete(key);
            }
        },
        /**
         * The entry matching a request's subject ({ip, block, asn}), or null. Records the hit.
         * Expired entries never match.
         */
        match(subject, now = Date.now()) {
            for (const kind of KINDS) {
                const id = subject[kind];
                if (!id) continue;
                const entry = entries.get(keyOf(kind, id));
                if (!entry || expired(entry, now)) continue;
                const day = pacificDay(now);
                if (entry.hitsDay !== day) {
                    entry.hitsDay = day;
                    entry.hitsToday = 0;
                }
                entry.hitsTotal++;
                entry.hitsToday++;
                entry.lastHit = now;
                entry.dirty = true;
                return entry;
            }
            return null;
        },
        has(kind, value, now = Date.now()) {
            const entry = entries.get(keyOf(kind, value));
            return Boolean(entry && !expired(entry, now));
        },
        /** Current (unexpired) entries, newest first. */
        list(now = Date.now()) {
            const day = pacificDay(now);
            return [...entries.values()]
                .filter(entry => !expired(entry, now))
                .map(({dirty, hitsDay, ...entry}) => ({...entry, hitsToday: hitsDay === day ? entry.hitsToday : 0}))
                .sort((a, b) => b.createdAt - a.createdAt);
        },
        /** Hit counts that changed since the last call, for saving: {id, hitsTotal, hitsToday, hitsDay, lastHit}. */
        exportHits() {
            const rows = [];
            for (const entry of entries.values()) {
                if (!entry.dirty) continue;
                rows.push({id: entry.id, hitsTotal: entry.hitsTotal, hitsToday: entry.hitsToday, hitsDay: entry.hitsDay, lastHit: entry.lastHit});
                entry.dirty = false;
            }
            return rows;
        },
        /** Drops expired entries from memory; returns how many. */
        pruneExpired(now = Date.now()) {
            let removed = 0;
            for (const [key, entry] of entries) {
                if (expired(entry, now)) {
                    entries.delete(key);
                    removed++;
                }
            }
            return removed;
        },
        size: () => entries.size,
    };
}
