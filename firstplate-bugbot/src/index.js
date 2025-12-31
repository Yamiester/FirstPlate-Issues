import "dotenv/config";
import {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType,
} from "discord.js";

const {
    DISCORD_TOKEN,
    BUG_LOG_CHANNEL_ID,
    TICKET_CATEGORY_ID,
    STAFF_ROLE_ID,
    GITHUB_TOKEN,
    GITHUB_OWNER,
    GITHUB_REPO,
    GITHUB_LABEL,
} = process.env;

if (
    !DISCORD_TOKEN ||
    !BUG_LOG_CHANNEL_ID ||
    !TICKET_CATEGORY_ID ||
    !STAFF_ROLE_ID ||
    !GITHUB_TOKEN ||
    !GITHUB_OWNER ||
    !GITHUB_REPO
) {
    console.error(
        "Missing env vars. Check .env for DISCORD_TOKEN, BUG_LOG_CHANNEL_ID, TICKET_CATEGORY_ID, STAFF_ROLE_ID, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO."
    );
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Temporary store until user clicks “issue only” vs “issue + chat”
const pending = new Map(); // reportId -> report data

function newReportId() {
    return `FP-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function createGitHubIssue({ title, body, labels }) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ title, body, labels }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub issue create failed: ${res.status} ${text}`);
    }

    return res.json(); // { html_url, number, ... }
}

function makeBugEmbed({ reportId, issueUrl, user, title, description, steps, expected, actual }) {
    const embed = new EmbedBuilder()
        .setTitle(`🐛 Bug ${reportId}: ${title}`.slice(0, 256))
        .setDescription((description || "(no description)").slice(0, 4096))
        .addFields(
            { name: "Reporter", value: `${user} (${user.id})`, inline: false },
            { name: "GitHub Issue", value: issueUrl, inline: false }
        )
        .setTimestamp();

    if (steps) embed.addFields({ name: "Steps to Reproduce", value: steps.slice(0, 1024), inline: false });
    if (expected) embed.addFields({ name: "Expected", value: expected.slice(0, 1024), inline: false });
    if (actual) embed.addFields({ name: "Actual", value: actual.slice(0, 1024), inline: false });

    return embed;
}

async function postBugPanel(channel) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("bug_open_modal")
            .setLabel("Report a Bug")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("🐛")
    );

    await channel.send({
        content:
            "**Found a bug in FirstPlate?**\n" +
            "Click **Report a Bug** and fill out the form.\n\n" +
            "After submitting, choose:\n" +
            "• **📩 Create GitHub issue only** (no chat)\n" +
            "• **💬 Create issue + open chat** (private ticket channel)",
        components: [row],
    });
}

