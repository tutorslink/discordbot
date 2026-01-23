/**
 * modmail.js
 * Modular modmail subsystem for index.js
 * Node 20+, discord.js v14
 *
 * Expose default initModmail({ client, db, saveDB, config, notifyError })
 *
 * Key changes implemented
 * - Prevent duplicate modmail per user, 120s cooldown after creation
 * - Throttle user DM control messages to avoid duplicates when staff spam
 * - When staff messages are forwarded the bot reacts with ✅ on staff message for success, ❌ on failure
 * - Exposes notifyError callback or uses STAFF_CHAT_ID fallback
 * - Close flow: when staff clicks "End chat" we open a modal to collect reason (handled by index.js or here based on approach)
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';

const {
  GUILD_ID,
  STAFF_ROLE_ID,
  MODMAIL_TRANSCRIPTS_CHANNEL_ID: ENV_MODMAIL_TRANSCRIPTS_CHANNEL_ID,
  STAFF_CHAT_ID
} = process.env;

// Modmail purpose categories - maps purpose key to category ID
const MODMAIL_PURPOSE_CATEGORIES = {
  tutor_application: '1460567488634032200',
  complaints_suggestions: '1460567621186621524',
  customer_service: '1460567769966710809',
  payment: '1460567838166356122'
};

const MODMAIL_PURPOSE_OPTIONS = [
  { value: 'tutor_application', label: 'Wish to apply as a tutor', description: 'Apply to become a tutor on Tutors Link' },
  { value: 'complaints_suggestions', label: 'Complaints/Suggestions', description: 'Complain or suggest regarding tutors, students, or Tutors Link as a whole' },
  { value: 'customer_service', label: 'Need help with procedure', description: 'Help with finding tutors, applying, paying, or other procedures' },
  { value: 'payment', label: 'Payment', description: 'Anything related to giving or receiving payments' }
];

export default function initModmail({ client, db, saveDB, config = {}, notifyError = null }) {
  if (!client || !db || !saveDB) throw new Error('initModmail missing args');

  const MODMAIL_CATEGORY_ID = config.MODMAIL_CATEGORY_ID ?? '1443291406612561983';
  const MODMAIL_TRANSCRIPTS_CHANNEL_ID = config.MODMAIL_TRANSCRIPTS_CHANNEL_ID ?? ENV_MODMAIL_TRANSCRIPTS_CHANNEL_ID;

  if (!GUILD_ID || !STAFF_ROLE_ID || !MODMAIL_TRANSCRIPTS_CHANNEL_ID) {
    throw new Error('modmail config missing required env IDs: GUILD_ID, STAFF_ROLE_ID, MODMAIL_TRANSCRIPTS_CHANNEL_ID');
  }

  // Support multiple staff role ids
  function getStaffRoleIds() {
    return (STAFF_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function isStaff(member) {
    try {
      if (!member) return false;
      const roleIds = getStaffRoleIds();
      for (const rid of roleIds) {
        if (member.roles?.cache?.has && member.roles.cache.has(rid)) return true;
      }
      return false;
    } catch { return false; }
  }

  // notify staff helper: uses provided notifyError callback if present, else sends in STAFF_CHAT_ID
  async function notifyStaff(err, context = {}) {
    try {
      if (typeof notifyError === 'function') {
        try { await notifyError(err, context); return; } catch (e) { console.warn('notifyError callback failed', e); }
      }
      // fallback: send to STAFF_CHAT_ID channel
      if (!STAFF_CHAT_ID) {
        console.error('STAFF_CHAT_ID not set, cannot notify staff about error', err, context);
        return;
      }
      const ch = await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
      const roleMentions = getStaffRoleIds().map(r => `<@&${r}>`).join(' ');
      const short = `⚠️ Modmail error in module modmail.js\n${roleMentions}\nUser: ${context.userId || '(n/a)'}\nModule: ${context.module || 'modmail'}\n\`\`\`\n${String(err && (err.stack || err)).slice(0, 1900)}\n\`\`\``;
      if (ch) {
        await ch.send({ content: short }).catch(() => { console.error('failed to post staff alert', err, context); });
      } else {
        console.error('STAFF_CHAT_ID configured but channel not found', err, context);
      }
    } catch (e) {
      console.error('notifyStaff helper failed', e);
    }
  }

  // safe reply helper for interactions
  async function safeReply(interaction, opts) {
    try {
      if (!interaction) return;
      if (interaction.replied || interaction.deferred) return await interaction.followUp(Object.assign({}, opts)).catch(() => {});
      return await interaction.reply(Object.assign({}, opts)).catch(() => {});
    } catch (e) { console.warn('safeReply failed', e); await notifyStaff(e, { module: 'modmail.safeReply' }); }
  }

  // DB containers
  db.modmail = db.modmail || {};
  db.modmail.byUser = db.modmail.byUser || {};
  db.modmail.byChannel = db.modmail.byChannel || {};
  db.modmail.pending = db.modmail.pending || {};
  db.modmail.nextId = db.modmail.nextId || 1;
  // per-user creation cooldown mapping - not persisted to avoid DB growth, but we can store timestamp in memory
  const modmailCreationCooldown = {}; // `${userId}:${purposeKey}` -> timestamp of last creation

  // Migrate legacy byUser mapping (userId -> channelId) into per-purpose mapping (userId -> { purposeKey: channelId })
  try {
    for (const uid of Object.keys(db.modmail.byUser || {})) {
      const val = db.modmail.byUser[uid];
      if (!val) { db.modmail.byUser[uid] = {}; continue; }
      if (typeof val === 'string') {
        const channelId = val;
        const t = db.modmail.byChannel ? db.modmail.byChannel[channelId] : null;
        const key = (t && t.purpose) ? String(t.purpose) : 'legacy';
        db.modmail.byUser[uid] = { [key]: channelId };
      } else if (typeof val !== 'object') {
        db.modmail.byUser[uid] = {};
      }
    }
  } catch (e) {
    console.warn('modmail byUser migration failed', e);
  }
  saveDB();

  // create modmail channel with robust overwrites for multiple staff roles
  async function createModmailChannel(userId, purposeKey, purposeCategoryId = null) {
    try {
      const pKey = String(purposeKey || '').trim() || 'unknown';

      // prevent multiple modmail channels for same user+purpose
      db.modmail.byUser = db.modmail.byUser || {};
      db.modmail.byUser[userId] = db.modmail.byUser[userId] || {};
      const existingChannelId = db.modmail.byUser[userId][pKey];
      if (existingChannelId) {
        throw new Error('You already have an active ticket for this category.');
      }

      // 120s cooldown after creation per user+purpose
      const now = Date.now();
      const cooldownKey = `${userId}:${pKey}`;
      const last = modmailCreationCooldown[cooldownKey] || 0;
      if (now - last < 120 * 1000) {
        throw new Error('Please wait a bit before creating another ticket (cooldown)');
      }

      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) throw new Error('Guild not found');

      const ticketNum = db.modmail.nextId || 1;
      db.modmail.nextId = ticketNum + 1;
      saveDB();

      const code = `modmail-${ticketNum}`;

      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages] }
      ];
      for (const rid of getStaffRoleIds()) {
        if (!rid) continue;
        overwrites.push({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
      }

      const opts = {
        name: code,
        type: ChannelType.GuildText,
        permissionOverwrites: overwrites
      };
      // Use purpose-specific category if provided, otherwise fall back to default MODMAIL_CATEGORY_ID
      if (purposeCategoryId) {
        opts.parent = purposeCategoryId;
      } else if (MODMAIL_CATEGORY_ID) {
        opts.parent = MODMAIL_CATEGORY_ID;
      }

      const channel = await guild.channels.create(opts).catch(err => { throw err; });

      // set cooldown
      modmailCreationCooldown[cooldownKey] = Date.now();

      return { channel, ticketNum, code };
    } catch (e) {
      await notifyStaff(e, { module: 'modmail.createModmailChannel', userId });
      throw e;
    }
  }

  // Update staff sticky in channel (unchanged logic)
  async function updateSticky(channelId) {
    try {
      const ticket = db.modmail.byChannel[channelId];
      if (!ticket) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) return;

      const rows = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mm_close|${channelId}`).setLabel('End chat').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`mm_toggleanon|${channelId}`).setLabel(ticket.anonymousMods ? 'Anonymous: ON' : 'Anonymous: OFF').setStyle(ButtonStyle.Secondary)
        )
      ];
      const content = `Mod actions for this chat. Anonymous mod replies: ${ticket.anonymousMods ? 'ON' : 'OFF'}. Ticket ID: modmail-${ticket.id}`;

      if (ticket.stickyMessageId) {
        const prev = await channel.messages.fetch(ticket.stickyMessageId).catch(() => null);
        if (prev) {
          await prev.edit({ content, components: rows }).catch(async () => {
            try { await prev.delete().catch(() => {}); } catch {}
            const sent = await channel.send({ content, components: rows }).catch(() => null);
            if (sent) { ticket.stickyMessageId = sent.id; saveDB(); }
          });
          return;
        }
      }
      const sent = await channel.send({ content, components: rows }).catch(() => null);
      if (sent) { ticket.stickyMessageId = sent.id; saveDB(); }
    } catch (e) { console.warn('updateSticky failed', e); await notifyStaff(e, { module: 'modmail.updateSticky' }); }
  }

  // sendOrUpdateUserControl now throttles per-ticket to avoid duplicates when staff spam-send
  async function sendOrUpdateUserControl(ticket) {
    try {
      if (!ticket || !ticket.userId) return;
      // Non-sticky: only send once per ticket (do not delete/repost after staff messages)
      if (ticket.dmControlMessageId) return;

      const user = await client.users.fetch(ticket.userId).catch(() => null);
      if (!user) return;
      const dm = await user.createDM().catch(() => null);
      if (!dm) return;

      const rows = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mm_ping_dm|${ticket.channelId}`).setLabel('Ping staff (once/day)').setStyle(ButtonStyle.Primary)
        )
      ];

      const content = `Controls for your support chat, Ticket ID: modmail-${ticket.id}\n- Ping staff if you haven’t received a reply.\n- To close a ticket, please ask staff (users cannot close tickets via DM).`;

      const sent = await dm.send({ content, components: rows }).catch(err => { throw err; });
      if (sent) { ticket.dmControlMessageId = sent.id; saveDB(); }
    } catch (e) {
      console.warn('sendOrUpdateUserControl failed', e);
      await notifyStaff(e, { module: 'modmail.sendOrUpdateUserControl', userId: ticket?.userId });
    }
  }

  // post modmail transcript with Discord formatted timestamps <t:...:f>
  async function postTranscript(ticket, closedByText, transcriptChannelId = MODMAIL_TRANSCRIPTS_CHANNEL_ID) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) return;
      const channel = await guild.channels.fetch(transcriptChannelId).catch(() => null);
      if (!channel) { console.warn('Modmail transcript channel missing'); return; }

      const lines = [];
      lines.push(`Modmail Ticket #${ticket.id}`);
      lines.push(`User ID: ${ticket.userId}`);
      lines.push(`Channel ID: ${ticket.channelId}`);
      lines.push(`Purpose: ${ticket.purposeLabel || ticket.purpose || 'Not specified'}`);
      lines.push(`Started: <t:${Math.floor(ticket.createdAt/1000)}:f>`);
      lines.push(`Closed by: ${closedByText}`);
      lines.push('----------------------------------');

      for (const m of ticket.messages || []) {
        const when = `<t:${Math.floor(m.at / 1000)}:f>`;
        let row = `[${when}] ${m.who}: ${m.text || ''}`;
        if (m.attachments && m.attachments.length) row += `\nAttachments: ${m.attachments.join(' ')}`;
        lines.push(row);
      }
      lines.push('----------------------------------\nEnd of transcript');

      const full = lines.join('\n');
      if (full.length < 1900) {
        await channel.send(full).catch(() => {});
      } else {
        for (let i = 0; i < full.length; i += 1900) {
          await channel.send(full.slice(i, i + 1900)).catch(() => {});
        }
      }

      for (const m of ticket.messages || []) {
        if (m.attachments && m.attachments.length) {
          for (const url of m.attachments) {
            try { await channel.send({ content: url }).catch(() => {}); } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (e) { console.warn('postTranscript failed', e); await notifyStaff(e, { module: 'modmail.postTranscript', userId: ticket?.userId }); }
  }

  // interaction handlers - create button, toggles, close, etc
  client.on('interactionCreate', async (interaction) => {
    try {
      // Route a pending DM to one of multiple open tickets, or start a new ticket
      // customId: mm_route|<userId>
      if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith('mm_route|')) {
        const userId = interaction.customId.split('|')[1];
        if (interaction.user.id !== userId) return safeReply(interaction, { content: 'This dropdown is only for the initiating user.', ephemeral: true });

        const choice = interaction.values && interaction.values[0] ? String(interaction.values[0]) : '';
        await interaction.deferUpdate().catch(() => {});

        // If user wants to start a new ticket, show the purpose dropdown again
        if (choice === 'new_ticket') {
          const purposeOptions = MODMAIL_PURPOSE_OPTIONS.map(opt =>
            new StringSelectMenuOptionBuilder()
              .setLabel(opt.label)
              .setValue(opt.value)
              .setDescription(opt.description)
          );
          const purposeSelect = new StringSelectMenuBuilder()
            .setCustomId(`mm_purpose|${userId}`)
            .setPlaceholder('Select the purpose of your ticket')
            .addOptions(purposeOptions)
            .setRequired(true);
          const row = new ActionRowBuilder().addComponents(purposeSelect);
          try {
            await interaction.editReply({ content: 'Please select the purpose of your new ticket.', components: [row] }).catch(() => {});
          } catch (e) {}
          return;
        }

        // Otherwise, route pending messages to the selected purpose ticket
        const purposeKey = choice;
        const byUserMap = (db.modmail.byUser && typeof db.modmail.byUser[userId] === 'object' && db.modmail.byUser[userId]) ? db.modmail.byUser[userId] : {};
        const channelId = byUserMap[purposeKey];
        if (!channelId) return safeReply(interaction, { content: 'That ticket could not be found. Please try again.', ephemeral: true });

        const ticket = db.modmail.byChannel ? db.modmail.byChannel[channelId] : null;
        if (!ticket) {
          // cleanup stale mapping
          try { delete db.modmail.byUser[userId][purposeKey]; } catch {}
          saveDB();
          return safeReply(interaction, { content: 'That ticket no longer exists. Please try again.', ephemeral: true });
        }

        const pending = db.modmail.pending && db.modmail.pending[userId] ? db.modmail.pending[userId] : null;
        if (pending && Array.isArray(pending.messages) && pending.messages.length) {
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (ch) {
            for (const p of pending.messages) {
              ticket.messages.push({ who: `User ${userId}`, at: p.at || Date.now(), text: p.text || '', attachments: p.attachments || [] });
              const sendRes = await ch.send({ content: `Message from <@${userId}>: ${p.text || ''}`, files: p.attachments && p.attachments.length ? p.attachments.slice() : [] }).catch(err => ({ __failed: true, error: err }));
              if (!sendRes || sendRes.__failed) {
                console.warn('route pending to channel failed', sendRes && sendRes.error);
              } else if (p.messageId) {
                // react ✅ on original DM message if possible
                try {
                  const u = await client.users.fetch(userId).catch(() => null);
                  const dm = u ? await u.createDM().catch(() => null) : null;
                  const m = dm ? await dm.messages.fetch(p.messageId).catch(() => null) : null;
                  if (m) await m.react('✅').catch(() => {});
                } catch (e) {}
              }
            }
            saveDB();
            try { await updateSticky(channelId).catch(() => {}); } catch {}
          }
        }
        // clear pending once routed
        try { delete db.modmail.pending[userId]; saveDB(); } catch {}

        // ensure the ping control exists (sent once)
        try { await sendOrUpdateUserControl(ticket); } catch (e) {}
        return;
      }

      // Handle purpose dropdown selection
      if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith('mm_purpose|')) {
        const userId = interaction.customId.split('|')[1];
        if (interaction.user.id !== userId) return safeReply(interaction, { content: 'This dropdown is only for the initiating user.', ephemeral: true });
        
        const selectedPurpose = interaction.values && interaction.values[0];
        if (!selectedPurpose || !MODMAIL_PURPOSE_CATEGORIES[selectedPurpose]) {
          return safeReply(interaction, { content: 'Invalid purpose selected. Please try again.', ephemeral: true });
        }

        await interaction.deferUpdate().catch(() => {});
        
        const purposeCategoryId = MODMAIL_PURPOSE_CATEGORIES[selectedPurpose];
        const purposeLabel = MODMAIL_PURPOSE_OPTIONS.find(opt => opt.value === selectedPurpose)?.label || selectedPurpose;

        // If a ticket already exists for this purpose, just route any pending messages to it (one open ticket per category)
        db.modmail.byUser = db.modmail.byUser || {};
        db.modmail.byUser[userId] = (db.modmail.byUser[userId] && typeof db.modmail.byUser[userId] === 'object') ? db.modmail.byUser[userId] : {};
        const existingChannelId = db.modmail.byUser[userId][selectedPurpose];
        if (existingChannelId) {
          const existingTicket = db.modmail.byChannel ? db.modmail.byChannel[existingChannelId] : null;
          if (existingTicket) {
            const pending = db.modmail.pending && db.modmail.pending[userId] ? db.modmail.pending[userId] : null;
            if (pending && Array.isArray(pending.messages) && pending.messages.length) {
              const ch = await client.channels.fetch(existingChannelId).catch(() => null);
              if (ch) {
                for (const p of pending.messages) {
                  existingTicket.messages.push({ who: `User ${userId}`, at: p.at || Date.now(), text: p.text || '', attachments: p.attachments || [] });
                  const sendRes = await ch.send({ content: `Message from <@${userId}>: ${p.text || ''}`, files: p.attachments && p.attachments.length ? p.attachments.slice() : [] }).catch(err => ({ __failed: true, error: err }));
                  if (!sendRes || sendRes.__failed) {
                    console.warn('forward pending to existing ticket failed', sendRes && sendRes.error);
                  } else if (p.messageId) {
                    try {
                      const u = await client.users.fetch(userId).catch(() => null);
                      const dm = u ? await u.createDM().catch(() => null) : null;
                      const m = dm ? await dm.messages.fetch(p.messageId).catch(() => null) : null;
                      if (m) await m.react('✅').catch(() => {});
                    } catch (e) {}
                  }
                }
                saveDB();
                try { await updateSticky(existingChannelId).catch(() => {}); } catch {}
              }
            }
            try { delete db.modmail.pending[userId]; saveDB(); } catch {}
            try { await sendOrUpdateUserControl(existingTicket); } catch (e) {}
            try { const u = await client.users.fetch(userId).catch(() => null); if (u) await u.send(`Your message was sent to your existing ticket (Purpose: ${purposeLabel}).`).catch(() => {}); } catch (e) {}
            return;
          } else {
            // cleanup stale mapping
            try { delete db.modmail.byUser[userId][selectedPurpose]; saveDB(); } catch {}
          }
        }
        
        let created = null;
        try {
          created = await createModmailChannel(userId, selectedPurpose, purposeCategoryId);
        } catch (e) {
          // Creation blocked or failed, let user know
          await safeReply(interaction, { content: 'Failed to create channel, staff have been notified. Please try again later.', ephemeral: true });
          return;
        }
        if (!created) return safeReply(interaction, { content: 'Failed to create channel, try again later.', ephemeral: true });

        const { channel, ticketNum } = created;
        const ticket = { 
          id: ticketNum, 
          userId, 
          channelId: channel.id, 
          createdAt: Date.now(), 
          anonymousMods: false, 
          messages: [], 
          lastPingAt: 0, 
          stickyMessageId: null, 
          dmControlMessageId: null,
          purpose: selectedPurpose,
          purposeLabel: purposeLabel
        };
        db.modmail.byUser[userId] = (db.modmail.byUser[userId] && typeof db.modmail.byUser[userId] === 'object') ? db.modmail.byUser[userId] : {};
        db.modmail.byUser[userId][selectedPurpose] = channel.id;
        db.modmail.byChannel[channel.id] = ticket;
        saveDB();

        try {
          const pending = db.modmail.pending && db.modmail.pending[userId] ? db.modmail.pending[userId] : null;
          if (pending && Array.isArray(pending.messages) && pending.messages.length) {
            for (const p of pending.messages) {
              ticket.messages.push({ who: `User ${userId}`, at: p.at || Date.now(), text: p.text || '', attachments: p.attachments || [] });
              const sendRes = await channel.send({ content: `Message from <@${userId}>: ${p.text || ''}`, files: p.attachments && p.attachments.length ? p.attachments.slice() : [] }).catch(err => ({ __failed: true, error: err }));
              if (sendRes && sendRes.__failed) {
                console.warn('forward pending to channel failed', sendRes.error);
                try { const u = await client.users.fetch(userId).catch(() => null); if (u) await u.send('We created your ticket but could not forward your earlier message to staff due to a server error.').catch(() => {}); } catch {}
              } else if (p.messageId) {
                try {
                  const u = await client.users.fetch(userId).catch(() => null);
                  const dm = u ? await u.createDM().catch(() => null) : null;
                  const m = dm ? await dm.messages.fetch(p.messageId).catch(() => null) : null;
                  if (m) await m.react('✅').catch(() => {});
                } catch (e) {}
              }
            }
            delete db.modmail.pending[userId];
            saveDB();
          }
        } catch (e) { console.warn('Failed to forward pending', e); await notifyStaff(e, { module: 'modmail.forwardPending', userId }); }

        try { await sendOrUpdateUserControl(ticket); } catch (e) { /* logged inside */ }
        // ping staff roles in channel if possible
        try {
          const mention = getStaffRoleIds().map(r => `<@&${r}>`).join(' ');
          await channel.send({ content: `${mention} New modmail from <@${userId}> started. Purpose: ${purposeLabel}. Ticket ID: modmail-${ticket.id}` }).catch(() => {});
        } catch (e) { /* ignore */ }
        await updateSticky(channel.id).catch(() => {});
        try { 
          const userObj = await client.users.fetch(userId).catch(() => null); 
          if (userObj) {
            await userObj.send(`Your support ticket has been created (Purpose: ${purposeLabel}), ticket ID: modmail-${ticket.id}`).catch(() => {}); 
          }
        } catch (e) {}
        return;
      }

      if (!interaction.isButton()) return;
      const custom = interaction.customId;

      if (custom.startsWith('mm_cancel|')) {
        const userId = custom.split('|')[1];
        if (interaction.user.id !== userId) return safeReply(interaction, { content: 'This button is only for the initiating user.', ephemeral: true });
        await interaction.deferUpdate().catch(() => {});
        try { await interaction.editReply({ content: 'Cancelled, no ticket created.', components: [] }).catch(() => {}); } catch {}
        return;
      }

      if (custom.startsWith('mm_toggleanon|')) {
        const channelId = custom.split('|')[1];
        const ticket = db.modmail.byChannel[channelId];
        if (!ticket) return safeReply(interaction, { content: 'Ticket not found.', ephemeral: true });
        if (!isStaff(interaction.member)) return safeReply(interaction, { content: 'Only staff can toggle anonymous mode.', ephemeral: true });
        ticket.anonymousMods = !ticket.anonymousMods;
        saveDB();
        await updateSticky(channelId);
        return safeReply(interaction, { content: `Anonymous mod replies now ${ticket.anonymousMods ? 'ON' : 'OFF'}.`, ephemeral: true });
      }

      if (custom.startsWith('mm_close|')) {
        // Open a modal for reason before closing
        const channelId = custom.split('|')[1];
        const ticket = db.modmail.byChannel[channelId];
        if (!ticket) return safeReply(interaction, { content: 'Ticket not found.', ephemeral: true });
        if (!isStaff(interaction.member)) return safeReply(interaction, { content: 'Only staff can end the chat from the channel.', ephemeral: true });

        // show modal to collect reason for closing, but we also want to capture hired/tutor choice
        // For single-step simplicity in modmail, we'll open a modal for reason and expect staff to have toggled anonymous/tutor assignment earlier if needed.
        const modal = new ModalBuilder().setCustomId(`mm_close_modal|${channelId}`).setTitle(`Close modmail ${channelId}`);
        const reasonInput = new TextInputBuilder().setCustomId('mm_close_reason').setLabel('Reason for closing (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        try { await interaction.showModal(modal); } catch (e) { console.warn('showModal mm_close failed', e); await notifyStaff(e, { module: 'modmail.mm_close_showModal', userId: ticket.userId }); return safeReply(interaction, { content: 'Could not open close modal, try again.', ephemeral: true }); }
        return;
      }

      // mm_ping_dm| handled separately in DM handler below, but acknowledge here if it arrives first
      if (custom.startsWith('mm_ping_dm|')) {
        try { if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(() => {}); } catch {}
        return;
      }

    } catch (err) {
      console.error('modmail interaction error', err);
      await notifyStaff(err, { module: 'modmail.interactionCreate' });
      try { if (interaction && !interaction.replied) await safeReply(interaction, { content: 'Modmail action failed, staff notified.', ephemeral: true }); } catch {}
    }
  });

  // messageCreate handler: DMs and staff messages in channel
  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;

      // DM from user
      if (message.channel.type === ChannelType.DM) {
        const userId = message.author.id;
        const mappedRaw = db.modmail.byUser[userId];
        const attachments = message.attachments && message.attachments.size ? Array.from(message.attachments.values()).map(a => a.url) : [];

        // Normalize mapping to { purposeKey: channelId }
        let mapped = {};
        if (mappedRaw && typeof mappedRaw === 'object') mapped = mappedRaw;
        else if (typeof mappedRaw === 'string') mapped = { legacy: mappedRaw };

        const openEntries = Object.entries(mapped || {}).filter(([, cid]) => cid);

        if (!openEntries.length) {
          db.modmail.pending = db.modmail.pending || {};
          db.modmail.pending[userId] = db.modmail.pending[userId] || { messages: [], createdAt: Date.now() };
          if ((message.content && message.content.trim().length > 0) || attachments.length) {
            db.modmail.pending[userId].messages.push({ text: message.content || '', attachments, at: Date.now(), messageId: message.id });
            saveDB();
          }

          // Show dropdown menu for purpose selection
          const purposeOptions = MODMAIL_PURPOSE_OPTIONS.map(opt => 
            new StringSelectMenuOptionBuilder()
              .setLabel(opt.label)
              .setValue(opt.value)
              .setDescription(opt.description)
          );

          const purposeSelect = new StringSelectMenuBuilder()
            .setCustomId(`mm_purpose|${userId}`)
            .setPlaceholder('Select the purpose of your ticket')
            .addOptions(purposeOptions)
            .setRequired(true);

          const rows = new ActionRowBuilder().addComponents(purposeSelect);

          await message.channel.send({ content: 'Please select the purpose of your ticket to create a support ticket with staff.', components: [rows] }).catch(() => {});
          return;
        }

        // If user has multiple open tickets, ask where to route this DM
        if (openEntries.length > 1) {
          db.modmail.pending = db.modmail.pending || {};
          db.modmail.pending[userId] = db.modmail.pending[userId] || { messages: [], createdAt: Date.now() };
          if ((message.content && message.content.trim().length > 0) || attachments.length) {
            db.modmail.pending[userId].messages.push({ text: message.content || '', attachments, at: Date.now(), messageId: message.id });
            saveDB();
          }

          const routeOptions = [];
          for (const [purposeKey, channelId] of openEntries.slice(0, 24)) {
            const t = db.modmail.byChannel ? db.modmail.byChannel[channelId] : null;
            const label = (t && (t.purposeLabel || t.purpose)) ? String(t.purposeLabel || t.purpose) : String(purposeKey);
            const desc = t && t.id ? `Ticket modmail-${t.id}` : 'Open ticket';
            routeOptions.push(new StringSelectMenuOptionBuilder().setLabel(label.substring(0, 100)).setValue(String(purposeKey).substring(0, 100)).setDescription(desc.substring(0, 50)));
          }
          routeOptions.push(new StringSelectMenuOptionBuilder().setLabel('Create a new ticket').setValue('new_ticket').setDescription('Start another ticket in a different category'));

          const routeSelect = new StringSelectMenuBuilder()
            .setCustomId(`mm_route|${userId}`)
            .setPlaceholder('Choose which ticket to send this message to')
            .addOptions(routeOptions)
            .setRequired(true);

          await message.channel.send({ content: 'You have multiple open tickets. Choose where to send your message:', components: [new ActionRowBuilder().addComponents(routeSelect)] }).catch(() => {});
          return;
        }

        // Exactly one open ticket: forward message there
        const [onlyPurposeKey, onlyChannelId] = openEntries[0];
        const ticket = db.modmail.byChannel[onlyChannelId];
        if (!ticket) {
          // cleanup stale mapping
          try { delete db.modmail.byUser[userId][onlyPurposeKey]; } catch {}
          saveDB();
          await message.channel.send('Previous ticket not found. Please select a purpose to start a new ticket.').catch(() => {});
          return;
        }

        ticket.messages.push({ who: `User ${message.author.tag}`, at: Date.now(), text: message.content || '', attachments });
        saveDB();

        const embed = new EmbedBuilder().setAuthor({ name: `${message.author.tag}`, iconURL: message.author.displayAvatarURL?.() }).setTimestamp();
        if (message.content && message.content.trim().length > 0) embed.setDescription(message.content);

        const ch = await client.channels.fetch(onlyChannelId).catch(() => null);
        if (ch) {
          try {
            const payload = { content: `Message from <@${userId}>` };
            if (embed.data && embed.data.description) payload.embeds = [embed];
            if (attachments.length) payload.files = attachments.slice();

            const sent = await ch.send(payload).catch(err => ({ __failed: true, error: err }));
            if (sent && sent.__failed) {
              console.warn('Forwarding DM to modmail channel failed', sent.error);
              db.modmail.pending[userId] = db.modmail.pending[userId] || { messages: [], createdAt: Date.now() };
              db.modmail.pending[userId].messages.push({ text: message.content || '', attachments, at: Date.now() });
              saveDB();
              await message.channel.send('We received your message, but could not deliver it to staff. Please try again later.').catch(() => {});
            } else {
              // Successfully forwarded, react with ✅ on user's DM message
              try { await message.react('✅').catch(() => {}); } catch (e) {}
              await updateSticky(onlyChannelId).catch(() => {});
            }
          } catch (e) {
            console.warn('Forwarding DM to modmail channel failed', e);
            await notifyStaff(e, { module: 'modmail.forwardDM', userId });
            db.modmail.pending[userId] = db.modmail.pending[userId] || { messages: [], createdAt: Date.now() };
            db.modmail.pending[userId].messages.push({ text: message.content || '', attachments, at: Date.now(), messageId: message.id });
            saveDB();
            await message.channel.send('We received your message, but could not deliver it to staff. Please try again later.').catch(() => {});
          }
        } else {
          db.modmail.pending[userId] = db.modmail.pending[userId] || { messages: [], createdAt: Date.now() };
          db.modmail.pending[userId].messages.push({ text: message.content || '', attachments, at: Date.now(), messageId: message.id });
          saveDB();
          await message.channel.send('We cannot find your staff channel right now. Please press Talk to Staff to (re)create a ticket.').catch(() => {});
        }
        return;
      }

      // messages inside a guild channel (modmail channels)
      const ticket = db.modmail.byChannel[message.channel.id];
      if (ticket) {
        const attachments = message.attachments && message.attachments.size ? Array.from(message.attachments.values()).map(a => a.url) : [];

        // record message always
        ticket.messages.push({ who: `Staff ${message.author.tag}`, at: Date.now(), text: message.content || '', attachments });
        saveDB();

        // if not staff, do nothing
        const member = message.member;
        if (!member || !isStaff(member)) return;

        // check if message starts with = (but not = ) - internal staff note, don't forward
        const msgContent = message.content || '';
        if (msgContent.startsWith('=') && !msgContent.startsWith('= ')) {
          // internal staff note, don't forward to user, but still recorded in transcript
          return;
        }

        // staff wrote, forward to user's DM and react with ✅ on staff message on success
        const userObj = await client.users.fetch(ticket.userId).catch(() => null);
        if (!userObj) {
          // can't fetch user, react with ❗ and notify staff
          try { await message.react('❗').catch(() => {}); } catch {}
          await notifyStaff(new Error('Could not fetch modmail user'), { module: 'modmail.forwardStaffMessage', userId: ticket.userId, channelId: message.channel.id });
          return;
        }

        try {
          const dmPayload = {};
          if (ticket.anonymousMods) {
            dmPayload.content = `Staff reply: ${message.content || ''}`;
          } else {
            const body = (message.content || '').trim();
            const staffEmbed = new EmbedBuilder()
              .setAuthor({ name: `${message.author.tag}`, iconURL: message.author.displayAvatarURL?.() })
              .setTimestamp();
            if (body) staffEmbed.setDescription(body);
            else if (attachments.length) staffEmbed.setDescription('(attachment)');
            else staffEmbed.setDescription('(no text)');
            dmPayload.embeds = [staffEmbed];
          }
          if (attachments.length) dmPayload.files = attachments.slice();

          const dmSent = await userObj.send(dmPayload).catch(err => ({ __failed: true, error: err }));
          if (dmSent && dmSent.__failed) {
            console.warn('Failed to DM user with staff message', dmSent.error);
            // react with ❌ to indicate failure, and notify staff via notifyStaff helper
            try { await message.react('❌').catch(() => {}); } catch {}
            await notifyStaff(dmSent.error || new Error('Failed to DM user'), { module: 'modmail.forwardStaffMessage', userId: ticket.userId, staffId: message.author.id });
            // also log to transcript channel best-effort
            try {
              const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
              const transcriptCh = guild ? await guild.channels.fetch(MODMAIL_TRANSCRIPTS_CHANNEL_ID).catch(() => null) : null;
              if (transcriptCh) {
                await transcriptCh.send(`Could not deliver staff message to user ${ticket.userId} for modmail-${ticket.id}. Staff message by ${message.author.tag}: ${message.content || '(no text)'}`).catch(() => {});
              }
            } catch (e) { /* ignore */ }
          } else {
            // success, react with check mark
            try { await message.react('✅').catch(async (e) => { /* if react fails, fallback to a small notice */ await message.channel.send('Message forwarded to user, but I could not add reaction.').catch(() => {}); }); } catch (e) {}
          }
        } catch (e) {
          console.warn('Failed to DM user', e);
          try { await message.react('❌').catch(() => {}); } catch {}
          await notifyStaff(e, { module: 'modmail.forwardStaffMessage', userId: ticket.userId, staffId: message.author.id });
        }

        // update sticky in staff channel
        try { await updateSticky(ticket.channelId); } catch (e) { /* ignore */ }
        return;
      }

    } catch (e) {
      console.warn('modmail messageCreate error', e);
      await notifyStaff(e, { module: 'modmail.messageCreate' });
    }
  });

  // DM-button interactions
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      const id = interaction.customId;

      if (id.startsWith('mm_close_dm|')) {
        // Disabled: users can no longer close modmail tickets from DM
        return safeReply(interaction, { content: 'Closing tickets via DM is disabled. Please ask staff to close the ticket for you.', ephemeral: true });
      }

      if (id.startsWith('mm_ping_dm|')) {
        const channelId = id.split('|')[1];
        const ticket = db.modmail.byChannel[channelId];
        if (!ticket) return safeReply(interaction, { content: 'Ticket not found.', ephemeral: true });
        if (interaction.user.id !== ticket.userId) return safeReply(interaction, { content: 'Only the ticket owner can ping staff.', ephemeral: true });

        const DAY = 24 * 60 * 60 * 1000;
        if (ticket.lastPingAt && Date.now() - ticket.lastPingAt < DAY) {
          return safeReply(interaction, { content: 'Ping already used in the last 24 hours.', ephemeral: true });
        }
        ticket.lastPingAt = Date.now();
        saveDB();
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) {
          try { await ch.send({ content: getStaffRoleIds().map(r => `<@&${r}>`).join(' ') + ' User requested a ping' }).catch(() => {}); } catch (e) {}
        }
        return safeReply(interaction, { content: 'Staff pinged, please wait for a reply.', ephemeral: true });
      }
    } catch (e) {
      console.warn('modmail DM-button handler error', e);
      await notifyStaff(e, { module: 'modmail.dmButtonHandler' });
      try { if (interaction && !interaction.replied) await safeReply(interaction, { content: 'Action failed', ephemeral: true }); } catch {}
    }
  });

  // handle modmail close modal submit
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId) return;
      if (interaction.customId.startsWith('mm_close_modal|')) {
        const channelId = interaction.customId.split('|')[1];
        const ticket = db.modmail.byChannel[channelId];
        if (!ticket) return safeReply(interaction, { content: 'Ticket not found.', ephemeral: true });
        if (!isStaff(interaction.member)) return safeReply(interaction, { content: 'Only staff can close chat.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const reason = interaction.fields.getTextInputValue('mm_close_reason') || '(no reason provided)';

        try {
          await postTranscript(ticket, `${interaction.user.tag} (staff)`);
          try { const u = await client.users.fetch(ticket.userId).catch(() => null); if (u) await u.send(`Your staff conversation (Ticket #${ticket.id}) has been closed by staff. Transcript saved.`).catch(() => {}); } catch (e) {}
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (ch) {
            try { await ch.send('Chat closed by staff, deleting channel...').catch(() => {}); await ch.delete('Modmail closed by staff'); } catch (e) { try { await ch.permissionOverwrites.edit(ticket.userId, { ViewChannel: false, SendMessages: false }); } catch {} }
          }
          // delete DM control message if present
          try { const u = await client.users.fetch(ticket.userId).catch(()=>null); if (u && ticket.dmControlMessageId) { const dm = await u.createDM().catch(()=>null); if (dm) { const m = await dm.messages.fetch(ticket.dmControlMessageId).catch(()=>null); if (m) await m.delete().catch(()=>{}); } } } catch(e){}

          delete db.modmail.byChannel[channelId];
          // remove mapping for this user+purpose
          try {
            const uid = ticket.userId;
            const pKey = ticket.purpose || 'unknown';
            if (db.modmail.byUser && db.modmail.byUser[uid] && typeof db.modmail.byUser[uid] === 'object') {
              delete db.modmail.byUser[uid][pKey];
              if (Object.keys(db.modmail.byUser[uid]).length === 0) delete db.modmail.byUser[uid];
            } else if (db.modmail.byUser && typeof db.modmail.byUser[uid] === 'string') {
              delete db.modmail.byUser[uid];
            }
          } catch (e) {}
          saveDB();

          try { await interaction.editReply({ content: 'Conversation closed and transcript posted.', ephemeral: true }); } catch (e) {}
        } catch (e) {
          console.warn('mm_close_modal failed', e);
          await notifyStaff(e, { module: 'modmail.mm_close_modal', userId: ticket.userId });
          try { await interaction.editReply({ content: 'Failed to close conversation, staff notified.', ephemeral: true }); } catch (err) {}
        }
      }
    } catch (e) {
      console.warn('modmail modal handler error', e);
      await notifyStaff(e, { module: 'modmail.modalHandler' });
    }
  });

  // expose helper for index.js if needed
  db._modmail_helpers = db._modmail_helpers || {};
  db._modmail_helpers.updateSticky = updateSticky;
  db._modmail_helpers.sendOrUpdateUserControl = sendOrUpdateUserControl;

  console.log('modmail initialized');
}
