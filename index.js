require('dotenv').config();
const express = require('express');
const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits
} = require('discord.js');

const TIMEOUT_MS = 10 * 60 * 1000;
const SPAM_BURST_WINDOW = 8000;
const SPAM_BURST_COUNT = 5;
const SPAM_REPEAT_WINDOW = 30000;
const SPAM_REPEAT_COUNT = 3;

const TRUSTED_HOSTS = new Set([
    'discord.com',
    'discord.gg',
    'discordapp.com',
    'ptb.discord.com',
    'canary.discord.com',
    'steamcommunity.com',
    'store.steampowered.com',
    'steampowered.com',
    's.team'
]);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildEmojisAndStickers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const CONFIG = {
    WELCOME_CHANNEL: '👋-willkommen',
    MOD_LOG_CHANNEL: '📄-mod-log',
    TICKET_CHANNEL: '🎫-ticket-erstellen',
    TICKET_LOG_CHANNEL: '🎫-ticket-logs',
    RULES_CHANNEL: '📜-regeln',
    ROLES_CHANNEL: '🎭-rollen',
    DEFAULT_ROLE: 'Spieler',
    TEAM_ROLE: 'Mod',
    WEBSITE_URL: 'https://komisann.netlify.app/',
    YOUTUBE_URL: 'https://www.youtube.com/@KomiSanN.Gaming',
    TWITCH_URL: 'https://www.twitch.tv/komisann',
    EMOTES: {
        welcome: 'only_love_256px',
        protect: 'protect_256px',
        rules: 'kristall_256px',
        network: 'Knoten_256px',
        member: 'my_nummer_1_256px',
        status: 'Radar_256px',
        link: 'connect_256px',
        ticket: 'Fadenkreutz_256px',
        staff: 'king_256px',
        warn: 'bad_ping_256px',
        spam: 'on_fire_256px',
        caps: 'brain_boom_256px',
        ban: 'bann_bot_256px',
        error: 'Glitch_256px',
        full: 'full_256px'
    }
};

const ROLE_MAPPING = {
    '🎮': '🎮 Gamer',
    '🤖': '🤖 KI-Skripter',
    '🧠': '🧠 KI-Nutzer',
    '🔔': '🔔 Ankündigungen',
    '🎲': '🎲 Game-Ping',
    '🎁': '🎁 Giveaway'
};

const spamTracker = new Map();
const activePunishments = new Set();

function findNamedEmote(guild, name) {
    const fromGuild = guild?.emojis?.cache.find((emoji) => emoji.name === name);
    if (fromGuild) return fromGuild;
    return client.emojis.cache.find((emoji) => emoji.name === name) ?? null;
}

function emoteText(guild, key, fallback) {
    const emoji = findNamedEmote(guild, CONFIG.EMOTES[key]);
    return emoji ? emoji.toString() : fallback;
}

function emoteButton(guild, key, fallback) {
    const emoji = findNamedEmote(guild, CONFIG.EMOTES[key]);
    if (!emoji) return fallback;
    return { id: emoji.id, name: emoji.name, animated: emoji.animated };
}

function findTextChannel(guild, fragment) {
    return guild.channels.cache.find((ch) => ch.name.includes(fragment) && ch.isTextBased()) ?? null;
}

function ticketChannelName(username) {
    const safe = username.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 80) || 'user';
    return `ticket-${safe}`;
}

function punishmentKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function foldHost(host) {
    return host
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/[аɑàáâãäå]/g, 'a')
        .replace(/[её]/g, 'e')
        .replace(/[іíìï]/g, 'i')
        .replace(/[оοòóôõö]/g, 'o')
        .replace(/[р]/g, 'p')
        .replace(/[с]/g, 'c')
        .replace(/[у]/g, 'y')
        .replace(/[х]/g, 'x')
        .replace(/\.+$/, '');
}

function extractHosts(content) {
    const hosts = new Set();
    const pattern = /(?:https?:\/\/)?((?:[a-z0-9\u0400-\u04FF-]+\.)+[a-z\u0400-\u04FF]{2,})(?::\d+)?/gi;
    for (const match of content.matchAll(pattern)) {
        hosts.add(foldHost(match[1]));
    }
    return [...hosts];
}

function isPhishingHost(host) {
    if (!host || TRUSTED_HOSTS.has(host)) return false;
    if (host === 'discord.gift' || host.endsWith('.discord.gift')) return true;
    const looksLikeBrand = /(discord|nitro|steamcommunity|steampowered|steam)/i.test(host);
    const typosquat = /(dlscord|discrod|dicsord|discorcl|discordd|discordapp|nitrogift|freenitro|steamcomun|steancommunity|stemcommunity)/i.test(host);
    return looksLikeBrand || typosquat;
}

function phishingHosts(content) {
    return extractHosts(content).filter(isPhishingHost);
}

