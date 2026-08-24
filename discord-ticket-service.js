class DiscordTicketServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DiscordTicketServiceError';
    this.status = status;
  }
}

class DiscordTicketService {
  constructor({ botToken, guildId, categoryId, staffRoleId, ownerId }) {
    this.botToken = botToken;
    this.guildId = guildId;
    this.categoryId = categoryId || null;
    this.staffRoleId = staffRoleId || null;
    this.ownerId = ownerId || null;
    this.botUserId = null;
  }

  isConfigured() {
    return Boolean(this.botToken && this.guildId);
  }

  async request(path, options = {}) {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      ...options,
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      throw new DiscordTicketServiceError('Discord rejected the ticket request.', response.status);
    }
    return response.status === 204 ? null : response.json();
  }

  async currentBotUserId() {
    if (this.botUserId) return this.botUserId;
    const botUser = await this.request('/users/@me');
    if (!botUser?.id) throw new DiscordTicketServiceError('Discord did not return the bot identity.', 502);
    this.botUserId = botUser.id;
    return this.botUserId;
  }

  async createMatchTicket({ matchCode, matchUrl, requester, participants = [] }) {
    if (!this.isConfigured()) throw new DiscordTicketServiceError('Discord ticketing is not configured.', 503);
    const botUserId = await this.currentBotUserId();
    const ticketPermissions = String(1024 + 2048 + 16384 + 32768 + 65536); // view, send, embed, attach, read history
    const participantIds = [...new Set([requester.discord_id, ...participants.map((participant) => participant.discord_id), this.ownerId]
      .filter((id) => /^\d{17,20}$/.test(String(id || ''))))];
    const permissionOverwrites = [
      { id: this.guildId, type: 0, deny: '1024' }, // hide every ticket from @everyone
      { id: botUserId, type: 1, allow: ticketPermissions },
      ...participantIds.map((id) => ({ id, type: 1, allow: ticketPermissions })),
      ...(this.staffRoleId && /^\d{17,20}$/.test(this.staffRoleId) ? [{ id: this.staffRoleId, type: 0, allow: ticketPermissions }] : []),
    ];
    const channel = await this.request(`/guilds/${this.guildId}/channels`, {
      method: 'POST',
      headers: { 'X-Audit-Log-Reason': encodeURIComponent('DonutWagers match support request') },
      body: JSON.stringify({
        name: `match-${matchCode}`.slice(0, 100),
        type: 0,
        ...(this.categoryId ? { parent_id: this.categoryId } : {}),
        topic: `DonutWagers support ticket for ${matchUrl}`.slice(0, 1024),
        permission_overwrites: permissionOverwrites,
      }),
    });
    const minecraftName = requester.minecraft_username || 'Minecraft not verified';
    await this.request(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `**DonutWagers match support**\nMatch: <${matchUrl}>\nRequested by: ${requester.discord_username} (${minecraftName})`,
        allowed_mentions: { parse: [] },
      }),
    });
    return {
      channelId: channel.id,
      channelUrl: `https://discord.com/channels/${this.guildId}/${channel.id}`,
    };
  }

  async banGuildMember(discordId, reason) {
    if (!this.isConfigured()) throw new DiscordTicketServiceError('Discord moderation is not configured.', 503);
    if (!/^\d{17,20}$/.test(String(discordId || ''))) throw new DiscordTicketServiceError('Invalid Discord user ID.', 400);
    await this.request(`/guilds/${this.guildId}/bans/${encodeURIComponent(discordId)}`, {
      method: 'PUT',
      headers: { 'X-Audit-Log-Reason': encodeURIComponent(`DonutWagers ban: ${String(reason || 'No reason').slice(0, 350)}`) },
      body: JSON.stringify({ delete_message_seconds: 0 }),
    });
  }

  async unbanGuildMember(discordId, reason = 'DonutWagers ban revoked') {
    if (!this.isConfigured()) throw new DiscordTicketServiceError('Discord moderation is not configured.', 503);
    if (!/^\d{17,20}$/.test(String(discordId || ''))) throw new DiscordTicketServiceError('Invalid Discord user ID.', 400);
    await this.request(`/guilds/${this.guildId}/bans/${encodeURIComponent(discordId)}`, {
      method: 'DELETE',
      headers: { 'X-Audit-Log-Reason': encodeURIComponent(String(reason).slice(0, 350)) },
    });
  }
}

module.exports = { DiscordTicketService, DiscordTicketServiceError };
