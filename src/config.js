import 'dotenv/config';

/** Parse a comma-separated env var into a Set of trimmed, non-empty strings. */
function parseIdSet(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer, got "${raw}"`);
  }
  return n;
}

const DELETE_SECONDS = parseIntEnv('DELETE_SECONDS', 3600);
if (DELETE_SECONDS > 604800) {
  throw new Error('DELETE_SECONDS cannot exceed 604800 (7 days, Discord API limit)');
}

const ACTION = (process.env.ACTION ?? 'ban').trim().toLowerCase();
if (!['ban', 'softban', 'kick'].includes(ACTION)) {
  throw new Error(`Invalid ACTION: "${ACTION}". Use ban, softban, or kick.`);
}

const config = {
  token: process.env.DISCORD_TOKEN,
  dupChannelThreshold: Math.max(2, parseIntEnv('DUP_CHANNEL_THRESHOLD', 2)),
  windowMs: parseIntEnv('WINDOW_MS', 30000),
  minMessageLength: parseIntEnv('MIN_MESSAGE_LENGTH', 8),
  deleteSeconds: DELETE_SECONDS,
  action: ACTION, // 'ban' | 'softban' | 'kick'
  dryRun: (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true',
  monitoredChannelIds: parseIdSet(process.env.MONITORED_CHANNEL_IDS),
  ignoredChannelIds: parseIdSet(process.env.IGNORED_CHANNEL_IDS),
  immuneRoleId: (process.env.IMMUNE_ROLE_ID ?? '').trim() || null,
  modLogChannelId: (process.env.MOD_LOG_CHANNEL_ID ?? '').trim() || null,
  dataDir: (process.env.DATA_DIR ?? './data').trim(),
};

if (!config.token) {
  throw new Error('DISCORD_TOKEN is required. Copy .env.example to .env and fill it in.');
}

export default config;
