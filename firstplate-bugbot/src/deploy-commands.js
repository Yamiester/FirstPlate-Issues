import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env");
    process.exit(1);
}

const commands = [
    new SlashCommandBuilder()
        .setName("setup-bugpanel")
        .setDescription("Post the FirstPlate bug report button panel in this channel."),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
console.log("✅ Deployed /setup-bugpanel");
