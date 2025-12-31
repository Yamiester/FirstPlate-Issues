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
    MessageFlags,
    Events,
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
            "## 🛡️ Bug Reporting Center\n" +
            "Help us improve FirstPlate by reporting issues you encounter. Your reports are handled privately by our staff.\n\n" +
            "**How it works:**\n" +
            "1. Click **Report a Bug** below.\n" +
            "2. Fill out the form with as much detail as possible.\n" +
            "3. After submitting, you can optionally chat with devs to provide more info.",
        components: [row],
    });
}

client.once(Events.ClientReady, () => {
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
            return i.reply({ content: "✅ Bug panel posted.", flags: [MessageFlags.Ephemeral] });
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
        // Modal submit -> Create issue + log -> Optional chat button
        if (i.isModalSubmit() && i.customId === "bug_modal_submit") {
            const reportId = newReportId();
            const r = {
                reportId,
                userId: i.user.id,
                title: i.fields.getTextInputValue("title"),
                description: i.fields.getTextInputValue("description"),
                steps: i.fields.getTextInputValue("steps") || "",
                expected: i.fields.getTextInputValue("expected") || "",
                actual: i.fields.getTextInputValue("actual") || "",
            };

            // Create GitHub issue immediately
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

            // Post to staff bug log immediately
            const logChannel = await i.guild.channels.fetch(BUG_LOG_CHANNEL_ID).catch(() => null);
            if (logChannel) await logChannel.send({ embeds: [embed] });

            // Store for potential chat
            pending.set(reportId, { ...r, issueUrl, embed });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`bug_chat_start:${reportId}`)
                    .setLabel("💬 Speak with Developers")
                    .setStyle(ButtonStyle.Primary)
            );

            return i.reply({
                content: `✅ **Bug Report Submitted!**\n` +
                    `Your report has been logged and a GitHub issue has been created: ${issueUrl}\n\n` +
                    `If you have screenshots or want to speak directly with a developer to better explain the issue, click below:`,
                components: [row],
                flags: [MessageFlags.Ephemeral],
            });
        }

        // Choice handlers
        // Optional Chat Handler
        if (i.isButton() && i.customId.startsWith("bug_chat_start:")) {
            const reportId = i.customId.split(":")[1];
            const r = pending.get(reportId);

            if (!r) return i.reply({ content: "That session expired. If you still need a chat, please contact staff directly.", flags: [MessageFlags.Ephemeral] });
            if (i.user.id !== r.userId)
                return i.reply({ content: "Only the person who submitted this report can open a chat.", flags: [MessageFlags.Ephemeral] });

            // Create private ticket channel using sanitized bug title
            const safeTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "bug";
            const channelName = `bug-${safeTitle}-${reportId.toLowerCase()}`.slice(0, 90);

            const ticket = await i.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: TICKET_CATEGORY_ID,
                topic: `Report ID: ${reportId} | User: ${i.user.id}`,
                permissionOverwrites: [
                    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    {
                        id: client.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.EmbedLinks,
                            PermissionFlagsBits.AttachFiles
                        ]
                    },
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

            const closeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("bug_close_ticket")
                    .setLabel("Close Ticket")
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji("🔒")
            );

            await ticket.send({
                content: `Thanks! We've saved your report and created a GitHub issue: ${r.issueUrl}\nYou can drop screenshots or extra details here.`,
                embeds: [r.embed],
                components: [closeRow],
            });

            pending.delete(reportId);
            return i.update({
                content: `✅ **A private chat has been opened for you here:** ${ticket}`,
                components: [],
            });
        }

        // Close Ticket Handler
        if (i.isButton() && i.customId === "bug_close_ticket") {
            const isStaff = i.member.roles.cache.has(STAFF_ROLE_ID);

            if (isStaff) {
                await i.reply({ content: "Closing ticket in 5 seconds...", flags: [] });
                setTimeout(() => i.channel.delete().catch(() => { }), 5000);
            } else {
                await i.reply({ content: "❌ Only staff can close this ticket.", flags: [MessageFlags.Ephemeral] });
            }
            return;
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
