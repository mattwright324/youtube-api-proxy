const LEVELS = {debug: 10, info: 20, warn: 30, error: 40};
const FORMATS = ['text', 'json'];

// Characters that would let a value span lines or be confused with log syntax
const UNSAFE = /[\s"=\\\x00-\x1f\x7f\u2028\u2029]/;

function escapeSeparators(text) {
    return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function serializeError(error) {
    return {name: error.name, message: error.message, stack: error.stack};
}

function textValue(value) {
    if (value instanceof Error) value = value.stack || String(value);
    if (value !== null && typeof value === 'object') return escapeSeparators(JSON.stringify(value));
    const text = String(value);
    return text === '' || UNSAFE.test(text) ? escapeSeparators(JSON.stringify(text)) : text;
}

function formatText(time, level, msg, fields) {
    const parts = [time, level.toUpperCase().padEnd(5), msg.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ')];
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) parts.push(`${key}=${textValue(value)}`);
    }
    return parts.join(' ');
}

function formatJson(time, level, msg, fields) {
    const entry = {time, level, msg};
    for (const [key, value] of Object.entries(fields)) {
        if (!(key in entry) && value !== undefined) {
            entry[key] = value instanceof Error ? serializeError(value) : value;
        }
    }
    return escapeSeparators(JSON.stringify(entry));
}

/**
 * level: minimum level written ('debug', 'info', 'warn', 'error'). format: 'text' or 'json'.
 * write(level, line) replaces the default stdout/stderr output (used by tests).
 */
export function createLogger({level = 'info', format = 'text', write} = {}) {
    if (!(level in LEVELS)) throw new Error(`Invalid log level "${level}", expected one of ${Object.keys(LEVELS).join(', ')}`);
    if (!FORMATS.includes(format)) throw new Error(`Invalid log format "${format}", expected one of ${FORMATS.join(', ')}`);

    const min = LEVELS[level];
    const formatLine = format === 'json' ? formatJson : formatText;
    const output = write || ((lineLevel, line) => (LEVELS[lineLevel] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n'));

    const logger = {};
    for (const name of Object.keys(LEVELS)) {
        logger[name] = (msg, fields = {}) => {
            if (LEVELS[name] < min) return;
            output(name, formatLine(new Date().toISOString(), name, msg, fields));
        };
    }
    return logger;
}

/** Logger configured from LOG_LEVEL and LOG_FORMAT (empty or unset uses the defaults). */
export function loggerFromEnv(env = process.env) {
    return createLogger({level: env.LOG_LEVEL || 'info', format: env.LOG_FORMAT || 'text'});
}

/** Logger that discards everything, for tests. */
export const silentLogger = createLogger({
    write: () => {
    }
});
