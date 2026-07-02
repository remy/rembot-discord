import crypto from 'node:crypto';

/**
 * Sliding-window duplicate-message tracker.
 *
 * Keeps a short in-memory history of each user's recent messages and reports when the same
 * (normalised) content has appeared in enough DISTINCT channels within the configured window.
 *
 * Purely in-memory: a process restart resets the window, which is acceptable for this pattern.
 */
export default class DuplicateTracker {
  #history = new Map(); // userId -> Array<{ channelId, hash, ts }>

  constructor({ windowMs, dupChannelThreshold, minMessageLength }) {
    this.windowMs = windowMs;
    this.dupChannelThreshold = dupChannelThreshold;
    this.minMessageLength = minMessageLength;
  }

  /** Normalise content: collapse whitespace, trim, lowercase. */
  static normalise(content) {
    return content.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  static hash(normalised) {
    return crypto.createHash('sha1').update(normalised).digest('hex');
  }

  /**
   * Record a message and decide whether it trips the duplicate threshold.
   * Returns { tripped, channelIds, sample } — channelIds is the set of distinct channels the
   * duplicate appeared in; sample is the normalised content that matched.
   */
  record(userId, channelId, content, now = Date.now()) {
    const normalised = DuplicateTracker.normalise(content);
    if (normalised.length < this.minMessageLength) {
      return { tripped: false };
    }

    const hash = DuplicateTracker.hash(normalised);
    const cutoff = now - this.windowMs;

    // Fetch + prune this user's history to the active window.
    const recent = (this.#history.get(userId) ?? []).filter((e) => e.ts >= cutoff);
    recent.push({ channelId, hash, ts: now });
    this.#history.set(userId, recent);

    // Distinct channels this exact content appeared in, inside the window.
    const channelIds = new Set(
      recent.filter((e) => e.hash === hash).map((e) => e.channelId),
    );

    if (channelIds.size >= this.dupChannelThreshold) {
      return { tripped: true, channelIds: [...channelIds], sample: normalised };
    }
    return { tripped: false };
  }

  /** Forget a user's history (e.g. after they've been actioned). */
  clear(userId) {
    this.#history.delete(userId);
  }
}
