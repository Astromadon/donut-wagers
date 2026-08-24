class IntegrationNotConfiguredError extends Error {
  constructor() { super('Donut SMP integration is not configured.'); this.code = 'NOT_CONFIGURED'; }
}

class DonutSMPService {
  constructor({ apiUrl, apiKey, botUsername }) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.botUsername = botUsername || 'DonutWagersBot';
  }
  isConfigured() { return Boolean(this.apiUrl && this.apiKey); }
  status() { return this.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED'; }
  async getPlayerBalance() { throw new IntegrationNotConfiguredError(); }
  async getRecentTransactions() { throw new IntegrationNotConfiguredError(); }
  async verifyDeposit() { throw new IntegrationNotConfiguredError(); }
  async resolveMinecraftProfile() {
    // Microsoft OAuth proves a Microsoft identity, not ownership of a Minecraft UUID.
    // A trusted Minecraft/Xbox service adapter must implement this method before linking.
    throw new IntegrationNotConfiguredError();
  }
}

class DonutWagersBotService extends DonutSMPService {
  async sendVerificationCode() { throw new IntegrationNotConfiguredError(); }
  async getPlayerIdentityByUsername() { throw new IntegrationNotConfiguredError(); }
}

module.exports = { DonutSMPService, DonutWagersBotService, IntegrationNotConfiguredError };