client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (i) => {
    try {
        // Slash command: /setup-bugpanel
        if (i.isChatInputCommand() && i.commandName === "setup-bugpanel") {
            const perms = i.memberPermissions;
            if (!perms?.has(PermissionFlagsBits.ManageGuild) && !perms?.has(PermissionFlagsBits.Administrator)) {
                return i.reply({ content: "You need **Manage Server** to run this.", ephemeral: true });
            }

            await postBugPanel(i.channel);
            return i.reply({ content: "✅ Bug panel posted.", ephemeral: true });
        }

        // Button -> open modal
        if (i.isButton() && i.customId === "bug_open_modal") {
            const modal = new ModalBuilder().setCustomId("bug_modal_submit").setTitle("Report a Bug");

            // Modal max is 5 inputs
            const title = new TextInputBuilder()
                .setCustomId("title")
                .setLabel("Short title")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const description = new TextInputBuilder()
                .setCustomId("description")
                .setLabel("What happened?")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            const steps = new TextInputBuilder()
                .setCustomId("steps")
                .setLabel("Steps to reproduce (optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            const expected = new TextInputBuilder()
                .setCustomId("expected")
                .setLabel("Expected result (optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            const actual = new TextInputBuilder()
                .setCustomId("actual")
                .setLabel("Actual result (optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(title),
                new ActionRowBuilder().addComponents(description),
                new ActionRowBuilder().addComponents(steps),
                new ActionRowBuilder().addComponents(expected),
                new ActionRowBuilder().addComponents(actual)
            );

            return i.showModal(modal);
        }

        // Modal submit -> choice buttons
        if (i.isModalSubmit() && i.customId === "bug_modal_submit") {
            const reportId = newReportId();

            pending.set(reportId, {
                reportId,
                userId: i.user.id,
                title: i.fields.getTextInputValue("title"),
                description: i.fields.getTextInputValue("description"),
                steps: i.fields.getTextInputValue("steps") || "",
                expected: i.fields.getTextInputValue("expected") || "",
                actual: i.fields.getTextInputValue("actual") || "",
            });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`issue_only:${reportId}`)
                    .setLabel("📩 Create GitHub issue only")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`issue_chat:${reportId}`)
                    .setLabel("💬 Create issue + open chat")
                    .setStyle(ButtonStyle.Primary)
            );

            return i.reply({
                content: `Submitted **${reportId}**. What do you want to do?`,
                components: [row],
                ephemeral: true,
            });
        }

        // Choice handlers
        if (i.isButton() && (i.customId.startsWith("issue_only:") || i.customId.startsWith("issue_chat:"))) {
            const [mode, reportId] = i.customId.split(":");
            const r = pending.get(reportId);

            if (!r) return i.reply({ content: "That report expired. Please submit again.", ephemeral: true });
            if (i.user.id !== r.userId)
                return i.reply({ content: "Only the person who submitted this report can choose this.", ephemeral: true });

            // Create GitHub issue body
            const issueTitle = `[Bug] ${r.title}`;
            const issueBody =
                `**Report ID:** ${reportId}\n` +
                `**Reporter:** ${i.user.tag} (${i.user.id})\n\n` +
                `## What happened?\n${r.description}\n\n` +
                `## Steps to reproduce\n${r.steps || "(not provided)"}\n\n` +
                `## Expected\n${r.expected || "(not provided)"}\n\n` +
                `## Actual\n${r.actual || "(not provided)"}\n`;

            const labels = [GITHUB_LABEL || "bug"];

            const issue = await createGitHubIssue({ title: issueTitle, body: issueBody, labels });
            const issueUrl = issue.html_url;

            const embed = makeBugEmbed({
                reportId,
                issueUrl,
                user: i.user,
                title: r.title,
                description: r.description,
                steps: r.steps,
                expected: r.expected,
                actual: r.actual,
            });

            // Post to staff bug log
            const logChannel = await i.guild.channels.fetch(BUG_LOG_CHANNEL_ID).catch(() => null);
            if (logChannel) await logChannel.send({ embeds: [embed] });

            // Issue only
            if (mode === "issue_only") {
                pending.delete(reportId);
                return i.update({ content: `✅ Created GitHub issue: ${issueUrl}`, components: [] });
            }

            // Issue + chat: create private ticket channel
            const safeUser = (i.user.username || "player").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "player";
            const channelName = `bug-${safeUser}-${reportId.toLowerCase()}`.slice(0, 90);

            const ticket = await i.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    {
                        id: i.user.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
                    },
                    {
                        id: STAFF_ROLE_ID,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.ManageChannels,
                        ],
                    },
                ],
            });

            await ticket.send({
                content: `Thanks! Here’s the GitHub issue: ${issueUrl}\nDrop screenshots/clips here if you have them.`,
                embeds: [embed],
            });

            pending.delete(reportId);
            return i.update({ content: `✅ Created issue + opened chat: ${ticket}`, components: [] });
        }
    } catch (err) {
        console.error(err);
        if (i.isRepliable()) {
            try {
                await i.reply({ content: "Something went wrong. Check bot logs / env IDs.", ephemeral: true });
            } catch { }
        }
    }
});

client.login(DISCORD_TOKEN);