function isCaps(content) {
    if (content.length <= 15) return false;
    const letters = content.replace(/[^A-Za-zÄÖÜäöü]/g, '');
    if (letters.length < 10) return false;
    const upper = letters.replace(/[^A-ZÄÖÜ]/g, '').length;
    return upper / letters.length > 0.7;
}

function registerSpam(message) {
    const now = Date.now();
    const key = punishmentKey(message.guild.id, message.author.id);
    const entry = spamTracker.get(key) ?? { messages: [] };
    entry.messages.push({
        at: now,
        content: message.content,
        channelId: message.channel.id,
        id: message.id
    });
    entry.messages = entry.messages.filter((item) => now - item.at < SPAM_REPEAT_WINDOW);
    spamTracker.set(key, entry);

    const burst = entry.messages.filter((item) => now - item.at < SPAM_BURST_WINDOW).length >= SPAM_BURST_COUNT;
    const repeats = message.content.length > 0
        && entry.messages.filter((item) => item.content === message.content).length >= SPAM_REPEAT_COUNT;
    return { hit: burst || repeats, messages: entry.messages };
}

async function deleteSpamMessages(message, items) {
    const ids = items
        .filter((item) => item.channelId === message.channel.id && item.id !== message.id)
        .map((item) => item.id);

    await Promise.all(ids.map(async (id) => {
        const target = await message.channel.messages.fetch(id).catch(() => null);
        if (target) await target.delete().catch(() => {});
    }));
}

async function note(channel, text) {
    const sent = await channel.send(text).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), 8000);
}

function isStaff(member) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    return member.permissions.has(PermissionFlagsBits.ManageMessages)
        || member.permissions.has(PermissionFlagsBits.Administrator);
}

client.once('ready', () => {
    console.log(`[ONLINE] NetRunner ist erfolgreich eingeloggt als ${client.user.tag}`);
    client.user.setActivity('KomisAnN & S.A.RP', { type: 3 });
});

client.on('guildMemberAdd', async (member) => {
    try {
        const role = member.guild.roles.cache.find((entry) => entry.name === CONFIG.DEFAULT_ROLE);
        if (role) await member.roles.add(role);
    } catch (error) {
        console.error('[FEHLER BEIM JOIN]', error);
    }

    try {
        const welcomeChannel = member.guild.channels.cache.find((ch) => ch.name.includes('willkommen') && ch.isTextBased());
        if (!welcomeChannel) return;

        const love = emoteText(member.guild, 'welcome', '💚');
        const node = emoteText(member.guild, 'network', '🔗');
        const rulesChannel = findTextChannel(member.guild, 'regeln');
        const rolesChannel = findTextChannel(member.guild, 'rollen');
        const rulesMention = rulesChannel ? `<#${rulesChannel.id}>` : '#regeln';
        const rolesMention = rolesChannel ? `<#${rolesChannel.id}>` : '#rollen';

        const embed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle(`${love} Willkommen im NetRunner-Netzwerk, ${member.user.username}!`)
            .setDescription(
                `${node} Du hast dich erfolgreich in den **KomisAnN**-Server eingeloggt.\n\n` +
                `> **Nächste Schritte:**\n` +
                `> • Lies die Protokolle in ${rulesMention}.\n` +
                `> • Hol dir deine Rollen in ${rolesMention}.\n` +
                `> • Besuche auch unsere Web-Präsenz: [KomisAnN Website](${CONFIG.WEBSITE_URL})\n\n` +
                `Viel Erfolg im System!`
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setTimestamp();

        await welcomeChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('[FEHLER] Willkommensnachricht:', error);
    }
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || !reaction.message.guild) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const roleName = ROLE_MAPPING[reaction.emoji.name];
    if (!roleName) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    const role = guild.roles.cache.find((r) => r.name === roleName);

    if (role && member) await member.roles.add(role).catch(() => {});
});

