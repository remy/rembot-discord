import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import config from './config.js';
import DuplicateTracker from './tracker.js';
import Enforcer from './enforce.js';
import BanStore from './store.js';

const store = new BanStore(config.dataDir);
const tracker = new DuplicateTracker(config);
const enforcer = new Enforcer(config, tracker, store);

const historyCommand = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Show recent users rembot has actioned')
  .addIntegerOption((o) =>
    o
      .setName('limit')
      .setDescription('How many to show (default 20, max 50)')
      .setMinValue(1)
      .setMaxValue(50),
  )
  // Hides the command from members without Ban Members (still re-checked at runtime).
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .setDMPermission(false)
  .toJSON();

/** Register the slash command in a guild (instant, unlike global registration). */
async function registerCommands(guild) {
  try {
    await guild.commands.set([historyCommand]);
  } catch (err) {
    console.error(
      `[rembot] Could not register /history in "${guild.name}": ${err?.message ?? err}. ` +
        'Re-invite the bot with the "applications.commands" scope.',
    );
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/** Should this message be evaluated at all? */
function shouldWatch(message) {
  if (!message.guild) return false; // ignore DMs
  if (message.author.bot) return false; // ignore bots (and ourselves)
  if (!message.content) return false; // attachment-only / empty
  const channelId = message.channelId;
  if (config.ignoredChannelIds.has(channelId)) return false;
  if (config.monitoredChannelIds.size > 0 && !config.monitoredChannelIds.has(channelId)) {
    return false;
  }
  return true;
}

client.once(Events.ClientReady, async (c) => {
  await store.ready();
  console.log(`[rembot] Logged in as ${c.user.tag}`);
  console.log(
    `[rembot] Trigger: same message in >=${config.dupChannelThreshold} channels within ` +
      `${config.windowMs / 1000}s | purge last ${config.deleteSeconds}s | ` +
      `DRY_RUN=${config.dryRun}`,
  );
  if (config.monitoredChannelIds.size > 0) {
    console.log(`[rembot] Watching ${config.monitoredChannelIds.size} channel(s) only.`);
  } else {
    console.log('[rembot] Watching all channels.');
  }
  console.log(`[rembot] Ban log has ${store.count()} record(s) at ${config.dataDir}.`);
  for (const guild of c.guilds.cache.values()) {
    await registerCommands(guild);
  }
});

// Register the command when the bot is added to a new server.
client.on(Events.GuildCreate, (guild) => registerCommands(guild));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'history') return;

  // Runtime permission re-check (belt to setDefaultMemberPermissions).
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({
      content: 'You need the **Ban Members** permission to use this.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const limit = interaction.options.getInteger('limit') ?? 20;
  const records = store.list(limit);
  if (records.length === 0) {
    await interaction.reply({
      content: 'No actions recorded yet.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = [];
  let body = '';
  for (const r of records) {
    const when = r.ts.slice(0, 16).replace('T', ' ');
    const verb = { ban: 'banned', softban: 'softbanned', kick: 'kicked' }[r.action] ?? 'actioned';
    const isDry = r.dryRun || r.action === 'dry-run'; // r.action check tolerates any legacy records
    const note = isDry ? ` _(dry-run, would ${verb})_` : ` — ${verb}`;
    // Plain-text tag + id — never a <@mention>, so no one is pinged.
    const line = `• ${r.tag} (id ${r.userId}) — ${when} UTC — ${r.channelIds.length} ch${note}`;
    if (body.length + line.length + 1 > 1800) break; // stay under Discord's 2000-char limit
    lines.push(line);
    body += `${line}\n`;
  }

  const header = `**rembot — last ${lines.length} of ${store.count()} action(s)**`;
  await interaction.reply({
    content: `${header}\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }, // hard guarantee: no pings
  });
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!shouldWatch(message)) return;
    const detection = tracker.record(message.author.id, message.channelId, message.content);
    if (detection.tripped) {
      await enforcer.handle(message, detection);
    }
  } catch (err) {
    console.error('[rembot] Error handling message:', err);
  }
});

client.on(Events.Error, (err) => console.error('[rembot] Client error:', err));

// Graceful shutdown so the container stops cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[rembot] Received ${signal}, shutting down.`);
    client.destroy();
    process.exit(0);
  });
}

client.login(config.token);
