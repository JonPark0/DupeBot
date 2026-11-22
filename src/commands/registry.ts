import {
  type APIApplicationCommand,
  ApplicationCommandType,
  REST,
  Routes,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

// Slash commands are registered per guild on startup and when the bot joins a guild,
// because guild command updates show up in Discord immediately (global ones can lag).

export class CommandRegistry {
  rest: REST;
  clientId: string;

  constructor(token: string, clientId: string) {
    this.rest = new REST({ version: '10' }).setToken(token);
    this.clientId = clientId;
  }

  /** Overwrite the command set of one guild. */
  async syncGuild(guildId: string, body: RESTPostAPIApplicationCommandsJSONBody[]): Promise<void> {
    await this.rest.put(Routes.applicationGuildCommands(this.clientId, guildId), { body });
  }

  /**
   * Remove global commands, so nothing shows up twice. Deleted one by one: an app with Activities
   * has an Entry Point command a bulk overwrite can't remove (Discord error 50240); it is kept.
   */
  async clearGlobal(): Promise<number> {
    const existing = (await this.rest.get(Routes.applicationCommands(this.clientId))) as APIApplicationCommand[];
    const stale = existing.filter((command) => command.type !== ApplicationCommandType.PrimaryEntryPoint);
    for (const command of stale) await this.rest.delete(Routes.applicationCommand(this.clientId, command.id));
    return stale.length;
  }
}
