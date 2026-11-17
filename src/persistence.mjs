// Saves in-memory state to Postgres periodically and restores it at startup. Memory stays the live state: requests never
// wait on the database, and if it's unavailable the proxy keeps working and saving resumes once it's back.
//
// Daily counts only grow within a day, so saves keep the larger of the stored and new value (GREATEST). That keeps them
// correct even if an old and new container overlap briefly during a redeploy.

import pg from 'pg';
import {createLogger} from './log.mjs';
import {pacificDay} from './limits.mjs';
import {HISTORY_FIELDS} from './stats.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const toColumn = field => field.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const MINUTE_COLUMNS = HISTORY_FIELDS.map(toColumn);
const HOUR_MS = 60 * 60 * 1000;

const BLOCKLIST_COLUMNS = `id, kind, value, note, created_at, expires_at, hits_total, hits_today, hits_day::text AS hits_day, last_hit`;
const blocklistRow = row => ({
    id: Number(row.id), kind: row.kind, value: row.value, note: row.note,
    createdAt: row.created_at.getTime(), expiresAt: row.expires_at ? row.expires_at.getTime() : null,
    hitsTotal: Number(row.hits_total), hitsToday: Number(row.hits_today), hitsDay: row.hits_day,
    lastHit: row.last_hit ? row.last_hit.getTime() : null,
});

/**
 * connection: {host, port, user, password, database}. schema: where the tables live (created if missing).
 * prefix: table name prefix. limiter/distinctTracker/stats: the components whose state is saved (distinctTracker optional).
 */