client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot || !reaction.message.guild) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const roleName = ROLE_MAPPING[reaction.emoji.name];
    if (!roleName) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    const role = guild.roles.cache.find((r) => r.name === roleName);

    if (role && member) await member.roles.remove(role).catch(() => {});
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || !message.member) return;

    if (message.content === '!webseite') {
        const linkEmote = emoteText(message.guild, 'link', '🔗');
        const embed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle(`${linkEmote} KomisAnN & NetRunner Portal`)
            .setDescription(`Besuche unsere offizielle Webpräsenz für alle Infos, Updates und Projekte:\n\n👉 **[Hier geht es zur Website](${CONFIG.WEBSITE_URL})**`)
            .setFooter({ text: 'NetRunner Web Gateway' })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] }).catch(() => {});
        return;
    }

    if (message.content === '!youtube') {
        const linkEmote = emoteText(message.guild, 'link', '📺');
        const embed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle(`${linkEmote} KomisAnN YouTube-Kanal`)
            .setDescription(`Schau dir die neuesten Let's Plays, Hardcore-Durchläufe und Dev-Einblicke an:\n\n👉 **[Zum YouTube-Kanal](${CONFIG.YOUTUBE_URL})**`)
            .setFooter({ text: 'NetRunner Media Gateway' })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] }).catch(() => {});
        return;
    }

    if (message.content === '!twitch') {
        const linkEmote = emoteText(message.guild, 'link', '🟣');
        const embed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle(`${linkEmote} KomisAnN Twitch-Stream`)
            .setDescription(`Sei live dabei bei unseren Streams, Gaming-Sessions und Coding-Projekten:\n\n👉 **[Zum Twitch-Kanal](${CONFIG.TWITCH_URL})**`)
            .setFooter({ text: 'NetRunner Live Gateway' })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] }).catch(() => {});
        return;
    }

    if (message.content === '!setup-ticket') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        await message.delete().catch(() => {});

        const ticketChannel = findTextChannel(message.guild, 'ticket-erstellen');
        if (!ticketChannel) return;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Ticket erstellen')
                .setEmoji(emoteButton(message.guild, 'ticket', '🎯'))
                .setStyle(ButtonStyle.Success)
        );

        const embed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle('🎯 Support-Ticket erstellen')
            .setDescription('Klicke auf den grünen Button, um ein privates Ticket zu öffnen.');

        await ticketChannel.send({ embeds: [embed], components: [row] });
        return;
    }

    if (message.content === '!setup-rollen') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        await message.delete().catch(() => {});

        const rolesChannel = findTextChannel(message.guild, 'rollen');
        if (!rolesChannel) return;

        const embed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle('🎭 Interessen- & Benachrichtigungs-Rollen')
            .setDescription('Reagiere mit Emojis, um dir Rollen zuzuweisen:\n\n🎮 → Gamer\n🤖 → KI-Skripter\n🧠 → KI-Nutzer\n🔔 → Ankündigungen\n🎲 → Game-Ping\n🎁 → Giveaway');

        const msg = await rolesChannel.send({ embeds: [embed] });
        for (const e of ['🎮', '🤖', '🧠', '🔔', '🎲', '🎁']) {
            await msg.react(e).catch(() => {});
        }
        return;
    }

    if (isStaff(message.member)) return;

    const hosts = phishingHosts(message.content);
    if (hosts.length) {
        await message.delete().catch(() => {});
        if (message.member.bannable) {
            await message.member.ban({ deleteMessageSeconds: 86400, reason: 'NetRunner: Phishing-Link' }).catch(() => {});
        }
        return;
    }

    const caps = isCaps(message.content);
    const spam = registerSpam(message);
    if (!caps && !spam.hit) return;

    const key = punishmentKey(message.guild.id, message.author.id);
    if (spam.hit) await deleteSpamMessages(message, spam.messages);
    await message.delete().catch(() => {});

    if (activePunishments.has(key)) return;
    activePunishments.add(key);
    setTimeout(() => activePunishments.delete(key), TIMEOUT_MS);

    if (message.member.moderatable) {
        await message.member.timeout(TIMEOUT_MS, caps ? 'NetRunner: Caps' : 'NetRunner: Spam').catch(() => {});
    }

    await note(message.channel, `⚠️ <@${message.author.id}>, ${caps ? 'Caps' : 'Spam'} ist nicht erlaubt.`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.guild || !interaction.member) return;

    if (interaction.customId === 'create_ticket') {
        const guild = interaction.guild;
        const member = interaction.member;
        const channelName = ticketChannelName(member.user.username);
        if (guild.channels.cache.find((c) => c.name === channelName)) {
            await interaction.reply({ content: '📁 Du hast bereits ein offenes Ticket.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        try {
            const teamRole = guild.roles.cache.find((r) => r.name === CONFIG.TEAM_ROLE);
            const overwrites = [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }
            ];
            if (teamRole) {
                overwrites.push({ id: teamRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
            }

            const ticketChannel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, permissionOverwrites: overwrites });
            const closeBtn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('Ticket schließen').setStyle(ButtonStyle.Danger));
            
            await ticketChannel.send({
                content: teamRole ? `${member} ${teamRole}` : `${member}`,
                embeds: [new EmbedBuilder().setColor(0x39FF14).setTitle('🎯 Support-Ticket').setDescription('Sildere hier dein Anliegen.')],
                components: [closeBtn]
            });
            await interaction.editReply({ content: `📡 Ticket erstellt: ${ticketChannel}` });
        } catch (e) {
            await interaction.editReply({ content: '⚠️ Fehler beim Erstellen.' }).catch(() => {});
        }
        return;
    }

    if (interaction.customId === 'close_ticket') {
        const channel = interaction.channel;
        await interaction.reply({ content: '📡 Ticket wird in 5 Sekunden geschlossen...' });
        setTimeout(() => channel.delete().catch(() => {}), 5000);
    }
});

const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('NetRunner Bot ist online und wach!');
});

app.listen(port, () => {
    console.log(`[HTTP] Express Webserver läuft auf Port ${port}`);
});

client.login(process.env.DISCORD_TOKEN);
