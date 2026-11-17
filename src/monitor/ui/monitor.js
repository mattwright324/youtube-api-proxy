'use strict';

(() => {
    const REFRESH_MS = 10000;
    const TOP_N = 100;

    const nf = new Intl.NumberFormat();
    const cf = new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1});
    const pf = new Intl.NumberFormat(undefined, {style: 'percent', maximumFractionDigits: 1});
    const fmt = v => (v == null ? '—' : nf.format(v));
    const ms = v => (v == null ? '—' : `${nf.format(v)} ms`);
    const time = t => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const dayLabel = t => new Date(t).toLocaleDateString([], {month: 'short', day: 'numeric'});
    const dateTime = t => new Date(t).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const MINUTE_MS = 60 * 1000;
    const HISTORY_MINUTES = 24 * 60;
    const METRIC_LABELS = {
        requests: 'Requests',
        units: 'Quota units',
        search: 'Search calls',
        blocked: 'Limited requests',
        served: 'Served requests',
        scripted: 'Likely scripts'
    };
    const SIGNAL_LABELS = {
        'non-browser-ua': ['Non-browser user agent', 'User-Agent missing, or an HTTP library, headless browser or crawler'],
        'no-origin': ['No Origin header', 'Browsers send Origin on cross-origin fetch requests'],
        'unlisted-origin': ['Origin not whitelisted', 'Origin header not in CORS_WHITELIST'],
        'no-sec-fetch': ['No Sec-Fetch headers', 'Sent automatically by current browsers, page scripts cannot set them'],
        'missing-params': ['Missing expected parameters', '/v3 request without one of SCRIPT_EXPECTED_PARAMS'],
    };
    const KIND_LABELS = {ip: 'IP', block: '/24 block', asn: 'Network'};
    // For use inside a sentence ("Add this IP to the blocklist")
    const KIND_NOUNS = {ip: 'IP', block: '/24 block', asn: 'network'};
    const REASON_LABELS = {
        requests: 'Request rate',
        units: 'Quota units',
        search: 'Search calls',
        distinct: 'Distinct values'
    };
    const SERIES = [
        {key: 'requests', label: 'Requests'},
        {key: 'blocked', label: 'Limited requests'},
        {key: 'scripted', label: 'Likely scripts'},
        {key: 'cacheHits', label: 'Cache hits'},
        {key: 'upstream', label: 'Upstream calls'},
        {key: 'units', label: 'Quota units'},
        {key: 'search', label: 'Search calls'},
    ];
    // Shown in the tooltip and table but not charted: served is requests minus limited
    const EXTRA_FIELDS = [
        {key: 'served', label: 'Served requests'},
        {key: 'errors', label: 'Upstream errors'},
        {key: 'denied', label: 'Blocklisted (not in other counts)'},
    ];

    const $ = id => document.getElementById(id);
    // Built from origin + path so credentials in the page URL (user:pass@host) aren't carried into fetch, which rejects them
    const apiUrl = path => new URL(path, location.origin + location.pathname);
    let data = null;
    let timer = null;
    const tableState = {};

    // -----------------------------------------------------------------------
    // DOM helpers. Strings are always appended as text nodes, never parsed as HTML.
    // -----------------------------------------------------------------------

    function h(tag, props, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value == null || value === false) continue;
            if (key === 'class') node.className = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) {
            if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
        }
        return node;
    }

    function svg(tag, attrs) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
        return node;
    }

    function statusBadge(ratio) {
        if (ratio == null) return '—';
        if (ratio >= 1) return h('span', {class: 'badge status-critical'}, '✖ ', pf.format(ratio));
        if (ratio >= 0.8) return h('span', {class: 'badge status-warning'}, '⚠ ', pf.format(ratio));
        return pf.format(ratio);
    }

    // Network (ASN) details attached by the server to each row; null when ASN lookups are off or unknown
    function networkText(network) {
        if (!network) return '';
        return `AS${network.asn} ${network.name || ''}${network.country ? ` (${network.country})` : ''}`;
    }

    function networkCell(network, {showAsn = true} = {}) {
        if (network === undefined || !data.asn) return h('span', {class: 'text-secondary'}, '—');
        if (!network) return h('span', {class: 'text-secondary'}, 'Unknown');
        return h('span', {class: 'network', title: networkText(network)},
            showAsn ? h('code', {class: 'me-2'}, `AS${network.asn}`) : null,
            network.name || '',
            network.country ? h('span', {class: 'text-secondary'}, ` ${network.country}`) : null);
    }

    const networkColumn = (options) => ({
        key: 'network', label: 'Network', class: 'network-col',
        sortValue: row => networkText(row.network), render: row => networkCell(row.network, options),
    });

    const matches = (row, filter) => !filter || `${row.id} ${networkText(row.network)}`.toLowerCase().includes(filter.toLowerCase());

    /**
     * Sortable table. columns: {key, label, num?, format?(value,row), render?(row), sortValue?(row), sortable?}
     */
    function renderTable(container, id, columns, rows, {
        defaultSort = {},
        emptyText = 'Nothing recorded yet.',
        rowClass
    } = {}) {
        const state = (tableState[id] ??= {...defaultSort});
        let sorted = rows;
        if (state.key) {
            const column = columns.find(c => c.key === state.key);
            const get = column.sortValue || (row => row[column.key]);
            sorted = [...rows].sort((a, b) => {
                const va = get(a);
                const vb = get(b);
                const cmp = typeof va === 'number' && typeof vb === 'number'
                    ? va - vb
                    : String(va ?? '').localeCompare(String(vb ?? ''), undefined, {numeric: true});
                return state.dir === 'asc' ? cmp : -cmp;
            });
        }

        const head = h('tr', {}, columns.map(column => {
            const active = state.key === column.key;
            const sortable = column.sortable !== false;
            const th = h('th', {
                scope: 'col',
                class: [column.num && 'num', sortable && 'sortable'].filter(Boolean).join(' '),
                'aria-sort': active ? (state.dir === 'asc' ? 'ascending' : 'descending') : null,
                'aria-label': column.ariaLabel || null,
            }, column.label, active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '');
            if (sortable) {
                th.addEventListener('click', () => {
                    if (state.key === column.key) {
                        state.dir = state.dir === 'asc' ? 'desc' : 'asc';
                    } else {
                        state.key = column.key;
                        state.dir = column.num ? 'desc' : 'asc';
                    }
                    renderTable(container, id, columns, rows, {defaultSort, emptyText, rowClass});
                });
            }
            return th;
        }));

        const body = sorted.length
            ? sorted.map(row => h('tr', {class: rowClass?.(row)}, columns.map(column => h('td', {class: [column.num && 'num', column.class].filter(Boolean).join(' ')},
                column.render ? column.render(row) : column.format ? column.format(row[column.key], row) : (row[column.key] ?? '')))))
            : h('tr', {}, h('td', {colspan: columns.length, class: 'text-secondary'}, emptyText));

        // Keep the scroll position across refreshes
        const scrollTop = container.querySelector('.table-wrap')?.scrollTop || 0;
        container.replaceChildren(h('div', {class: 'table-wrap'},
            h('table', {class: 'table table-sm table-hover align-middle mb-0'}, h('thead', {}, head), h('tbody', {}, body))));
        container.querySelector('.table-wrap').scrollTop = scrollTop;
    }

    function tile(label, value, sub, col = 'col-6 col-md-4 col-xl') {
        return h('div', {class: col}, h('div', {class: 'card h-100 tile'}, h('div', {class: 'card-body py-2'},
            h('div', {class: 'label'}, label),
            h('div', {class: 'value'}, value),
            sub ? h('div', {class: 'sub'}, sub) : null)));
    }

    // -----------------------------------------------------------------------
    // Header, tiles and meters
    // -----------------------------------------------------------------------

    function uptime(startedAt, now) {
        const minutes = Math.floor((now - startedAt) / 60000);
        const days = Math.floor(minutes / 1440);
        const hours = Math.floor(minutes % 1440 / 60);
        return days ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`;
    }

    function renderHeader() {
        $('badges').replaceChildren(...[
            data.dryRun ? h('span', {
                class: 'badge status-warning',
                title: 'Limits only log, nothing is limited'
            }, '⚠ Dry run') : null,
            h('span', {class: 'badge text-bg-secondary'}, `Up ${uptime(data.startedAt, data.now)}`),
            h('span', {
                class: 'badge text-bg-secondary',
                title: 'Limiter keys in memory'
            }, `${nf.format(data.limiter.tracked)} keys`),
            h('span', {
                class: 'badge text-bg-secondary',
                title: 'Pacific date used for daily limits'
            }, data.limiter.day),
            asnBadge(),
            persistenceBadge(),
        ].filter(Boolean));
        $('rangeButtons').classList.toggle('d-none', !data.persistence);
    }

    function persistenceBadge() {
        const p = data.persistence;
        if (!p) return null;
        const title = [`Postgres schema: ${p.schema}`, p.lastSave && `Last save ${new Date(p.lastSave).toLocaleString()} (${p.lastSaveMs} ms)`,
            p.lastError && `Last error: ${p.lastError}`].filter(Boolean).join('\n');
        if (!p.ready || p.lastError) return h('span', {class: 'badge status-warning', title}, '⚠ Postgres unavailable');
        const ago = p.lastSave ? Math.max(0, Math.round((data.now - Date.parse(p.lastSave)) / 1000)) : null;
        return h('span', {class: 'badge text-bg-secondary', title}, ago == null ? 'Restored from Postgres' : `Saved ${ago}s ago`);
    }

    function asnBadge() {
        const asn = data.asn;
        if (!asn) return null;
        const title = [
            `Source: ${asn.source}`,
            asn.loaded ? `${nf.format(asn.ranges)} ranges, ${nf.format(asn.networks)} networks` : 'Not loaded yet',
            asn.fileModified && `Data from ${new Date(asn.fileModified).toLocaleString()}`,
            asn.lastCheck && `Last checked ${new Date(asn.lastCheck).toLocaleString()}`,
            asn.lastError && `Last error: ${asn.lastError}`,
        ].filter(Boolean).join('\n');
        if (!asn.loaded) return h('span', {class: 'badge status-warning', title}, '⚠ ASN data loading');
        if (asn.lastError) return h('span', {class: 'badge status-warning', title}, '⚠ ASN refresh failed');
        return h('span', {
            class: 'badge text-bg-secondary',
            title
        }, `ASN data ${new Date(asn.fileModified).toLocaleDateString()}`);
    }

    function renderTiles() {
        const g = data.limiter.global;
        const limits = data.limits.global || {};
        const served = g.served?.day ?? 0;
        const blocked = g.blocked?.day ?? 0;
        const total = served + blocked;
        const scripted = g.scripted?.day ?? 0;
        const cache = data.cache;
        const hitRate = cache.hits + cache.misses ? cache.hits / (cache.hits + cache.misses) : null;

        $('tiles').replaceChildren(
            tile('Requests today', cf.format(total), `${fmt(served)} served, ${fmt(blocked)} limited`),
            tile('Quota units today', cf.format(g.units?.day ?? 0), limits.units?.day ? `of ${cf.format(limits.units.day)} limit` : 'no daily limit'),
            tile('Search calls today', cf.format(g.search?.day ?? 0), limits.search?.day ? `of ${cf.format(limits.search.day)} limit` : 'no daily limit'),
            tile('Limited today', cf.format(blocked), `${total ? pf.format(blocked / total) : '0%'} of requests`),
            tile('Cache hit rate', hitRate == null ? '—' : pf.format(hitRate), `${fmt(cache.keys)} cached entries`),
            tile('Likely scripts today', cf.format(scripted), `${total ? pf.format(scripted / total) : '0%'} of requests`),
            data.blocklist ? tile('Blocklisted today', cf.format(data.deniedCount || 0), `${fmt(data.blocklist.length)} blocklist ${data.blocklist.length === 1 ? 'entry' : 'entries'}`) : null,
        );
    }

    function renderMeters() {
        const rows = [];
        for (const metric of ['units', 'search', 'requests']) {
            for (const window of ['minute', 'day']) {
                const limit = data.limits.global?.[metric]?.[window];
                if (!limit) continue;
                const used = data.limiter.global[metric]?.[window] ?? 0;
                const ratio = used / limit;
                const severity = ratio >= 1 ? 'critical' : ratio >= 0.8 ? 'warning' : '';
                rows.push(h('div', {class: 'meter'},
                    h('div', {class: 'meter-head'},
                        h('span', {}, `${METRIC_LABELS[metric]} per ${window}`),
                        h('span', {class: 'meter-figure'}, `${fmt(used)} / ${fmt(limit)}`)),
                    h('div', {
                        class: 'meter-track',
                        role: 'meter',
                        'aria-valuemin': 0,
                        'aria-valuemax': limit,
                        'aria-valuenow': used,
                        'aria-label': `${METRIC_LABELS[metric]} per ${window}`,
                    }, h('div', {class: `meter-fill ${severity}`, style: `width: ${Math.min(100, ratio * 100)}%`})),
                    h('div', {class: 'meter-status'},
                        severity === 'critical' ? '✖ At limit, ' : severity === 'warning' ? '⚠ Near limit, ' : '',
                        `${ratio > 0 && ratio < 0.001 ? '<0.1%' : pf.format(ratio)} used`)));
            }
        }
        $('meters').replaceChildren(...(rows.length ? rows : [h('p', {class: 'text-secondary small'}, 'No global limits configured.')]));
    }

    // -----------------------------------------------------------------------
    // Small multiples with a synced crosshair
    // -----------------------------------------------------------------------

    const charts = [];
    let hoverIndex = null;

    function niceMax(value) {
        const power = 10 ** Math.floor(Math.log10(value));
        const m = value / power;
        return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power;
    }

    function buildCharts() {
        const container = $('charts');
        for (const series of SERIES) {
            const now = h('span', {class: 'chart-now'});
            const plot = svg('svg', {
                role: 'img',
                tabindex: '0',
                'aria-label': `${series.label} per minute, last 24 hours. Use arrow keys to inspect.`
            });
            container.append(h('div', {class: 'chart'},
                h('div', {class: 'chart-head'}, h('span', {}, series.label), now),
                plot));
            const chart = {series, plot, now, geometry: null};
            plot.addEventListener('pointermove', event => setHover(indexAt(chart, event.clientX), chart, event));
            plot.addEventListener('pointerleave', () => setHover(null));
            plot.addEventListener('blur', () => setHover(null));
            plot.addEventListener('keydown', event => {
                const last = chartSource().history.length - 1;
                if (event.key === 'ArrowLeft') hoverIndex = Math.max(0, (hoverIndex ?? last) - 1);
                else if (event.key === 'ArrowRight') hoverIndex = Math.min(last, (hoverIndex ?? last - 1) + 1);
                else if (event.key === 'Escape') hoverIndex = null;
                else return;
                event.preventDefault();
                setHover(hoverIndex, chart);
            });
            charts.push(chart);
        }
    }

    // Charts show either the in-memory per-minute history (24 hours) or saved 10-minute intervals from Postgres (7 days)
    let range = '24h';
    let requestedRange = new URLSearchParams(location.search).get('range');
    let longHistory = null;

    function chartSource() {
        if (range === '7d' && longHistory) {
            return {history: longHistory.history, bucketMs: longHistory.bucketMinutes * MINUTE_MS, unit: `${longHistory.bucketMinutes} minutes`, long: true};
        }
        return {history: data.history, bucketMs: MINUTE_MS, unit: 'minute', long: false};
    }

    async function loadLongHistory() {
        const response = await fetch(apiUrl('api/history'), {cache: 'no-store'});
        if (!response.ok) throw new Error(`history HTTP ${response.status}`);
        longHistory = await response.json();
    }

    async function setRange(next) {
        range = next;
        for (const button of document.querySelectorAll('[data-range]')) {
            button.classList.toggle('active', button.dataset.range === range);
            button.setAttribute('aria-pressed', String(button.dataset.range === range));
        }
        $('chartTitle').textContent = range === '7d' ? 'Last 7 days, per 10 minutes' : 'Last 24 hours, per minute';
        if (range === '7d') {
            try {
                await loadLongHistory();
            } catch (e) {
                $('error').textContent = `Could not load 7 day history: ${e.message}`;
                $('error').classList.remove('d-none');
                return setRange('24h');
            }
        }
        if (data) renderCharts();
    }

    function indexAt(chart, clientX) {
        const g = chart.geometry;
        if (!g) return null;
        const rect = chart.plot.getBoundingClientRect();
        const t = g.t0 + ((clientX - rect.left - g.left) / g.plotW) * g.span;
        return Math.max(0, Math.min(g.n - 1, Math.round((t - g.firstT) / g.bucketMs)));
    }

    function drawChart(chart) {
        const source = chartSource();
        const history = source.history;
        const values = history.map(b => b[chart.series.key]);
        const n = values.length;
        const width = chart.plot.clientWidth || 300;
        const height = 140;
        const left = 2;
        const right = 6;
        const top = 14;
        const bottom = 20;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const max = niceMax(Math.max(1, ...values));
        // Fixed window ending at the current interval; time with no data (e.g. before the last restart) stays empty
        const lastT = history[n - 1].t;
        const span = ((source.long ? n : HISTORY_MINUTES) - 1) * source.bucketMs;
        const t0 = lastT - span;
        const firstT = history[0].t;
        const x = i => left + ((history[i].t - t0) / span) * plotW;
        const y = v => top + plotH - (v / max) * plotH;

        chart.geometry = {n, left, plotW, t0, span, firstT, top, plotH, x, y, values};
        const plot = chart.plot;
        plot.setAttribute('viewBox', `0 0 ${width} ${height}`);
        plot.replaceChildren();

        // Recessive grid: top and middle hairlines, solid baseline
        plot.append(svg('line', {class: 'grid', x1: left, x2: width - right, y1: top, y2: top}));
        plot.append(svg('line', {
            class: 'grid',
            x1: left,
            x2: width - right,
            y1: top + plotH / 2,
            y2: top + plotH / 2
        }));
        plot.append(svg('line', {class: 'baseline', x1: left, x2: width - right, y1: top + plotH, y2: top + plotH}));
        const maxLabel = svg('text', {class: 'tick', x: left, y: top - 4});
        maxLabel.textContent = nf.format(max);
        plot.append(maxLabel);

        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            const label = svg('text', {
                class: 'tick', x: left + fraction * plotW, y: height - 4,
                'text-anchor': fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle',
            });
            label.textContent = fraction === 1 ? 'now' : source.long ? dayLabel(t0 + fraction * span) : time(t0 + fraction * span);
            plot.append(label);
        }

        if (n > 1) {
            const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L');
            plot.append(svg('path', {
                class: 'area',
                d: `M${x(0).toFixed(1)},${y(0)} L${points} L${x(n - 1).toFixed(1)},${y(0)} Z`
            }));
            plot.append(svg('path', {class: 'line', d: `M${points}`}));
        }

        // End dot on the last full minute; the current minute is still filling
        if (n >= 2) {
            plot.append(svg('circle', {class: 'dot', cx: x(n - 2), cy: y(values[n - 2]), r: 4}));
            chart.now.textContent = `${nf.format(values[n - 2])} last full ${source.unit}`;
        } else {
            plot.append(svg('circle', {class: 'dot', cx: x(0), cy: y(values[0]), r: 4}));
            chart.now.textContent = `${nf.format(values[0])} so far, first ${source.unit}`;
        }

        chart.crosshair = svg('line', {class: 'crosshair', y1: top, y2: top + plotH, visibility: 'hidden'});
        chart.hoverDot = svg('circle', {class: 'dot', r: 4, visibility: 'hidden'});
        plot.append(chart.crosshair, chart.hoverDot);
    }

    function setHover(index, source, event) {
        hoverIndex = index;
        const tooltip = $('tooltip');
        for (const chart of charts) {
            const g = chart.geometry;
            const visible = index != null && g;
            chart.crosshair?.setAttribute('visibility', visible ? 'visible' : 'hidden');
            chart.hoverDot?.setAttribute('visibility', visible ? 'visible' : 'hidden');
            if (visible) {
                const cx = g.x(index);
                chart.crosshair.setAttribute('x1', cx);
                chart.crosshair.setAttribute('x2', cx);
                chart.hoverDot.setAttribute('cx', cx);
                chart.hoverDot.setAttribute('cy', g.y(g.values[index]));
            }
        }
        if (index == null || !data) {
            tooltip.hidden = true;
            return;
        }

        const shown = chartSource().history;
        const bucket = shown[index];
        tooltip.replaceChildren(
            h('div', {class: 'tt-time'}, dateTime(bucket.t), index === shown.length - 1 ? ' (in progress)' : ''),
            ...SERIES.map(series => h('div', {class: `tt-row ${source?.series === series ? 'active' : ''}`},
                h('span', {class: 'tt-key'}),
                h('span', {class: 'tt-value'}, nf.format(bucket[series.key])),
                h('span', {class: 'tt-label'}, series.label))),
            ...EXTRA_FIELDS.map(field => h('div', {class: 'tt-row'}, h('span', {
                    class: 'tt-key',
                    style: 'background: transparent'
                }),
                h('span', {class: 'tt-value'}, nf.format(bucket[field.key])), h('span', {class: 'tt-label'}, field.label))),
        );
        tooltip.hidden = false;

        let px;
        let py;
        if (event) {
            px = event.clientX;
            py = event.clientY;
        } else {
            const rect = source.plot.getBoundingClientRect();
            px = rect.left + source.geometry.x(index);
            py = rect.top + 20;
        }
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const leftPos = px + 14 + tw > window.innerWidth ? px - tw - 14 : px + 14;
        tooltip.style.left = `${Math.max(4, leftPos)}px`;
        tooltip.style.top = `${Math.max(4, Math.min(window.innerHeight - th - 4, py - th / 2))}px`;
    }

    function renderCharts() {
        charts.forEach(drawChart);
        if (hoverIndex != null) setHover(null);
        if ($('historyTableWrap').classList.contains('show')) renderHistoryTable();
    }

    function renderHistoryTable() {
        const source = chartSource();
        const rows = [...source.history].reverse();
        renderTable($('historyTable'), 'history', [
            {key: 't', label: source.long ? 'Interval start' : 'Minute', format: v => dateTime(v)},
            ...SERIES.map(s => ({key: s.key, label: s.label, num: true, format: fmt})),
            ...EXTRA_FIELDS.map(f => ({key: f.key, label: f.label, num: true, format: fmt})),
        ], rows, {defaultSort: {key: 't', dir: 'desc'}});
    }

    // -----------------------------------------------------------------------
    // Tabs
    // -----------------------------------------------------------------------

    function renderConsumers() {
        const scope = $('consumerScope').value;
        const metric = $('consumerMetric').value;
        const filter = $('consumerFilter').value.trim();
        const limit = data.limits[scope]?.[metric] || {};
        const rows = (data.limiter.top[scope]?.[metric] || [])
            .filter(row => matches(row, filter))
            .map(row => ({
                ...row,
                minutePct: limit.minute ? row.minute / limit.minute : null,
                dayPct: limit.day ? row.day / limit.day : null,
            }));
        const limitText = [limit.minute && `${fmt(limit.minute)}/min`, limit.day && `${fmt(limit.day)}/day`].filter(Boolean).join(', ');
        const top = `Top ${TOP_N} by today plus top ${TOP_N} by the last minute.`;
        $('consumerInfo').textContent = scope === 'asn'
            ? (data.asn ? `Tracked for reporting only, no limits apply. ${top}` : 'ASN lookups are disabled (ASN_LOOKUP=false).')
            : `Limits: ${limitText || 'none'}. ${top}`;

        const columns = scope === 'asn'
            ? [
                blockColumn(() => 'asn'),
                {key: 'id', label: 'ASN', render: row => h('code', {}, row.id)},
                networkColumn({showAsn: false}),
                {key: 'minute', label: 'Last minute', num: true, format: fmt},
                {key: 'day', label: 'Today', num: true, format: fmt},
                {key: 'servedDay', label: 'Served today', num: true, format: fmt},
                {key: 'blockedDay', label: 'Limited today', num: true, format: fmt},
                {key: 'scriptedDay', label: 'Script-like today', num: true, format: fmt},
            ]
            : [
                blockColumn(() => scope),
                {key: 'id', label: scope === 'ip' ? 'IP' : '/24 block', render: row => h('code', {}, row.id)},
                networkColumn(),
                {key: 'minute', label: 'Last minute', num: true, format: fmt},
                {
                    key: 'minutePct',
                    label: 'Of minute limit',
                    num: true,
                    render: row => statusBadge(row.minutePct),
                    sortValue: row => row.minutePct ?? -1
                },
                {key: 'day', label: 'Today', num: true, format: fmt},
                {
                    key: 'dayPct',
                    label: 'Of daily limit',
                    num: true,
                    render: row => statusBadge(row.dayPct),
                    sortValue: row => row.dayPct ?? -1
                },
                {key: 'servedDay', label: 'Served today', num: true, format: fmt},
                {key: 'blockedDay', label: 'Limited today', num: true, format: fmt},
                {key: 'scriptedDay', label: 'Script-like today', num: true, format: fmt},
            ].filter(column => (column.key !== 'minutePct' || limit.minute) && (column.key !== 'dayPct' || limit.day));
        renderTable($('consumerTable'), `consumers-${scope}-${metric}`, columns, rows, {
            defaultSort: {
                key: 'day',
                dir: 'desc'
            }
        });
    }

    function renderDistinct() {
        const info = $('distinctInfo');
        $('distinctControls').classList.toggle('d-none', !data.distinct);
        if (!data.distinct) {
            info.textContent = '';
            $('distinctTable').replaceChildren(h('p', {class: 'text-secondary mb-0'},
                'Not enabled. Set LIMIT_DISTINCT_PARAM to track distinct parameter values per IP and block.'));
            return;
        }
        const {param, minRequests, maxRatio, top} = data.distinct;
        info.textContent = `Parameter "${param}", limited at ${fmt(minRequests)}+ requests with a distinct ratio of ${pf.format(maxRatio)} or more.`;

        const scope = $('distinctScope').value;
        const filter = $('distinctFilter').value.trim();
        const rows = (top[scope] || [])
            .filter(row => matches(row, filter))
            .map(row => ({...row, ratio: row.requests ? row.distinct / row.requests : 0}));

        renderTable($('distinctTable'), `distinct-${scope}`, [
            blockColumn(() => scope),
            {key: 'id', label: scope === 'ip' ? 'IP' : '/24 block', render: row => h('code', {}, row.id)},
            networkColumn(),
            {key: 'distinct', label: 'Distinct values', num: true, format: fmt},
            {key: 'requests', label: 'Requests', num: true, format: fmt},
            {key: 'ratio', label: 'Ratio', num: true, format: v => pf.format(v)},
            {
                key: 'limited',
                label: 'Status',
                sortValue: row => (row.limited ? 2 : row.requests >= minRequests * 0.5 && row.ratio >= maxRatio * 0.8 ? 1 : 0),
                render: row => row.limited
                    ? h('span', {class: 'badge status-critical'}, '✖ Limited')
                    : row.requests >= minRequests * 0.5 && row.ratio >= maxRatio * 0.8
                        ? h('span', {class: 'badge status-warning'}, '⚠ Approaching')
                        : '',
            },
        ], rows, {defaultSort: {key: 'distinct', dir: 'desc'}});
    }

    function renderEvents() {
        const filter = $('eventFilter').value.trim().toLowerCase();
        const rows = data.events.filter(e => !filter || `${e.scope} ${e.id} ${e.metric} ${e.window} ${networkText(e.network)}`.toLowerCase().includes(filter));
        $('eventCount').textContent = data.events.length ? String(data.events.length) : '';
        const reasons = Object.entries(data.blockedReasons || {}).sort((a, b) => b[1] - a[1]);
        $('blockedReasons').textContent = reasons.length
            ? `Limited requests today by limit: ${reasons.map(([reason, count]) => `${REASON_LABELS[reason] || reason} ${fmt(count)}`).join(', ')}`
            : 'No requests limited today.';
        renderTable($('eventTable'), 'events', [
            blockColumn(row => (row.scope === 'ip' || row.scope === 'block' ? row.scope : null)),
            {key: 'time', label: 'Time', class: 'nowrap', format: v => dateTime(v)},
            {key: 'scope', label: 'Scope'},
            {key: 'id', label: 'IP or /24 block', render: row => h('code', {}, row.id)},
            networkColumn(),
            {
                key: 'metric',
                label: 'Metric',
                format: v => METRIC_LABELS[v] || (v === 'distinct' ? 'Distinct values' : v)
            },
            {key: 'window', label: 'Window'},
            {key: 'used', label: 'Used', num: true, format: v => (typeof v === 'number' ? fmt(v) : v)},
            {key: 'limit', label: 'Limit', num: true, format: v => (v < 1 ? pf.format(v) : fmt(v))},
            {
                key: 'dryRun',
                label: 'Mode',
                render: row => (row.dryRun ? h('span', {class: 'badge text-bg-secondary'}, 'Dry run') : 'Enforced')
            },
        ], rows, {defaultSort: {key: 'time', dir: 'desc'}, emptyText: 'No limits exceeded recently.'});
    }

    // -----------------------------------------------------------------------
    // Blocklist
    // -----------------------------------------------------------------------

    const isBlocked = (kind, value) => Boolean(data.blocklist?.some(entry => entry.kind === kind && entry.value === value));

    /** First table column: a Block button (adds to the blocklist), or a Blocklisted badge. kindOf(row) gives 'ip', 'block', 'asn' or null. */
    function blockColumn(kindOf) {
        return {
            key: 'blockAction', label: '', ariaLabel: 'Blocklist', sortable: false,
            render: row => {
                const kind = kindOf(row);
                if (!data.blocklist || !kind || row.id === 'unknown') return '';
                if (isBlocked(kind, row.id)) return h('span', {class: 'badge status-critical', title: 'On the blocklist: all requests are rejected'}, '✖ Blocklisted');
                return h('button', {
                    class: 'btn btn-sm btn-outline-danger py-0', type: 'button', title: `Add this ${KIND_NOUNS[kind]} to the blocklist`,
                    onclick: () => openBlockModal(kind, row.id, row.network),
                }, 'Block');
            },
        };
    }

    /** Sends a blocklist change. The custom header marks it as coming from this page (checked by the server). */
    async function blocklistRequest(method, path, body) {
        const response = await fetch(apiUrl(path), {
            method,
            headers: {'Content-Type': 'application/json', 'X-Monitor-Request': '1'},
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(json.message || `HTTP ${response.status}`);
        return json;
    }

    let pendingBlock = null;
    function openBlockModal(kind, value, network) {
        pendingBlock = {kind, value};
        $('blockModalTitle').textContent = `Add this ${KIND_NOUNS[kind]} to the blocklist`;
        $('blockModalValue').textContent = value;
        $('blockModalNetwork').textContent = network ? networkText(network) : '';
        $('blockModalNote').value = '';
        $('blockModalExpiry').value = '30d';
        $('blockModalError').textContent = '';
        bootstrap.Modal.getOrCreateInstance($('blockModal')).show();
    }

    async function submitBlock(event) {
        event.preventDefault();
        if (!pendingBlock) return;
        try {
            await blocklistRequest('POST', 'api/blocklist', {
                ...pendingBlock, note: $('blockModalNote').value, expiry: $('blockModalExpiry').value,
            });
            bootstrap.Modal.getOrCreateInstance($('blockModal')).hide();
            pendingBlock = null;
            load();
        } catch (e) {
            $('blockModalError').textContent = e.message;
        }
    }

    async function submitBlocklistForm(event) {
        event.preventDefault();
        const status = $('blocklistFormStatus');
        try {
            const entry = await blocklistRequest('POST', 'api/blocklist', {
                kind: $('blockKind').value, value: $('blockValue').value, note: $('blockNote').value, expiry: $('blockExpiry').value,
            });
            status.className = 'small text-secondary';
            status.textContent = `Added ${entry.value}`;
            $('blockValue').value = '';
            $('blockNote').value = '';
            load();
        } catch (e) {
            status.className = 'small text-danger';
            status.textContent = e.message;
        }
    }

    async function removeBlock(entry) {
        if (!confirm(`Remove ${entry.value} from the blocklist? Its requests will be allowed and counted normally again.`)) return;
        try {
            await blocklistRequest('DELETE', `api/blocklist/${entry.id}`);
            load();
        } catch (e) {
            const status = $('blocklistFormStatus');
            status.className = 'small text-danger';
            status.textContent = `Could not remove ${entry.value}: ${e.message}`;
        }
    }

    function renderBlocklist() {
        const entries = data.blocklist;
        $('blocklistCount').textContent = entries?.length ? String(entries.length) : '';
        $('blocklistForm').classList.toggle('d-none', !entries);
        if (!entries) {
            $('blocklistInfo').textContent = '';
            $('blocklistTable').replaceChildren(h('p', {class: 'text-secondary mb-0'}, 'The blocklist needs Postgres. Set PG_HOST and the other PG_ settings.'));
            return;
        }
        $('blocklistInfo').textContent = `Every request from these is rejected with the quota error until the entry is removed or expires. `
            + `Unlike limits, which apply automatically and clear on their own, entries are added by hand. Blocklisted requests `
            + `are counted only here (${fmt(data.deniedCount || 0)} today), not in the other statistics. Entries with no recent hits may no longer be needed.`;
        renderTable($('blocklistTable'), 'blocklist', [
            {key: 'kind', label: 'Kind', format: v => KIND_LABELS[v] || v},
            {key: 'value', label: 'Value', render: row => h('code', {}, row.value)},
            networkColumn({showAsn: true}),
            {key: 'note', label: 'Note', class: 'detail', render: row => h('span', {title: row.note}, row.note || '')},
            {key: 'createdAt', label: 'Added', class: 'nowrap', format: v => dateTime(v)},
            {key: 'expiresAt', label: 'Expires', class: 'nowrap', sortValue: row => row.expiresAt ?? Infinity, render: row => (row.expiresAt ? dateTime(row.expiresAt) : 'Permanent')},
            {key: 'hitsToday', label: 'Hits today', num: true, format: fmt},
            {key: 'hitsTotal', label: 'Hits total', num: true, format: fmt},
            {key: 'lastHit', label: 'Last hit', class: 'nowrap', sortValue: row => row.lastHit ?? 0, render: row => (row.lastHit ? dateTime(row.lastHit) : 'Never')},
            {key: 'remove', label: '', sortable: false, render: row => h('button', {class: 'btn btn-sm btn-outline-secondary py-0', type: 'button', onclick: () => removeBlock(row)}, 'Remove')},
        ], entries, {defaultSort: {key: 'createdAt', dir: 'desc'}, emptyText: 'No entries. Use the Block buttons in the other tables, or add one above.'});
    }

    function renderScripts() {
        const settings = data.scriptSignals || {};
        const expected = settings.expectedParams?.length ? settings.expectedParams.join(', ') : 'off (SCRIPT_EXPECTED_PARAMS not set)';
        $('scriptInfo').textContent = `For visibility only: these signals never limit or blocklist a request. A request with any signal counts as a likely script. `
            + `Expected /v3 parameters: ${expected}. Extra user agent patterns: ${settings.extraUaPatterns?.length || 0}.`;

        const requests = data.requestCount || 0;
        const rows = Object.keys(SIGNAL_LABELS).map(signal => ({
            signal,
            label: SIGNAL_LABELS[signal][0],
            description: SIGNAL_LABELS[signal][1],
            count: data.signalCounts?.[signal] || 0,
            share: requests ? (data.signalCounts?.[signal] || 0) / requests : 0,
        }));
        renderTable($('signalTable'), 'signals', [
            {key: 'label', label: 'Signal'},
            {key: 'description', label: 'What it checks', class: 'text-secondary'},
            {key: 'count', label: 'Requests', num: true, format: fmt},
            {key: 'share', label: 'Of all requests', num: true, format: v => pf.format(v)},
        ], rows, {defaultSort: {key: 'count', dir: 'desc'}});

        const filter = $('userAgentFilter').value.trim().toLowerCase();
        const agents = (data.userAgents || [])
            .filter(row => !filter || row.userAgent.toLowerCase().includes(filter))
            .map(row => ({...row, share: row.requests ? row.scripted / row.requests : 0}));
        $('userAgentInfo').textContent = `Today, top ${agents.length} of ${fmt(data.userAgentsTracked || 0)} tracked.`;
        renderTable($('userAgentTable'), 'userAgents', [
            {
                key: 'userAgent',
                label: 'User agent',
                class: 'detail',
                render: row => h('span', {title: row.userAgent}, row.userAgent)
            },
            {key: 'requests', label: 'Requests', num: true, format: fmt},
            {key: 'scripted', label: 'Script-like', num: true, format: fmt},
            {key: 'share', label: 'Share', num: true, format: v => pf.format(v)},
        ], agents, {defaultSort: {key: 'requests', dir: 'desc'}, emptyText: 'No requests today.'});
    }

    function renderUpstream() {
        const {latency, endpoints, errors, recentErrors} = data.upstream;
        const col = 'col-6 col-md-4 col-xl-2';
        $('latencyTiles').replaceChildren(
            tile('Latency p50', ms(latency.p50), null, col),
            tile('Latency p90', ms(latency.p90), null, col),
            tile('Latency p99', ms(latency.p99), null, col),
            tile('Latency max', ms(latency.max), null, col),
            tile('Samples', fmt(latency.samples), 'most recent upstream calls', col),
        );

        renderTable($('endpointTable'), 'endpoints', [
            {key: 'endpoint', label: 'Endpoint', render: row => h('code', {}, row.endpoint)},
            {key: 'upstream', label: 'Upstream', num: true, format: fmt},
            {key: 'cached', label: 'Cached', num: true, format: fmt},
            {
                key: 'hitRate', label: 'Hit rate', num: true,
                sortValue: row => (row.upstream + row.cached ? row.cached / (row.upstream + row.cached) : 0),
                render: row => (row.upstream + row.cached ? pf.format(row.cached / (row.upstream + row.cached)) : '—'),
            },
            {key: 'units', label: 'Units', num: true, format: fmt},
            {key: 'search', label: 'Search', num: true, format: fmt},
            {key: 'errors', label: 'Errors', num: true, format: fmt},
        ], endpoints, {
            defaultSort: {key: 'upstream', dir: 'desc'},
            emptyText: 'No upstream calls today.'
        });

        renderTable($('errorTable'), 'errors', [
            {key: 'status', label: 'Status', num: true},
            {key: 'reason', label: 'Reason', format: v => v || '—'},
            {key: 'count', label: 'Count', num: true, format: fmt},
        ], errors, {defaultSort: {key: 'count', dir: 'desc'}, emptyText: 'No upstream errors today.'});

        renderTable($('recentErrorTable'), 'recentErrors', [
            {key: 'time', label: 'Time', class: 'nowrap', format: v => dateTime(v)},
            {key: 'endpoint', label: 'Endpoint', render: row => h('code', {}, row.endpoint)},
            {key: 'status', label: 'Status', num: true},
            {key: 'reason', label: 'Reason', format: v => v || '—'},
            {
                key: 'detail',
                label: 'Request',
                class: 'detail',
                render: row => h('span', {title: row.detail || ''}, row.detail || '')
            },
        ], recentErrors, {
            defaultSort: {key: 'time', dir: 'desc'},
            emptyText: 'No upstream errors since the last restart.'
        });
    }

    function renderCache() {
        const c = data.cache;
        const t = data.totals;
        const resolve = data.upstream.endpoints.find(e => e.endpoint === 'v1/resolve_url');
        const total = c.hits + c.misses;
        const col = 'col-6 col-md-4 col-xl-2';
        $('cacheTiles').replaceChildren(
            tile('Cached entries', fmt(c.keys), `TTL ${fmt(c.ttlSec)}s`, col),
            tile('Hit rate', total ? pf.format(c.hits / total) : '—', `${fmt(c.hits)} hits, ${fmt(c.misses)} misses`, col),
            tile('Approx. size', `${cf.format((c.ksize + c.vsize) / 1024)} KB`, 'keys plus values', col),
            tile('Quota units used', fmt(t.units), 'today', col),
            tile('Quota units saved by cache', fmt(t.unitsSaved), `${fmt(t.cached)} cached responses in total`, col),
            tile('Search calls', fmt(t.search), `${fmt(t.searchSaved)} served from cache`, col),
            tile('Vanity URLs resolved', fmt(resolve?.upstream ?? 0), `${fmt(resolve?.cached ?? 0)} served from cache`, col),
        );
    }

    // -----------------------------------------------------------------------
    // Loading
    // -----------------------------------------------------------------------

    function render() {
        renderHeader();
        renderTiles();
        renderMeters();
        renderCharts();
        renderConsumers();
        renderDistinct();
        renderEvents();
        renderScripts();
        renderBlocklist();
        renderUpstream();
        renderCache();
    }

    function schedule() {
        clearTimeout(timer);
        if ($('autoRefresh').checked) timer = setTimeout(load, REFRESH_MS);
    }

    async function load() {
        clearTimeout(timer);
        document.body.classList.add('refreshing');
        try {
            const response = await fetch(apiUrl(`api/stats?n=${TOP_N}`), {cache: 'no-store'});
            if (response.status === 401) {
                location.reload();
                return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            data = await response.json();
            if (range === '7d' && data.persistence) await loadLongHistory().catch(() => {});
            // ?range=7d opens the page on the 7 day view (once Postgres is known to be available)
            if (requestedRange === '7d' && data.persistence) {
                requestedRange = null;
                await setRange('7d');
            }
            $('error').classList.add('d-none');
            render();
            $('updated').textContent = `Updated ${new Date(data.now).toLocaleTimeString()}`;
        } catch (e) {
            $('error').textContent = `Could not load stats: ${e.message}`;
            $('error').classList.remove('d-none');
        } finally {
            document.body.classList.remove('refreshing');
            schedule();
        }
    }

    buildCharts();

    // Keep the selected tab in the URL so a reload returns to it
    for (const button of document.querySelectorAll('[data-bs-toggle="tab"]')) {
        button.addEventListener('shown.bs.tab', () => window.history.replaceState(null, '', button.dataset.bsTarget.replace('#tab-', '#')));
    }
    const initialTab = location.hash && document.querySelector(`[data-bs-target="${location.hash.replace('#', '#tab-')}"]`);
    if (initialTab) bootstrap.Tab.getOrCreateInstance(initialTab).show();

    $('autoRefresh').addEventListener('change', schedule);
    $('blockModalForm').addEventListener('submit', submitBlock);
    $('blockModal').addEventListener('shown.bs.modal', () => $('blockModalNote').focus());
    $('blocklistForm').addEventListener('submit', submitBlocklistForm);
    for (const button of document.querySelectorAll('[data-range]')) {
        button.addEventListener('click', () => setRange(button.dataset.range));
    }
    $('refreshNow').addEventListener('click', load);
    for (const id of ['consumerScope', 'consumerMetric', 'consumerFilter']) $(id).addEventListener('input', () => data && renderConsumers());
    for (const id of ['distinctScope', 'distinctFilter']) $(id).addEventListener('input', () => data && renderDistinct());
    $('eventFilter').addEventListener('input', () => data && renderEvents());
    $('userAgentFilter').addEventListener('input', () => data && renderScripts());
    $('historyTableWrap').addEventListener('show.bs.collapse', () => data && renderHistoryTable());

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => data && charts.forEach(drawChart), 150);
    });

    load();
})();
