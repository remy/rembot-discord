import { PermissionFlagsBits } from 'discord.js';

/**
 * Handles enforcement (ban + message purge) with safety guards and a race guard so two
 * near-simultaneous messages can't double-ban the same user.
 */
export default class Enforcer {
  #actioned = new Set(); // userIds currently being / already actioned

  constructor(config, tracker, store) {
    this.config = config;
    this.tracker = tracker;
    this.store = store;
  }

  /** Record an action to the persistent log. Sample is truncated to bound file size. */
  async #record(message, detection, action, dryRun) {
    await this.store.add({
      ts: new Date().toISOString(),
      userId: message.author.id,
      tag: this.#tag(message),
      channelIds: detection.channelIds,
      sample: detection.sample.slice(0, 300),
      action, // 'ban' | 'softban' | 'kick'
      dryRun: Boolean(dryRun),
    });
  }

  /** True if this member must never be actioned. */
  #isImmune(member) {
    if (!member) return false; // left the guild; ban-by-id is still safe
    if (member.user.bot) return true;
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions.has(PermissionFlagsBits.BanMembers)) return true;
    if (this.config.immuneRoleId && member.roles.cache.has(this.config.immuneRoleId)) return true;
    return false;
  }

  /**
   * Act on a tripped detection.
   * @param {import('discord.js').Message} message the message that tripped detection
   * @param {{ channelIds: string[], sample: string }} detection
   */
  async handle(message, detection) {
    const userId = message.author.id;
    const guild = message.guild;

    // Race guard: claim the user before any await.
    if (this.#actioned.has(userId)) return;
    this.#actioned.add(userId);

    try {
      const member = message.member ?? (await guild.members.fetch(userId).catch(() => null));
      if (this.#isImmune(member)) {
        this.#log(`Skipped immune/privileged user ${this.#tag(message)} (${userId}).`);
        this.#actioned.delete(userId); // allow future evaluation
        return;
      }

      const channelList = detection.channelIds.map((id) => `<#${id}>`).join(', ');
      const reason = `rembot: same message in ${detection.channelIds.length} channels within ${
        this.config.windowMs / 1000
      }s`;
      const action = this.config.action;
      const titles = {
        ban: '🔨 Banned + purged messages',
        softban: '👢 Soft-banned (kicked + purged messages)',
        kick: '👢 Kicked (messages left in place)',
      };

      if (this.config.dryRun) {
        await this.#record(message, detection, action, true);
        await this.#report(guild, {
          title: `🟡 DRY RUN — would ${action}`,
          userId,
          tag: this.#tag(message),
          channelList,
          sample: detection.sample,
        });
        return;
      }

      await this.#perform(guild, userId, reason);
      this.tracker.clear(userId);
      await this.#record(message, detection, action, false);

      await this.#report(guild, {
        title: titles[action],
        userId,
        tag: this.#tag(message),
        channelList,
        sample: detection.sample,
      });
    } catch (err) {
      // Most common cause: role hierarchy (bot's role must be above the target's).
      this.#log(
        `Failed to ${this.config.action} ${userId}: ${err?.message ?? err}. ` +
          `Check the bot's permissions (Ban Members for ban/softban, Kick Members for kick) ` +
          `and that its role is ABOVE the target's highest role.`,
      );
      this.#actioned.delete(userId); // let a later message retry
    }
  }

  /** Execute the configured action. */
  async #perform(guild, userId, reason) {
    switch (this.config.action) {
      case 'softban':
        // Ban with message deletion, then immediately unban → a kick that also purges messages.
        await guild.members.ban(userId, {
          deleteMessageSeconds: this.config.deleteSeconds,
          reason,
        });
        await guild.bans.remove(userId, `${reason} (softban auto-unban)`);
        break;
      case 'kick':
        // Kick has no message-deletion option; messages are left in place.
        await guild.members.kick(userId, reason);
        break;
      case 'ban':
      default:
        await guild.members.ban(userId, {
          deleteMessageSeconds: this.config.deleteSeconds,
          reason,
        });
    }
  }

  #tag(message) {
    return message.author.tag ?? message.author.username;
  }

  #log(msg) {
    console.log(`[enforce] ${msg}`);
  }

  async #report(guild, { title, userId, tag, channelList, sample }) {
    const truncated = sample.length > 200 ? `${sample.slice(0, 200)}…` : sample;
    this.#log(`${title}: ${tag} (${userId}) in ${channelList} — "${truncated}"`);

    if (!this.config.modLogChannelId) return;
    try {
      const channel = await guild.channels.fetch(this.config.modLogChannelId);
      if (!channel?.isTextBased()) return;
      await channel.send({
        embeds: [
          {
            title,
            color: title.includes('DRY') ? 0xffcc00 : 0xff3333,
            fields: [
              { name: 'User', value: `${tag} (<@${userId}>)`, inline: false },
              { name: 'Channels', value: channelList || '—', inline: false },
              { name: 'Message', value: `\`\`\`${truncated || '—'}\`\`\``, inline: false },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err) {
      this.#log(`Could not post to mod-log channel: ${err?.message ?? err}`);
    }
  }
}