export function createPersistence({
    connection, schema = 'public', prefix = 'proxy_', intervalSec = 60, retentionDays = 30,
    limiter, distinctTracker, stats, blocklist = null, log = createLogger(),
}) {
    if (!IDENTIFIER.test(schema)) throw new Error(`Invalid PG_SCHEMA "${schema}"`);
    if (!IDENTIFIER.test(prefix)) throw new Error(`Invalid table prefix "${prefix}"`);
    const table = name => `"${schema}"."${prefix}${name}"`;

    const pool = new pg.Pool({...connection, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000});
    pool.on('error', error => log.warn('postgres connection error', {error: error.message}));

    const status = {schema, ready: false, restored: null, lastSave: null, lastSaveMs: null, lastError: null};
    let timer = null;
    let lastRetention = 0;
    const emptyBatch = () => ({usage: [], distinct: [], minutes: [], events: [], counters: [], blockHits: []});
    // Changes from a failed save, retried with the next one
    let retry = emptyBatch();

    async function migrate() {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ${table('usage_daily')} (
                day date NOT NULL, scope text NOT NULL, id text NOT NULL, metric text NOT NULL, count bigint NOT NULL,
                PRIMARY KEY (day, scope, id, metric));
            CREATE TABLE IF NOT EXISTS ${table('distinct_daily')} (
                day date NOT NULL, scope text NOT NULL, id text NOT NULL,
                requests bigint NOT NULL, distinct_count bigint NOT NULL, limited boolean NOT NULL,
                PRIMARY KEY (day, scope, id));
            CREATE TABLE IF NOT EXISTS ${table('minutes')} (
                t timestamptz PRIMARY KEY, ${MINUTE_COLUMNS.map(c => `${c} bigint NOT NULL DEFAULT 0`).join(', ')});
            CREATE TABLE IF NOT EXISTS ${table('events')} (
                id bigserial PRIMARY KEY, time timestamptz NOT NULL, scope text NOT NULL, key_id text NOT NULL,
                metric text NOT NULL, time_window text NOT NULL, used text, limit_value text, dry_run boolean NOT NULL DEFAULT false);
            CREATE INDEX IF NOT EXISTS ${prefix}events_time ON ${table('events')} (time);
            CREATE TABLE IF NOT EXISTS ${table('daily_counters')} (
                day date NOT NULL, kind text NOT NULL, key text NOT NULL, value bigint NOT NULL,
                PRIMARY KEY (day, kind, key));
            CREATE TABLE IF NOT EXISTS ${table('blocklist')} (
                id bigserial PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('ip', 'block', 'asn')), value text NOT NULL,
                note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
                hits_total bigint NOT NULL DEFAULT 0, hits_today bigint NOT NULL DEFAULT 0, hits_day date, last_hit timestamptz,
                UNIQUE (kind, value));
        `);
    }

    async function load(now = Date.now()) {
        const today = pacificDay(now);
        const [usage, distinct, minutes, events, counters] = await Promise.all([
            pool.query(`SELECT day::text AS day, scope, id, metric, count FROM ${table('usage_daily')} WHERE day = $1`, [today]),
            pool.query(`SELECT day::text AS day, scope, id, requests, distinct_count AS distinct, limited
                        FROM ${table('distinct_daily')} WHERE day = $1 AND limited`, [today]),
            pool.query(`SELECT t, ${MINUTE_COLUMNS.join(', ')} FROM ${table('minutes')} WHERE t >= now() - interval '24 hours'`),
            pool.query(`SELECT time, scope, key_id AS id, metric, time_window AS window, used, limit_value AS limit, dry_run
                        FROM ${table('events')} ORDER BY time DESC LIMIT 300`),
            pool.query(`SELECT day::text AS day, kind, key, value FROM ${table('daily_counters')} WHERE day = $1`, [today]),
        ]);
        if (blocklist) {
            const {rows} = await pool.query(`SELECT ${BLOCKLIST_COLUMNS} FROM ${table('blocklist')}
                                             WHERE expires_at IS NULL OR expires_at > now()`);
            blocklist.load(rows.map(blocklistRow));
        }
        const restoredCounts = limiter.importCounts(usage.rows, now);
        const restoredLimited = distinctTracker?.importLimited(distinct.rows, now) ?? 0;
        const restoredStats = stats.importState({
            minutes: minutes.rows.map(row => ({
                t: row.t.getTime(),
                ...Object.fromEntries(HISTORY_FIELDS.map(field => [field, Number(row[toColumn(field)])])),
            })),
            events: events.rows.reverse().map(row => ({
                time: row.time.getTime(), scope: row.scope, id: row.id, metric: row.metric, window: row.window,
                used: /^\d+$/.test(row.used ?? '') ? Number(row.used) : row.used,
                limit: Number.isFinite(Number(row.limit)) ? Number(row.limit) : row.limit, dryRun: row.dry_run,
            })),
            counters: counters.rows,
        }, now);
        return {usageCounts: restoredCounts, distinctLimited: restoredLimited, ...restoredStats, blocklist: blocklist?.size() ?? 0};
    }

    // Combines retried and new rows, keeping the latest row per key (a later export always has the larger value)
    const merge = (older, newer, keyOf) => [...new Map([...older, ...newer].map(row => [keyOf(row), row])).values()];

    async function save(now = Date.now()) {
        const exported = stats.exportChanges(now);
        const batch = {
            usage: merge(retry.usage, limiter.exportChanges(now), r => `${r.day}|${r.scope}|${r.id}|${r.metric}`),
            distinct: merge(retry.distinct, distinctTracker?.exportChanges() ?? [], r => `${r.day}|${r.scope}|${r.id}`),
            minutes: merge(retry.minutes, exported.minutes, r => r.t),
            events: [...retry.events, ...exported.events],
            counters: merge(retry.counters, exported.counters, r => `${r.day}|${r.kind}|${r.key}`),
            blockHits: merge(retry.blockHits, blocklist?.exportHits() ?? [], r => r.id),
        };
        const started = Date.now();
        const client = await pool.connect().catch(error => {
            retry = batch;
            throw error;
        });
        try {
            await client.query('BEGIN');
            if (batch.usage.length) {
                await client.query(`
                    INSERT INTO ${table('usage_daily')} AS u (day, scope, id, metric, count)
                    SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::bigint[])
                    ON CONFLICT (day, scope, id, metric) DO UPDATE SET count = GREATEST(u.count, EXCLUDED.count)`,
                ['day', 'scope', 'id', 'metric', 'count'].map(k => batch.usage.map(r => r[k])));
            }
            if (batch.distinct.length) {
                await client.query(`
                    INSERT INTO ${table('distinct_daily')} AS d (day, scope, id, requests, distinct_count, limited)
                    SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::boolean[])
                    ON CONFLICT (day, scope, id) DO UPDATE SET requests = GREATEST(d.requests, EXCLUDED.requests),
                        distinct_count = GREATEST(d.distinct_count, EXCLUDED.distinct_count), limited = d.limited OR EXCLUDED.limited`,
                ['day', 'scope', 'id', 'requests', 'distinct', 'limited'].map(k => batch.distinct.map(r => r[k])));
            }
            if (batch.minutes.length) {
                await client.query(`
                    INSERT INTO ${table('minutes')} AS m (t, ${MINUTE_COLUMNS.join(', ')})
                    SELECT to_timestamp(t / 1000.0), ${MINUTE_COLUMNS.join(', ')}
                    FROM unnest($1::bigint[], ${MINUTE_COLUMNS.map((c, i) => `$${i + 2}::bigint[]`).join(', ')})
                        AS x(t, ${MINUTE_COLUMNS.join(', ')})
                    ON CONFLICT (t) DO UPDATE SET ${MINUTE_COLUMNS.map(c => `${c} = GREATEST(m.${c}, EXCLUDED.${c})`).join(', ')}`,
                        [batch.minutes.map(m => m.t), ...HISTORY_FIELDS.map(field => batch.minutes.map(m => m[field]))]);
            }
            if (batch.events.length) {
                await client.query(`
                    INSERT INTO ${table('events')} (time, scope, key_id, metric, time_window, used, limit_value, dry_run)
                    SELECT to_timestamp(t / 1000.0), scope, key_id, metric, time_window, used, limit_value, dry_run
                    FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[])
                        AS x(t, scope, key_id, metric, time_window, used, limit_value, dry_run)`,
                [
                    batch.events.map(e => e.time), batch.events.map(e => e.scope), batch.events.map(e => e.id),
                    batch.events.map(e => e.metric), batch.events.map(e => e.window), batch.events.map(e => String(e.used)),
                    batch.events.map(e => String(e.limit)), batch.events.map(e => Boolean(e.dryRun)),
                ]);
            }
            if (batch.counters.length) {
                await client.query(`
                    INSERT INTO ${table('daily_counters')} AS c (day, kind, key, value)
                    SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::bigint[])
                    ON CONFLICT (day, kind, key) DO UPDATE SET value = GREATEST(c.value, EXCLUDED.value)`,
                ['day', 'kind', 'key', 'value'].map(k => batch.counters.map(r => r[k])));
            }
            if (batch.blockHits.length) {
                // Entries removed since the hits were counted simply don't match any row
                await client.query(`
                    UPDATE ${table('blocklist')} AS b SET hits_total = GREATEST(b.hits_total, u.total),
                        hits_today = CASE WHEN b.hits_day = u.day THEN GREATEST(b.hits_today, u.today) ELSE u.today END,
                        hits_day = u.day, last_hit = GREATEST(b.last_hit, to_timestamp(u.last_ms / 1000.0))
                    FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::date[], $5::bigint[]) AS u(id, total, today, day, last_ms)
                    WHERE b.id = u.id`,
                ['id', 'hitsTotal', 'hitsToday', 'hitsDay', 'lastHit'].map(k => batch.blockHits.map(r => r[k])));
            }
            await client.query('COMMIT');
            retry = emptyBatch();
            status.lastSave = new Date(now).toISOString();
            status.lastSaveMs = Date.now() - started;
            status.lastError = null;
            if (now - lastRetention > HOUR_MS) {
                lastRetention = now;
                await deleteOld();
            }
            return {usage: batch.usage.length, distinct: batch.distinct.length, minutes: batch.minutes.length,
                events: batch.events.length, counters: batch.counters.length, blockHits: batch.blockHits.length};
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            retry = batch;
            throw error;
        } finally {
            client.release();
        }
    }

    async function deleteOld() {
        const days = Math.floor(retentionDays);
        const result = await pool.query(`
            WITH a AS (DELETE FROM ${table('usage_daily')} WHERE day < current_date - $1::int RETURNING 1),
                 b AS (DELETE FROM ${table('distinct_daily')} WHERE day < current_date - $1::int RETURNING 1),
                 c AS (DELETE FROM ${table('daily_counters')} WHERE day < current_date - $1::int RETURNING 1),
                 d AS (DELETE FROM ${table('minutes')} WHERE t < now() - make_interval(days => $1::int) RETURNING 1),
                 e AS (DELETE FROM ${table('events')} WHERE time < now() - make_interval(days => $1::int) RETURNING 1)
            SELECT (SELECT count(*) FROM a) + (SELECT count(*) FROM b) + (SELECT count(*) FROM c)
                 + (SELECT count(*) FROM d) + (SELECT count(*) FROM e) AS deleted`, [days]);
        const deleted = Number(result.rows[0].deleted);
        if (deleted) log.info('postgres old rows deleted', {rows: deleted, retentionDays: days});
        if (blocklist) {
            const expired = await pool.query(`DELETE FROM ${table('blocklist')} WHERE expires_at <= now() RETURNING kind, value`);
            blocklist.pruneExpired();
            for (const row of expired.rows) log.info('blocklist entry expired', {kind: row.kind, value: row.value});
        }
    }

    /** Creates the tables and restores state. Never throws: on failure the proxy starts with empty state. */
    async function connectAndLoad() {
        try {
            await migrate();
            status.restored = await load();
            status.ready = true;
            status.lastError = null;
            log.info('postgres state restored', {schema, ...status.restored});
            return true;
        } catch (error) {
            status.lastError = error.message;
            log.warn('postgres unavailable, continuing without restored state', {schema, error: error.message});
            return false;
        }
    }

    async function tick() {
        // If the database wasn't reachable at startup, restore (merging with what's been counted since) once it is
        if (!status.ready && !(await connectAndLoad())) return;
        try {
            await save();
        } catch (error) {
            status.lastError = error.message;
            log.warn('postgres save failed, will retry', {error: error.message});
            // Tables gone (dropped, or the database restored from a backup): recreate them and restore on the next tick
            if (error.code === '42P01') status.ready = false;
        }
    }

    return {
        /** Restores state, then saves every intervalSec seconds. */
        async start() {
            await connectAndLoad();
            timer = setInterval(tick, intervalSec * 1000);
            timer.unref();
        },
        /** Final save (for shutdown), then closes the connections. */
        async stop() {
            clearInterval(timer);
            if (status.ready) {
                try {
                    const saved = await save();
                    log.info('postgres state saved', saved);
                } catch (error) {
                    log.warn('postgres final save failed', {error: error.message});
                }
            }
            await pool.end().catch(() => {});
        },
        save,
        /** One scheduled run: (re)connect and restore if needed, then save. Exposed for tests. */
        tick,
        /**
         * Totals per interval for the last `days` days, in buckets of `bucketMinutes`, oldest first with gaps filled.
         * Saved data lags by up to one save interval, so the in-memory history is better for the last 24 hours.
         */
        async history(days = 7, bucketMinutes = 10, now = Date.now()) {
            const bucketMs = bucketMinutes * 60 * 1000;
            const result = await pool.query(`
                SELECT extract(epoch FROM date_bin(make_interval(mins => $2::int), t, TIMESTAMPTZ '2000-01-01')) * 1000 AS t,
                       ${MINUTE_COLUMNS.map(c => `sum(${c}) AS ${c}`).join(', ')}
                FROM ${table('minutes')} WHERE t >= now() - make_interval(days => $1::int)
                GROUP BY 1 ORDER BY 1`, [days, bucketMinutes]);
            const byTime = new Map(result.rows.map(row => [Number(row.t), row]));
            const end = now - now % bucketMs;
            const series = [];
            for (let t = end - (days * 24 * 60 / bucketMinutes - 1) * bucketMs; t <= end; t += bucketMs) {
                const row = byTime.get(t);
                series.push({t, ...Object.fromEntries(HISTORY_FIELDS.map(f => [f, row ? Number(row[toColumn(f)]) : 0]))});
            }
            return {bucketMinutes, days, history: series};
        },
        status: () => ({...status}),
        /**
         * Stores a blocklist entry (or updates the note and expiry of an existing one) and applies it immediately.
         * expiresAt: epoch ms or null for permanent. Returns the stored entry.
         */
        async addBlock({kind, value, note = '', expiresAt = null}) {
            if (!blocklist) throw new Error('Blocklist not enabled');
            const {rows} = await pool.query(`
                INSERT INTO ${table('blocklist')} (kind, value, note, expires_at)
                VALUES ($1, $2, $3, CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4::bigint / 1000.0) END)
                ON CONFLICT (kind, value) DO UPDATE SET note = EXCLUDED.note, expires_at = EXCLUDED.expires_at
                RETURNING ${BLOCKLIST_COLUMNS}`, [kind, value, note, expiresAt]);
            const entry = blocklistRow(rows[0]);
            blocklist.add(entry);
            return entry;
        },
        /** Removes a blocklist entry; returns its {kind, value}, or null if there was no such entry. */
        async removeBlock(id) {
            if (!blocklist) throw new Error('Blocklist not enabled');
            const {rows} = await pool.query(`DELETE FROM ${table('blocklist')} WHERE id = $1 RETURNING kind, value`, [id]);
            blocklist.remove(id);
            return rows[0] ?? null;
        },
    };
}
