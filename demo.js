/**
 * demo.js
 * Craig-style VC audio recorder module for index.js
 * Node 20+, discord.js v14, @discordjs/voice
 *
 * Expose default initDemo(client)
 * Implements multi-track recording where each speaking user is recorded to their own .opus file
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  ChannelType,
  EmbedBuilder,
  PermissionsBitField
} from 'discord.js';

import { generateAuthToken } from './webserver.js';

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  EndBehaviorType,
  getVoiceConnection,
  AudioReceiveStream
} from '@discordjs/voice';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  GUILD_ID,
  STAFF_ROLE_ID,
  STAFF_CHAT_ID,
  SERVER_HOST
} = process.env;

// Cross-platform ffprobe command
const ffprobeCmd = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

// Active recording sessions: recordingId -> { connection, channel, streams, metadata, ... }
const activeRecordings = new Map();

// Metadata file path
const METADATA_FILE = path.join(__dirname, 'recordings', 'metadata.json');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Load metadata
function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = fs.readFileSync(METADATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('Failed to load metadata.json', e);
  }
  return {};
}

// Save metadata
function saveMetadata(metadata) {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save metadata.json', e);
  }
}

// Get staff role IDs (same pattern as modmail.js)
function getStaffRoleIds() {
  return (STAFF_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Check if user is staff
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

// Check if user is tutor assigned to student (requires db access)
function isTutorForStudent(userId, studentId, db) {
  try {
    const assignment = db?.studentAssignments?.[studentId];
    return assignment && String(assignment.tutorId) === String(userId);
  } catch { return false; }
}

// Generate secure random delete key
function generateDeleteKey() {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').substring(0, 16);
}

// Command registration is handled by index.js's registerCommands() function

// Create temporary voice channel
async function createTempVoiceChannel(guild, studentId, tutorId, staffRoleIds, botUserId) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
    { id: botUserId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ManageChannels] }
  ];

  // Allow student
  overwrites.push({ id: studentId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] });

  // Allow tutor
  if (tutorId) {
    overwrites.push({ id: tutorId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] });
  }

  // Allow staff roles
  for (const rid of staffRoleIds) {
    if (rid) {
      overwrites.push({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] });
    }
  }

  const channel = await guild.channels.create({
    name: `demo-${Date.now().toString().slice(-6)}`,
    type: ChannelType.GuildVoice,
    permissionOverwrites: overwrites
  });

  return channel;
}

// Start recording for a user (creates raw frame dump file)
async function startUserRecording(recordingId, userId, recordingDir) {
  // Use .raw extension for raw Opus frame dumps
  const filePath = path.join(recordingDir, `${userId}.raw`);
  
  // If controller already exists, return it
  const session = activeRecordings.get(recordingId);
  if (session && session.userRecordings[userId] && session.userRecordings[userId].controller) {
    console.log(`[DEMO ${recordingId}] Recording controller already exists for user ${userId}`);
    return session.userRecordings[userId];
  }

  console.log(`[DEMO ${recordingId}] 🎬 Creating raw frame dump for user ${userId}`);
  console.log(`[DEMO ${recordingId}] Output file: ${filePath}`);
  
  // Ensure recording directory exists
  try {
    if (!fs.existsSync(recordingDir)) {
      fs.mkdirSync(recordingDir, { recursive: true });
      console.log(`[DEMO ${recordingId}] Created recording directory: ${recordingDir}`);
    }
  } catch (dirError) {
    console.error(`[DEMO ${recordingId}] ❌ Failed to create recording directory:`, dirError);
    throw dirError;
  }

  const startedAt = Date.now();
  
  // Create write stream for raw frame dumps
  // Format: [uint16 frameLength][frameData][uint32 timestampLow][uint32 timestampHigh] repeated
  // timestampLow = timestamp & 0xFFFFFFFF
  // timestampHigh = timestamp >>> 32
  // Reconstruct: timestamp = timestampLow + timestampHigh * 2**32
  const writeStream = fs.createWriteStream(filePath, { flags: 'w', autoClose: false });
  
  // Add error handler to catch write errors early
  writeStream.on('error', (error) => {
    console.error(`[DEMO ${recordingId}] ❌ Write stream error for user ${userId}:`, error);
    console.error(`[DEMO ${recordingId}]   Error details:`, error.message, error.code, error.path);
  });
  
  writeStream.on('open', () => {
    console.log(`[DEMO ${recordingId}] ✅ Raw dump file opened for user ${userId}: ${filePath}`);
  });
  
  writeStream.on('ready', () => {
    console.log(`[DEMO ${recordingId}] ✅ Write stream ready for user ${userId}`);
  });
  
  writeStream.on('close', () => {
    console.log(`[DEMO ${recordingId}] Write stream closed for user ${userId}`);
  });
  
  writeStream.on('drain', () => {
    console.log(`[DEMO ${recordingId}] Write stream drained for user ${userId}`);
  });
  
  // Track pending writes (like CraigBot's queue approach)
  let pendingWrites = 0;
  const writeQueue = [];
  let isProcessingQueue = false;
  let controllerStopped = false;
  
  // Process write queue (similar to CraigBot's fastq approach)
  async function processWriteQueue(stream, stopped) {
    if (isProcessingQueue || writeQueue.length === 0 || stopped) return;
    
    isProcessingQueue = true;
    
    while (writeQueue.length > 0 && !stopped && stream.writable) {
      const item = writeQueue.shift();
      if (!item) break;
      
        try {
        const writeResult = stream.write(item.buffer);
        if (!writeResult) {
          // Wait for drain before continuing
          await new Promise((resolve) => {
            stream.once('drain', resolve);
          });
        }
        item.resolve();
        pendingWrites--;
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
        pendingWrites--;
        }
      }
    
    isProcessingQueue = false;
  }

  // Return controller object
  const controller = {
    writeStream,
    filePath,
    startedAt,
    stopped: false,
    bytesWritten: 0,
    packetsWritten: 0,
    writeQueue: (buffer) => {
      return new Promise((resolve, reject) => {
        if (controller.stopped || !writeStream.writable) {
          reject(new Error('Stream is stopped or not writable'));
          return;
        }
        pendingWrites++;
        writeQueue.push({ buffer, resolve, reject });
        processWriteQueue(writeStream, controller.stopped).catch(reject);
      });
    },
    waitForWrites: async () => {
      while (pendingWrites > 0 || writeQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await processWriteQueue(writeStream, controller.stopped);
    }
  };

  return {
    userId,
    filePath,
    controller,
    startedAt
  };
}

// Validate raw dump file (check file exists and has valid structure)
async function validateRawDumpFile(filePath, recordingId, userId) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'File does not exist' };
    }

    const stats = fs.statSync(filePath);
    if (stats.size < 6) {
      return { valid: false, error: `File too small: ${stats.size} bytes (minimum 6 bytes for one frame)` };
    }

    // Read first frame to validate structure: [uint16 length][frameData][uint32 timestampLow][uint32 timestampHigh]
    const fileBuffer = fs.readFileSync(filePath, { start: 0, end: Math.min(100, stats.size - 1) });
    
    if (fileBuffer.length < 10) {
      return { valid: false, error: 'File too small to contain a complete frame (need at least 10 bytes)' };
    }
    
    // Read frame length (first 2 bytes, little-endian)
    const frameLength = fileBuffer.readUInt16LE(0);
    
    // Validate frame length is reasonable (Opus frames are typically 1-4000 bytes)
    if (frameLength === 0 || frameLength > 4000) {
      console.warn(`[DEMO ${recordingId}] ⚠️ Suspicious frame length for user ${userId}: ${frameLength} bytes`);
      }

    // Check if file has enough data for complete first frame
    // Format: 2 bytes length + frameData + 4 bytes timestampLow + 4 bytes timestampHigh
    const minSizeForFirstFrame = 2 + frameLength + 8; // length + frame + timestampLow + timestampHigh
    if (stats.size < minSizeForFirstFrame) {
      return { valid: false, error: `File too small: ${stats.size} bytes, need at least ${minSizeForFirstFrame} for first frame` };
    }

    console.log(`[DEMO ${recordingId}] ✅ Raw dump file validation PASSED for user ${userId}: ${stats.size} bytes, first frame length: ${frameLength} bytes`);
    return {
      valid: true,
      fileSize: stats.size,
      firstFrameLength: frameLength
    };
  } catch (e) {
    console.error(`[DEMO ${recordingId}] Error validating raw dump file for user ${userId}:`, e);
    return { valid: false, error: e.message };
  }
}


// Stop recording for a user (closes raw dump stream)
async function stopUserRecording(userRecording) {
  if (!userRecording) {
    return;
  }

    const controller = userRecording.controller;
  if (!controller || !controller.writeStream || controller.stopped) {
        return;
      }

  const userId = userRecording.userId;
  console.log(`[DEMO] 🛑 Closing raw dump stream for user ${userId}`);
  console.log(`[DEMO]   Stream state before close: destroyed=${controller.writeStream?.destroyed}, writable=${controller.writeStream?.writable}`);

  try {
    controller.stopped = true;
    
    // Wait for all pending writes to complete (like CraigBot's queue approach)
    console.log(`[DEMO] ⏳ Waiting for pending writes to complete for user ${userId}...`);
        try {
      await controller.waitForWrites();
      console.log(`[DEMO] ✅ All pending writes completed for user ${userId}`);
        } catch (e) {
      console.warn(`[DEMO] ⚠️ Error waiting for writes:`, e);
      }

    // Close the write stream
    return new Promise((resolve, reject) => {
      const writeStream = controller.writeStream;
      
      if (!writeStream) {
        console.warn(`[DEMO] ⚠️ Write stream is null for user ${userId}, nothing to close`);
        resolve();
        return;
      }
      
      // Log final stats before closing
      console.log(`[DEMO] 📊 Final stats before close for user ${userId}: ${controller.bytesWritten} bytes, ${controller.packetsWritten} packets`);
      
      // Check actual file size before closing
      try {
        if (fs.existsSync(controller.filePath)) {
          const stats = fs.statSync(controller.filePath);
          console.log(`[DEMO]   File size on disk before close: ${stats.size} bytes`);
          if (stats.size !== controller.bytesWritten) {
            console.warn(`[DEMO] ⚠️ File size mismatch before close! Controller says ${controller.bytesWritten} bytes, file has ${stats.size} bytes`);
                }
              }
          } catch (e) {
        console.warn(`[DEMO] Could not check file size before close:`, e);
      }
      
      // Set a timeout to prevent hanging
      const timeout = setTimeout(() => {
        console.warn(`[DEMO] ⚠️ Stream close timeout for user ${userId}, forcing close`);
        if (!writeStream.destroyed) {
          writeStream.destroy();
        }
        resolve();
      }, 5000);
      
      writeStream.on('finish', () => {
        clearTimeout(timeout);
        console.log(`[DEMO] ✅ Raw dump stream closed for user ${userId}: ${controller.bytesWritten} bytes, ${controller.packetsWritten} packets`);
        resolve();
      });

      writeStream.on('error', (error) => {
            clearTimeout(timeout);
        console.error(`[DEMO] ❌ Error closing stream for user ${userId}:`, error);
        reject(error);
      });
      
      // End the stream (this will flush and close)
      writeStream.end(() => {
        clearTimeout(timeout);
        console.log(`[DEMO] ✅ Write stream end() callback for user ${userId}`);
      });
    });
  } catch (error) {
    console.error(`[DEMO] ❌ Error closing recording for user ${userId}:`, error);
    throw error;
  }
}

// Subscribe to user's Opus audio stream
async function subscribeUserOpus(recordingId, userId, session) {
  try {
    // Check if already subscribed
    if (session.userRecordings[userId] && session.userRecordings[userId].audioStream) {
      console.log(`[DEMO ${recordingId}] User ${userId} already subscribed, skipping`);
      return;
    }

    console.log(`[DEMO ${recordingId}] 🎙️ Subscribing to Opus stream for user ${userId}`);

    // Check receiver exists
    if (!session.connection || !session.connection.receiver) {
      throw new Error('Connection receiver not available');
    }

    const receiver = session.connection.receiver;
    console.log(`[DEMO ${recordingId}] Receiver present: ${!!receiver}`);

    // Get or create user recording controller
    let userRec = session.userRecordings[userId];
    if (!userRec || !userRec.controller) {
      console.log(`[DEMO ${recordingId}] Creating new recording controller for user ${userId}`);
      try {
        userRec = await startUserRecording(recordingId, userId, session.recordingDir);
        session.userRecordings[userId] = userRec;
        
        // Log file path
        console.log(`[DEMO ${recordingId}] 📁 Created raw dump file: ${userRec.filePath}`);
      } catch (e) {
        console.error(`[DEMO ${recordingId}] ❌ Failed to start recording for user ${userId}:`, e);
        // Write warning file as fallback
        const warningPath = path.join(session.recordingDir, `${userId}.error.txt`);
        fs.writeFileSync(warningPath, `Failed to start raw dump writer: ${e.message}\n`, 'utf8');
        throw e;
      }
    }

    // Skip if already processing or stopped
    if (userRec.controller.stopped) {
      console.log(`[DEMO ${recordingId}] Recording already stopped for user ${userId}`);
      return;
    }

    // Subscribe to audio stream in Opus mode (raw Opus packets)
    console.log(`[DEMO ${recordingId}] Creating Opus subscription for user ${userId}`);
    const audioStream = receiver.subscribe(userId, {
      mode: 'opus',
      end: {
        behavior: EndBehaviorType.Manual // Keep stream open until user leaves
      }
    });

    console.log(`[DEMO ${recordingId}] ✅ Subscription created for user ${userId}`);

    // Store stream reference
    userRec.audioStream = audioStream;

    // Track packets and bytes for diagnostics
    let packetsReceived = 0;
    let bytesWritten = 0;
    let firstPacketReceived = false;
    const controller = userRec.controller;

    // Write Opus packets directly to raw dump file
    // CRITICAL: Packets come directly from Discord receiver.subscribe(..., { mode: 'opus' })
    // Do NOT modify, concatenate, pad, or transform these packets
        // Format: [uint16 frameLength][frameData][uint32 timestampLow][uint32 timestampHigh]
    audioStream.on('data', (packet) => {
      try {
        // Ensure packet is a Buffer (should always be from Discord)
        if (!Buffer.isBuffer(packet)) {
          console.error(`[DEMO ${recordingId}] ❌ Packet is not a Buffer for user ${userId}`);
          return;
        }
        
        // Validate packet has content (empty packets cause decode errors)
        if (packet.length === 0) {
          console.warn(`[DEMO ${recordingId}] ⚠️ Skipping empty packet for user ${userId}`);
          return;
        }
        
        // Validate minimum Opus packet size (at least 1 byte for TOC)
        if (packet.length < 1) {
          console.warn(`[DEMO ${recordingId}] ⚠️ Packet too small (${packet.length} bytes) for user ${userId}, skipping`);
          return;
        }
        
        // Validate Opus TOC byte format (first byte should have valid structure)
        // Opus TOC byte: bits 0-2 are config (0-7), bit 3 is stereo, bits 4-7 are frame count
        // Invalid: all zeros or all 0xFF might indicate corrupted data
        const tocByte = packet[0];
        if (tocByte === 0x00 && packet.length <= 3) {
          // This might be a comfort noise frame (CNG), but we'll let the browser handle it
          // For now, we still write it
        }
        
        if (!firstPacketReceived) {
          firstPacketReceived = true;
          packetsReceived = 1;
          bytesWritten = packet.length;
          console.log(`[DEMO ${recordingId}] 🎵 First Opus packet received for user ${userId}, size: ${packet.length} bytes`);
          console.log(`[DEMO ${recordingId}]   Packet source: Direct from Discord receiver.subscribe(..., { mode: 'opus' })`);
          console.log(`[DEMO ${recordingId}]   First 16 bytes (hex): ${packet.slice(0, Math.min(16, packet.length)).toString('hex').toUpperCase()}`);
          // Log TOC byte for diagnostics
          const config = tocByte & 0x03;
          const stereo = (tocByte & 0x04) >> 3;
          const frameCountCode = (tocByte & 0xF0) >> 4;
          console.log(`[DEMO ${recordingId}]   TOC byte: 0x${tocByte.toString(16).toUpperCase().padStart(2, '0')} (config=${config}, stereo=${stereo}, frameCountCode=${frameCountCode})`);
      } else {
          packetsReceived++;
          bytesWritten += packet.length;
          // Log every 10th packet to track progress without spam
          if (packetsReceived % 10 === 0) {
            console.log(`[DEMO ${recordingId}] 📦 Packet ${packetsReceived} received for user ${userId}, total bytes: ${bytesWritten}`);
          }
        }
        
        // Write raw frame dump format: [uint16 frameLength][frameData][uint32 timestampLow][uint32 timestampHigh]
        
        // Validate frame length (must fit in uint16: 0-65535, and must be > 0)
        const frameLength = packet.length;
        if (frameLength === 0) {
          console.warn(`[DEMO ${recordingId}] ⚠️ Frame length is 0 for user ${userId}, skipping`);
          return;
        }
        if (frameLength > 65535) {
          console.warn(`[DEMO ${recordingId}] ⚠️ Frame length ${frameLength} exceeds uint16 max (65535), skipping frame for user ${userId}`);
          return;
        }
        
        // Frame length (2 bytes, little-endian)
        const frameLengthBuffer = Buffer.allocUnsafe(2);
        frameLengthBuffer.writeUInt16LE(frameLength, 0);
        
        // Timestamp as 64-bit split into two uint32 values (little-endian)
        // Use BigInt for precise bitwise operations, then convert to Number for Buffer writes
        // This handles Discord RTP timestamps which can exceed uint32 max value
        const timestamp = Date.now();
        const ts = BigInt(timestamp);
        const low = Number(ts & 0xFFFFFFFFn);
        const high = Number(ts >> 32n);
        
        // Validate that low and high fit in uint32 (should always be true after masking, but check anyway)
        if (low < 0 || low > 0xFFFFFFFF || high < 0 || high > 0xFFFFFFFF) {
          console.error(`[DEMO ${recordingId}] ❌ Invalid timestamp split: low=${low}, high=${high} for user ${userId}`);
          return;
        }
        
        const timestampBuffer = Buffer.allocUnsafe(8);
        timestampBuffer.writeUInt32LE(low, 0);
        timestampBuffer.writeUInt32LE(high, 4);
        
        // Write: [frameLength][frameData][timestampLow][timestampHigh]
        const writeStream = controller.writeStream;
        if (!writeStream) {
          console.error(`[DEMO ${recordingId}] ❌ Write stream is null for user ${userId}`);
          return;
        }
        
        if (writeStream.destroyed) {
          console.error(`[DEMO ${recordingId}] ❌ Write stream is destroyed for user ${userId}`);
          return;
        }
        
        if (controller.stopped) {
          console.warn(`[DEMO ${recordingId}] ⚠️ Attempted write after recording stopped for user ${userId}`);
          return;
        }
        
        // Check if stream is writable and ready
        if (!writeStream.writable) {
          console.error(`[DEMO ${recordingId}] ❌ Write stream is not writable for user ${userId}`);
          console.error(`[DEMO ${recordingId}]   Stream state: destroyed=${writeStream.destroyed}, writable=${writeStream.writable}`);
          return;
        }
        
        // CRITICAL FIX: Write all three parts atomically as a single buffer
        // This ensures the frame is never partially written if backpressure occurs
        // Format: [frameLength][packet][timestampLow][timestampHigh]
        const frameBuffer = Buffer.concat([frameLengthBuffer, packet, timestampBuffer]);
        const totalFrameSize = frameBuffer.length;
        
        // Queue the write (like CraigBot's approach with fastq)
        // This ensures writes are serialized and complete before stream closes
        // Don't await - queue synchronously, processor handles async
        controller.writeQueue(frameBuffer).then(() => {
          // Update controller stats only after successful write
          controller.packetsWritten = packetsReceived;
          controller.bytesWritten += totalFrameSize;
          
          // Log first few successful writes
          if (packetsReceived <= 3) {
            console.log(`[DEMO ${recordingId}] ✅ Frame ${packetsReceived} written for user ${userId}: ${totalFrameSize} bytes, total: ${controller.bytesWritten} bytes`);
            if (packetsReceived === 1) {
              console.log(`[DEMO ${recordingId}]   Write stream state: writable=${writeStream.writable}, destroyed=${writeStream.destroyed}`);
              console.log(`[DEMO ${recordingId}]   Frame breakdown: length=${frameLengthBuffer.length}, packet=${packet.length}, timestamp=${timestampBuffer.length}, total=${totalFrameSize}`);
            }
          }
        }).catch((writeError) => {
          console.error(`[DEMO ${recordingId}] ❌ Exception during write for user ${userId}:`, writeError);
          console.error(`[DEMO ${recordingId}]   Error stack:`, writeError.stack);
          console.error(`[DEMO ${recordingId}]   Stream state: writable=${writeStream.writable}, destroyed=${writeStream.destroyed}`);
        });
      } catch (error) {
        console.error(`[DEMO ${recordingId}] ❌ Error writing Opus packet for user ${userId}:`, error);
        console.error(`[DEMO ${recordingId}]   Error stack: ${error.stack}`);
      }
    });

    // Error handler
    audioStream.on('error', (err) => {
      console.warn(`[DEMO ${recordingId}] ⚠️ Audio stream error for user ${userId}:`, err);
      console.warn(`[DEMO ${recordingId}]   Error details:`, err.message, err.code);
      console.warn(`[DEMO ${recordingId}]   Packets received before error: ${packetsReceived}, bytes: ${bytesWritten}`);
    });

    // End handler
    audioStream.on('end', () => {
      console.log(`[DEMO ${recordingId}] 🛑 Audio stream ENDED for user ${userId} (packets: ${packetsReceived}, bytes: ${bytesWritten})`);
      console.log(`[DEMO ${recordingId}]   Controller stats: ${controller.packetsWritten} packets written, ${controller.bytesWritten} bytes written`);
      console.log(`[DEMO ${recordingId}]   Stream destroyed: ${audioStream.destroyed}`);
      console.log(`[DEMO ${recordingId}]   Write stream state: destroyed=${controller.writeStream?.destroyed}, writable=${controller.writeStream?.writable}`);
    });

    // Smoke test: check packets received after 2 seconds
    setTimeout(() => {
      if (!firstPacketReceived) {
        console.warn(`[DEMO ${recordingId}] ⚠️ WARNING: No Opus packets received for user ${userId} after 2 seconds!`);
        // Check file size
        try {
          if (fs.existsSync(controller.filePath)) {
            const stats = fs.statSync(controller.filePath);
            console.warn(`[DEMO ${recordingId}] File size: ${stats.size} bytes`);
          }
        } catch (e) {
          console.warn(`[DEMO ${recordingId}] Could not check file:`, e);
        }
        console.warn(`[DEMO ${recordingId}] Audio stream state: destroyed=${audioStream.destroyed}`);
      } else {
        console.log(`[DEMO ${recordingId}] ✅ Smoke test passed for user ${userId}: ${packetsReceived} packets, ${bytesWritten} bytes in first 2 seconds`);
        console.log(`[DEMO ${recordingId}]   Controller stats: ${controller.packetsWritten} packets written, ${controller.bytesWritten} bytes written`);
        // Check actual file size on disk
        try {
          if (fs.existsSync(controller.filePath)) {
            const stats = fs.statSync(controller.filePath);
            console.log(`[DEMO ${recordingId}]   Actual file size on disk: ${stats.size} bytes`);
            if (stats.size !== controller.bytesWritten) {
              console.warn(`[DEMO ${recordingId}] ⚠️ File size mismatch! Expected ${controller.bytesWritten} bytes, got ${stats.size} bytes`);
            }
          }
        } catch (e) {
          console.warn(`[DEMO ${recordingId}] Could not check file size:`, e);
        }
      }
    }, 2000);

    // Additional check after 5 seconds to see if recording is still active
    setTimeout(() => {
      if (firstPacketReceived && !controller.stopped) {
        console.log(`[DEMO ${recordingId}] 📊 5-second check for user ${userId}: ${packetsReceived} packets, ${controller.packetsWritten} written, ${controller.bytesWritten} bytes`);
        try {
          if (fs.existsSync(controller.filePath)) {
            const stats = fs.statSync(controller.filePath);
            console.log(`[DEMO ${recordingId}]   File size on disk: ${stats.size} bytes`);
          }
        } catch (e) {
          console.warn(`[DEMO ${recordingId}] Could not check file:`, e);
        }
      }
    }, 5000);

    console.log(`[DEMO ${recordingId}] ✅ Successfully subscribed to user ${userId}`);
  } catch (e) {
    console.error(`[DEMO ${recordingId}] ❌ Error subscribing to user ${userId}:`, e);
    throw e;
  }
}

// Unsubscribe from user's Opus audio stream
async function unsubscribeUserOpus(recordingId, userId, session) {
  try {
    const userRec = session.userRecordings[userId];
    if (!userRec) {
      console.log(`[DEMO ${recordingId}] No recording found for user ${userId}, nothing to unsubscribe`);
      return;
    }

    console.log(`[DEMO ${recordingId}] 🛑 Unsubscribing from user ${userId}`);

    // Destroy audio stream if it exists
    if (userRec.audioStream) {
      console.log(`[DEMO ${recordingId}] Destroying audio stream for user ${userId}`);
      try {
        if (!userRec.audioStream.destroyed) {
          userRec.audioStream.destroy();
        }
      } catch (e) {
        console.warn(`[DEMO ${recordingId}] Error destroying audio stream for user ${userId}:`, e);
      }
      userRec.audioStream = null;
    }

    // Stop the recording (this will finalize OggWriter)
    await stopUserRecording(userRec);

    // Log final stats
    if (userRec.controller) {
      console.log(`[DEMO ${recordingId}] Final stats for user ${userId}: ${userRec.controller.bytesWritten} bytes, ${userRec.controller.packetsWritten} packets`);
    }

    console.log(`[DEMO ${recordingId}] ✅ Successfully unsubscribed from user ${userId}`);
  } catch (e) {
    console.error(`[DEMO ${recordingId}] ❌ Error unsubscribing from user ${userId}:`, e);
    throw e;
  }
}

// Cleanup recording session
async function cleanupRecording(recordingId, client) {
  const session = activeRecordings.get(recordingId);
  if (!session) return;

  try {
    // Stop all user recordings
    for (const userRec of Object.values(session.userRecordings || {})) {
      await stopUserRecording(userRec).catch(() => {});
    }

    // Destroy connection
    if (session.connection) {
      session.connection.destroy();
    }

    // Delete channel
    if (session.channel) {
      try {
        await session.channel.delete().catch(() => {});
      } catch (e) {
        console.warn(`Failed to delete channel ${session.channel.id}`, e);
      }
    }

    activeRecordings.delete(recordingId);
  } catch (e) {
    console.error(`Error cleaning up recording ${recordingId}`, e);
  }
}

// Handle voice state updates to detect when users join/leave
function setupVoiceStateHandlers(client) {
  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      // Log all voice state updates for debugging
      const userId = newState.member?.user?.id || oldState.member?.user?.id;
      const userName = newState.member?.user?.tag || oldState.member?.user?.tag || 'unknown';
      const newChannelId = newState.channel?.id;
      const oldChannelId = oldState.channel?.id;
      
      console.log(`[DEMO] Voice state update - User: ${userName} (${userId}), Old channel: ${oldChannelId}, New channel: ${newChannelId}`);
      
      // Check all active recordings
      for (const [recordingId, session] of activeRecordings.entries()) {
        if (!session.channel) continue;
        
        // Check if this update is relevant to our recording channel
        const isRelevant = (newChannelId === session.channel.id) || (oldChannelId === session.channel.id);
        
        if (!isRelevant) {
          continue;
        }

        console.log(`[DEMO ${recordingId}] ✅ Voice state update detected for our channel!`);

        // Check if a non-bot user just joined (not left)
        const userJustJoined = newState.channel && newState.channel.id === session.channel.id && 
                               (!oldState.channel || oldState.channel.id !== session.channel.id) &&
                               !newState.member?.user.bot;
        const userJustLeft = oldState.channel && oldState.channel.id === session.channel.id &&
                             (!newState.channel || newState.channel.id !== session.channel.id);

        // Subscribe to user when they join (only if recording has started)
        if (userJustJoined) {
          const joinedUser = newState.member?.user;
          const joinedUserId = joinedUser?.id;
          
          console.log(`[DEMO ${recordingId}] 🎉 USER JOINED: ${joinedUser?.tag || joinedUserId} (ID: ${joinedUserId})`);
          console.log(`[DEMO ${recordingId}] Is student? ${joinedUserId === session.metadata.studentId}`);
          console.log(`[DEMO ${recordingId}] Is tutor? ${joinedUserId === session.metadata.tutorId}`);
          
          // Skip bot users
          if (!joinedUser || joinedUser.bot) {
            console.log(`[DEMO ${recordingId}] Skipping bot user ${joinedUserId}`);
            continue;
          }

          // Only subscribe if recording has started
          if (session.recordingStarted) {
            console.log(`[DEMO ${recordingId}] Recording active - subscribing to user ${joinedUserId}`);
            try {
              await subscribeUserOpus(recordingId, joinedUserId, session);
            } catch (e) {
              console.error(`[DEMO ${recordingId}] Failed to subscribe to user ${joinedUserId}:`, e);
              await notifyStaff(e, { recordingId, module: 'demo.subscribeUser', userId: joinedUserId, client });
            }
          } else {
            console.log(`[DEMO ${recordingId}] Recording not started yet - user ${joinedUserId} will be subscribed when recording begins`);
          }
        }

        // Unsubscribe from user when they leave (if they were being recorded)
        if (userJustLeft) {
          const leftUser = oldState.member?.user;
          const leftUserId = leftUser?.id;
          
          console.log(`[DEMO ${recordingId}] 👋 USER LEFT: ${leftUser?.tag || leftUserId} (ID: ${leftUserId})`);
          
          // Stop recording for this user if they were being recorded
          if (session.userRecordings[leftUserId]) {
            try {
              await unsubscribeUserOpus(recordingId, leftUserId, session);
            } catch (e) {
              console.error(`[DEMO ${recordingId}] Failed to unsubscribe from user ${leftUserId}:`, e);
            }
          } else {
            console.log(`[DEMO ${recordingId}] User ${leftUserId} was not being recorded, nothing to unsubscribe`);
          }
        }

        const channel = session.channel;
        
        // Get fresh member list from the channel
        // Use the channel's members collection which should be up-to-date
        const members = channel.members;
        
        // Also try to fetch the channel to ensure members are fresh
        try {
          const freshChannel = await channel.guild.channels.fetch(channel.id);
          if (freshChannel && freshChannel.members) {
            // Update our reference
            const freshMembers = freshChannel.members;
            console.log(`[DEMO ${recordingId}] Fresh channel members: ${Array.from(freshMembers.keys()).join(', ')}`);
          }
        } catch (e) {
          console.log(`[DEMO ${recordingId}] Could not fetch fresh channel: ${e.message}`);
        }

        // Count non-bot users (excluding the bot itself)
        const nonBotMembers = Array.from(members.values()).filter(m => !m.user.bot);
        
        // Check if student and tutor are both in the channel
        const studentInChannel = members.has(session.metadata.studentId);
        const tutorInChannel = session.metadata.tutorId ? members.has(session.metadata.tutorId) : true; // If no tutor assigned, consider it "in channel"
        const bothUsersInChannel = studentInChannel && tutorInChannel;
        
        // Log all members for debugging
        const memberIds = Array.from(members.keys());
        const memberNames = Array.from(members.values()).map(m => `${m.user.tag} (${m.user.id})`).join(', ');
        console.log(`[DEMO ${recordingId}] Current members in channel (IDs): ${memberIds.join(', ')}`);
        console.log(`[DEMO ${recordingId}] Current members in channel (Names): ${memberNames}`);

        console.log(`[DEMO ${recordingId}] Channel check - Student ID: ${session.metadata.studentId}, Tutor ID: ${session.metadata.tutorId || 'none'}`);
        console.log(`[DEMO ${recordingId}] Student in channel: ${studentInChannel}, Tutor in channel: ${tutorInChannel}, Both in: ${bothUsersInChannel}`);
        console.log(`[DEMO ${recordingId}] Recording started: ${session.recordingStarted}, Announcement pending: ${session._announcementPending || false}, Connection exists: ${!!session.connection}`);

        // If both student and tutor are in channel and we haven't started recording, start the process
        // Check this on every update, not just when someone joins (in case both joined before we checked)
        if (bothUsersInChannel && !session.recordingStarted && session.connection && !session._announcementPending) {
          console.log(`[DEMO ${recordingId}] ✅ Both users detected! Starting announcement process...`);
          
          // Mark that we're starting the announcement process to prevent duplicate triggers
          session._announcementPending = true;
          
          console.log(`[DEMO ${recordingId}] Waiting 2 seconds for users to fully connect...`);
          // Wait 2 seconds for both users to fully connect
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Re-check after delay to ensure they're still connected
          const currentMembers = session.channel.members;
          const studentStillIn = currentMembers.has(session.metadata.studentId);
          const tutorStillIn = session.metadata.tutorId ? currentMembers.has(session.metadata.tutorId) : true;
          
          console.log(`[DEMO ${recordingId}] After 2s delay - Student still in: ${studentStillIn}, Tutor still in: ${tutorStillIn}`);
          
          if (!studentStillIn || !tutorStillIn) {
            console.log(`[DEMO ${recordingId}] ❌ Users left before announcement could play`);
            session._announcementPending = false; // Reset so we can try again if they rejoin
            return;
          }

          // Wait for connection to be ready if it's not already
          console.log(`[DEMO ${recordingId}] Connection status: ${session.connection.state.status}`);
          if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
            console.log(`[DEMO ${recordingId}] Waiting for connection to be ready...`);
            // Wait for connection to become ready (with timeout)
            try {
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  session.connection.off('stateChange', stateChangeHandler);
                  reject(new Error('Connection not ready within 15 seconds'));
                }, 15000);

                const stateChangeHandler = (oldState, newState) => {
                  console.log(`[DEMO ${recordingId}] Connection state changed: ${oldState.status} -> ${newState.status}`);
                  if (newState.status === VoiceConnectionStatus.Ready) {
                    clearTimeout(timeout);
                    session.connection.off('stateChange', stateChangeHandler);
                    resolve();
                  } else if (newState.status === VoiceConnectionStatus.Disconnected || 
                             newState.status === VoiceConnectionStatus.Destroyed) {
                    clearTimeout(timeout);
                    session.connection.off('stateChange', stateChangeHandler);
                    reject(new Error(`Connection failed: ${newState.status}`));
                  }
                };

                // Check if already ready
                if (session.connection.state.status === VoiceConnectionStatus.Ready) {
                  clearTimeout(timeout);
                  resolve();
                } else {
                  // Listen for state changes
                  session.connection.on('stateChange', stateChangeHandler);
                }
              });
              console.log(`[DEMO ${recordingId}] ✅ Connection is now ready`);
            } catch (e) {
              console.error(`[DEMO ${recordingId}] ❌ Failed to wait for connection ready: ${e.message}`);
              await notifyStaff(e, { recordingId, module: 'demo.waitForConnection', client });
              session._announcementPending = false;
              return;
            }
          } else {
            console.log(`[DEMO ${recordingId}] ✅ Connection already ready`);
          }

          session.recordingStarted = true;
          console.log(`[DEMO ${recordingId}] 🎙️ Starting recording...`);

          // Subscribe to all non-bot users currently in the channel immediately,
          // BEFORE the announcement plays so we do not miss early speech.
          console.log(`[DEMO ${recordingId}] ✅ Recording system ready - subscribing to existing users`);
          const existingMembers = session.channel.members;
          const subscribePromises = [];
          for (const [memberId, member] of existingMembers.entries()) {
            if (!member.user.bot && memberId !== client.user.id) {
              console.log(`[DEMO ${recordingId}] Subscribing to existing user: ${member.user.tag} (${memberId})`);
              subscribePromises.push(
                subscribeUserOpus(recordingId, memberId, session).catch((e) => {
                  console.error(`[DEMO ${recordingId}] Failed to subscribe to existing user ${memberId}:`, e);
                })
              );
            }
          }
          // Wait a moment for connection to stabilize, then ensure subscriptions complete
          await new Promise(resolve => setTimeout(resolve, 500));
          await Promise.all(subscribePromises);
          console.log(`[DEMO ${recordingId}] ✅ Subscribed to ${subscribePromises.length} existing user(s)`);

          // Play announcement (after we are already subscribing to users)
          try {
            const announcementPath = path.join(__dirname, 'announcement.wav');
            console.log(`[DEMO ${recordingId}] Looking for announcement at: ${announcementPath}`);
            if (fs.existsSync(announcementPath)) {
              console.log(`[DEMO ${recordingId}] ✅ Announcement file found, creating player...`);
              const player = createAudioPlayer();
              const resource = createAudioResource(announcementPath, {
                inputType: 'file'
              });
              
              console.log(`[DEMO ${recordingId}] Playing announcement...`);
              player.play(resource);
              session.connection.subscribe(player);

              // Wait for announcement to finish (listen for idle state or use a reasonable timeout)
              await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                  console.log(`[DEMO ${recordingId}] Announcement timeout (10s), stopping player`);
                  player.stop();
                  resolve();
                }, 10000); // Max 10 seconds

                player.once('stateChange', (oldState, newState) => {
                  console.log(`[DEMO ${recordingId}] Player state: ${oldState.status} -> ${newState.status}`);
                  if (newState.status === AudioPlayerStatus.Idle && oldState.status === AudioPlayerStatus.Playing) {
                    console.log(`[DEMO ${recordingId}] ✅ Announcement finished playing`);
                    clearTimeout(timeout);
                    resolve();
                  }
                });
              });
            } else {
              console.warn(`[DEMO ${recordingId}] ❌ Announcement file not found at ${announcementPath}`);
            }
          } catch (e) {
            console.error(`[DEMO ${recordingId}] ❌ Failed to play announcement:`, e);
          }
        }

        // If both student and tutor left, stop recording and cleanup
        const currentMembers = session.channel.members;
        const studentStillIn = currentMembers.has(session.metadata.studentId);
        const tutorStillIn = session.metadata.tutorId ? currentMembers.has(session.metadata.tutorId) : true; // If no tutor assigned, consider them "still in"
        
        // Both users left: student is gone AND (tutor is gone OR no tutor was assigned)
        const bothUsersLeft = !studentStillIn && !tutorStillIn;
        
        console.log(`[DEMO ${recordingId}] Cleanup check - Student still in: ${studentStillIn}, Tutor still in: ${tutorStillIn}, Both left: ${bothUsersLeft}`);
        
        if (bothUsersLeft && session.recordingStarted) {
          console.log(`[DEMO ${recordingId}] 🛑 Both users left, finalizing recording...`);
          await finalizeRecording(recordingId, client);
        }
      }
    } catch (e) {
      console.error('Error in voiceStateUpdate handler', e);
    }
  });
}

// Finalize recording: stop, save metadata, notify staff
async function finalizeRecording(recordingId, client) {
  const session = activeRecordings.get(recordingId);
  if (!session) return;

  // Prevent duplicate finalization
  if (session._finalizing || session._finalized) {
    console.log(`[DEMO ${recordingId}] Finalization already in progress or completed, skipping`);
    return;
  }

  session._finalizing = true;

  try {
    console.log(`[DEMO ${recordingId}] 🛑 Finalizing recording - stopping all user recordings`);
    
    // Unsubscribe from all users first
    const unsubscribePromises = [];
    for (const [userId, userRec] of Object.entries(session.userRecordings || {})) {
      if (userRec.audioStream) {
        unsubscribePromises.push(unsubscribeUserOpus(recordingId, userId, session).catch((e) => {
          console.warn(`[DEMO ${recordingId}] Error unsubscribing from user ${userId}:`, e);
        }));
      } else {
        // If no stream, just stop the recording
        unsubscribePromises.push(stopUserRecording(userRec).catch((e) => {
          console.warn(`[DEMO ${recordingId}] Error stopping recording for user ${userId}:`, e);
        }));
      }
    }
    
    // Wait for all recordings to stop (this closes all raw dump streams)
    await Promise.all(unsubscribePromises);
    console.log(`[DEMO ${recordingId}] ✅ All user recordings stopped`);
    
    // Validate all files
    const validationPromises = [];
    for (const [userId, userRec] of Object.entries(session.userRecordings || {})) {
      if (userRec.controller && userRec.controller.filePath) {
        validationPromises.push(
          (async () => {
            try {
              const filePath = userRec.controller.filePath;
              if (!fs.existsSync(filePath)) {
                console.warn(`[DEMO ${recordingId}] File does not exist for user ${userId}: ${filePath}`);
                return;
              }

              const stats = fs.statSync(filePath);
              console.log(`[DEMO ${recordingId}] 📊 File stats for user ${userId}: ${stats.size} bytes`);
              
              // Check for tiny files
              if (stats.size < 1024) {
                console.error(`[DEMO ${recordingId}] ❌ TINY FILE for user ${userId}: ${stats.size} bytes`);
                // Read first and last 128 bytes for diagnostics
                const fileBuffer = fs.readFileSync(filePath);
                const first128Bytes = fileBuffer.slice(0, 128);
                const last128Bytes = fileBuffer.slice(-128);
                console.error(`[DEMO ${recordingId}] First 128 bytes (hex): ${first128Bytes.toString('hex')}`);
                console.error(`[DEMO ${recordingId}] Last 128 bytes (hex): ${last128Bytes.toString('hex')}`);
                // Notify staff about tiny file
                await notifyStaff(new Error(`Tiny recording file for user ${userId}: ${stats.size} bytes`), {
                  recordingId,
                  module: 'demo.finalizeRecording.tinyFile',
                  userId,
                  client
                }).catch(() => {});
                return;
              }

              // Validate raw dump file
              const validation = await validateRawDumpFile(filePath, recordingId, userId);
              
              if (!validation.valid) {
                console.error(`[DEMO ${recordingId}] ❌ File validation FAILED for user ${userId}: ${validation.error}`);
                await notifyStaff(new Error(`File validation failed for user ${userId}: ${validation.error}`), {
                    recordingId,
                    module: 'demo.finalizeRecording.validation',
                    userId,
                    client
                  }).catch(() => {});
              } else {
                console.log(`[DEMO ${recordingId}] ✅ Raw dump file validation PASSED for user ${userId}`);
              }
              
              // Log bytes written
              if (userRec.controller.bytesWritten) {
                console.log(`[DEMO ${recordingId}] Total bytes written for user ${userId}: ${userRec.controller.bytesWritten}`);
              }
            } catch (e) {
              console.warn(`[DEMO ${recordingId}] Could not validate file for user ${userId}:`, e);
            }
          })()
        );
      }
    }

    // Wait for all validations to complete
    if (validationPromises.length > 0) {
      console.log(`[DEMO ${recordingId}] Validating ${validationPromises.length} file(s)...`);
      await Promise.all(validationPromises);
      console.log(`[DEMO ${recordingId}] ✅ All files validated`);
    }
    
    // Delay to ensure files are flushed to disk (500ms as requested)
    console.log(`[DEMO ${recordingId}] Waiting 500ms for file buffers to flush...`);
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(`[DEMO ${recordingId}] ✅ Buffer flush complete`);

    // Update metadata
    const metadata = loadMetadata();
    
    // Check if already saved (prevent duplicate notifications)
    if (metadata[recordingId] && metadata[recordingId]._notified) {
      console.log(`[DEMO ${recordingId}] Recording already finalized, skipping notification`);
      session._finalized = true;
      await cleanupRecording(recordingId, client);
      return;
    }

    const recordingMeta = {
      recordingId,
      title: session.metadata.title,
      tutorId: session.metadata.tutorId,
      studentId: session.metadata.studentId,
      createdAt: session.metadata.createdAt,
      filePath: session.recordingDir,
      deleteKey: session.metadata.deleteKey,
      userIds: Object.keys(session.userRecordings || {})
    };
    metadata[recordingId] = recordingMeta;
    saveMetadata(metadata);

    // Notify staff (only once)
    await notifyStaffRecording(recordingId, recordingMeta, client);
    
    // Mark as notified
    metadata[recordingId]._notified = true;
    saveMetadata(metadata);
    session._finalized = true;

    // Cleanup
    await cleanupRecording(recordingId, client);
  } catch (e) {
    console.error(`Error finalizing recording ${recordingId}`, e);
    await notifyStaff(e, { recordingId, module: 'demo.finalizeRecording' });
    await cleanupRecording(recordingId, client);
  }
}

// Notify staff about new recording
async function notifyStaffRecording(recordingId, metadata, client) {
  try {
    if (!STAFF_CHAT_ID) {
      console.warn('STAFF_CHAT_ID not set, cannot notify staff');
      return;
    }

    const channel = await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
    if (!channel) {
      console.warn('STAFF_CHAT_ID channel not found');
      return;
    }

    // Handle SERVER_HOST that might already include protocol
    let downloadUrl;
    if (SERVER_HOST) {
      if (SERVER_HOST.startsWith('http://') || SERVER_HOST.startsWith('https://')) {
        // Already has protocol, use as-is
        downloadUrl = `${SERVER_HOST}/recording/${recordingId}`;
      } else {
        // No protocol, add http://
        downloadUrl = `http://${SERVER_HOST}/recording/${recordingId}`;
      }
    } else {
      downloadUrl = `http://localhost:9281/recording/${recordingId}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(metadata.title)
      .setDescription(`Recording ID: \`${recordingId}\``)
      .addFields(
        { name: 'Student', value: `<@${metadata.studentId}>`, inline: true },
        { name: 'Tutor', value: metadata.tutorId ? `<@${metadata.tutorId}>` : 'N/A', inline: true },
        { name: 'View Recording', value: `[Click here](${downloadUrl})`, inline: false },
        { name: 'Delete Key', value: `||\`${metadata.deleteKey}\`||`, inline: false }
      )
      .setTimestamp(metadata.createdAt)
      .setColor(0x5865F2);

    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Failed to notify staff about recording', e);
  }
}

// Notify staff about errors
async function notifyStaff(err, context = {}) {
  try {
    const client = context.client || global.demoClient;
    if (!client) {
      console.error('Client not available for notifyStaff', err, context);
      return;
    }

    if (!STAFF_CHAT_ID) {
      console.error('STAFF_CHAT_ID not set, cannot notify staff about error', err, context);
      return;
    }

    const ch = await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
    if (!ch) {
      console.error('STAFF_CHAT_ID channel not found', err, context);
      return;
    }

    const roleMentions = getStaffRoleIds().map(r => `<@&${r}>`).join(' ');
    const short = `⚠️ Demo recording error\n${roleMentions}\nModule: ${context.module || 'demo'}\nRecording ID: ${context.recordingId || 'N/A'}\n\`\`\`\n${String(err && (err.stack || err)).slice(0, 1900)}\n\`\`\``;
    await ch.send({ content: short }).catch(() => {});
  } catch (e) {
    console.error('notifyStaff helper failed', e);
  }
}

// Cleanup old recordings (older than 7 days)
async function cleanupOldRecordings(client) {
  try {
    const metadata = loadMetadata();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const oneDayBeforeMs = 6 * 24 * 60 * 60 * 1000;

    const toDelete = [];
    const toWarn = [];

    for (const [recordingId, meta] of Object.entries(metadata)) {
      const age = now - meta.createdAt;
      if (age > sevenDaysMs) {
        toDelete.push({ recordingId, meta });
      } else if (age > oneDayBeforeMs && !meta.warned) {
        toWarn.push({ recordingId, meta });
      }
    }

    // Warn staff about recordings that will be deleted tomorrow
    if (toWarn.length > 0 && STAFF_CHAT_ID) {
      try {
        const channel = await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
        if (channel) {
          const roleMentions = getStaffRoleIds().map(r => `<@&${r}>`).join(' ');
          const warningList = toWarn.map(({ recordingId, meta }) => 
            `- **${meta.title}** (ID: \`${recordingId}\`) - Created <t:${Math.floor(meta.createdAt / 1000)}:f>`
          ).join('\n');

          const embed = new EmbedBuilder()
            .setTitle('⚠️ Recordings will be deleted tomorrow')
            .setDescription(`${roleMentions}\n\nThe following recordings will be automatically deleted in 24 hours:\n\n${warningList}\n\nUse the delete key to keep them longer if needed.`)
            .setColor(0xFFA500)
            .setTimestamp();

          await channel.send({ embeds: [embed] });

          // Mark as warned
          for (const { recordingId } of toWarn) {
            metadata[recordingId].warned = true;
          }
          saveMetadata(metadata);
        }
      } catch (e) {
        console.warn('Failed to send cleanup warning', e);
      }
    }

    // Delete old recordings
    for (const { recordingId, meta } of toDelete) {
      try {
        // Delete directory
        if (fs.existsSync(meta.filePath)) {
          fs.rmSync(meta.filePath, { recursive: true, force: true });
        }

        // Remove from metadata
        delete metadata[recordingId];
      } catch (e) {
        console.warn(`Failed to delete recording ${recordingId}`, e);
      }
    }

    if (toDelete.length > 0) {
      saveMetadata(metadata);
      console.log(`Cleaned up ${toDelete.length} old recording(s)`);
    }
  } catch (e) {
    console.error('Error in cleanupOldRecordings', e);
  }
}

// Main initialization function
export default function initDemo(client) {
  if (!client) throw new Error('initDemo missing client');

  if (!GUILD_ID || !STAFF_ROLE_ID) {
    throw new Error('demo config missing required env IDs: GUILD_ID, STAFF_ROLE_ID');
  }

  // Store client reference for use in handlers
  global.demoClient = client;

  // Setup voice state handlers
  setupVoiceStateHandlers(client);

  // Handle slash commands
  client.on('interactionCreate', async (interaction) => {
    try {
      // IMMEDIATELY defer for commands we handle - must happen before ANY other processing
      if (interaction.isChatInputCommand() && 
          (interaction.commandName === 'authentication' || interaction.commandName === 'startdemo')) {
        // Defer immediately if not already handled
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferReply({ ephemeral: true });
        } else {
          // Already handled by another handler, skip
          return;
        }
      } else {
        // Not a command we handle, skip
        return;
      }
      
      // Handle /authentication command
      if (interaction.commandName === 'authentication') {
        
        const member = interaction.member;
        if (!member) {
          return interaction.editReply({ content: 'This command can only be used in a server.' });
        }
        
        // Check if user is staff
        if (!isStaff(member)) {
          return interaction.editReply({ 
            content: 'Only staff can generate authentication codes.' 
          });
        }
        
        // Generate authentication token
        const token = generateAuthToken();
        // Handle SERVER_HOST that might already include protocol
        let webappUrl;
        if (SERVER_HOST) {
          if (SERVER_HOST.startsWith('http://') || SERVER_HOST.startsWith('https://')) {
            // Already has protocol, use as-is
            webappUrl = `${SERVER_HOST}/?token=${encodeURIComponent(token)}`;
          } else {
            // No protocol, add http://
            webappUrl = `http://${SERVER_HOST}/?token=${encodeURIComponent(token)}`;
          }
        } else {
          webappUrl = `http://localhost:9281/?token=${encodeURIComponent(token)}`;
        }
        
        await interaction.editReply({ 
          content: `**Authentication Code Generated**\n\n` +
                   `Code: \`${token}\`\n` +
                   `Direct link: ${webappUrl}\n\n` +
                   `⚠️ This code will expire in 2 minutes.`
        });
        
        return;
      }
      
      // Handle /startdemo command
      if (interaction.commandName === 'startdemo') {
        try {
          // deferReply already called above

      const member = interaction.member;
      if (!member) {
        return interaction.editReply({ content: 'This command can only be used in a server.' });
      }

      // Check if user is staff or tutor
      const isStaffUser = isStaff(member);
      const student = interaction.options.getUser('student', true);
      const studentId = student.id;
      const title = interaction.options.getString('title', true);

      // Get db from global (set by index.js)
      let db = null;
      try {
        if (global.demoDB) {
          db = global.demoDB;
        }
      } catch (e) {}

      const isTutor = db ? isTutorForStudent(member.user.id, studentId, db) : false;

      if (!isStaffUser && !isTutor) {
        return interaction.editReply({ 
          content: 'Only staff or the tutor assigned to this student can start a demo recording.' 
        });
      }

      // Get tutor ID from assignment if available
      let tutorId = null;
      if (db && db.studentAssignments && db.studentAssignments[studentId]) {
        tutorId = db.studentAssignments[studentId].tutorId;
      }

      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply({ content: 'Guild not found.' });
      }

      // Create temporary voice channel
      const staffRoleIds = getStaffRoleIds();
      let channel;
      try {
        channel = await createTempVoiceChannel(guild, studentId, tutorId, staffRoleIds, client.user.id);
      } catch (e) {
        console.error('Failed to create voice channel', e);
        await notifyStaff(e, { module: 'demo.createChannel', userId: member.user.id, client });
        return interaction.editReply({ content: 'Failed to create voice channel. Staff have been notified.' });
      }

      // Generate recording ID and delete key
      const recordingId = randomUUID();
      const deleteKey = generateDeleteKey();

      // Create recording directory
      const recordingDir = path.join(RECORDINGS_DIR, recordingId);
      fs.mkdirSync(recordingDir, { recursive: true });

      // Join voice channel (not deafened so it can hear and play audio)
      let connection;
      try {
        connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });

        // Don't wait for connection to be ready here - it will be checked when needed
        // The connection will become ready asynchronously

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          // If disconnected unexpectedly, cleanup
          const session = activeRecordings.get(recordingId);
          if (session) {
            await finalizeRecording(recordingId, client);
          }
        });

        connection.on('error', async (err) => {
          console.error(`Voice connection error for ${recordingId}`, err);
          await notifyStaff(err, { recordingId, module: 'demo.connectionError', client });
        });
      } catch (e) {
        console.error('Failed to join voice channel', e);
        await notifyStaff(e, { module: 'demo.joinChannel', userId: member.user.id, client });
        try {
          await channel.delete();
        } catch {}
        return interaction.editReply({ content: 'Failed to join voice channel. Staff have been notified.' });
      }

      // Create recording session
      const session = {
        recordingId,
        channel,
        connection,
        recordingDir,
        userRecordings: {},
        recordingStarted: false,
        client, // Store client reference for notifyStaff
        metadata: {
          title,
          tutorId,
          studentId,
          createdAt: Date.now(),
          deleteKey
        }
      };

      activeRecordings.set(recordingId, session);
      console.log(`[DEMO ${recordingId}] ✅ Session created - Student: ${studentId}, Tutor: ${tutorId || 'none'}, Channel: ${channel.id}`);

      await interaction.editReply({ 
        content: `Demo recording session created! Join the voice channel: <#${channel.id}>\n\nRecording will start automatically when the first user joins.` 
      });
    } catch (e) {
      console.error('Error in /startdemo handler', e);
      await notifyStaff(e, { module: 'demo.startdemo', userId: interaction.user?.id, client });
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An error occurred. Staff have been notified.', ephemeral: true });
        } else {
          await interaction.editReply({ content: 'An error occurred. Staff have been notified.' });
        }
      } catch {}
        }
      }
    } catch (e) {
      console.error('Error in demo interaction handler', e);
      // Don't try to respond here as the interaction may already be handled or expired
    }
  });

  // Run cleanup on startup
  cleanupOldRecordings(client).catch(e => {
    console.warn('Startup cleanup failed', e);
  });

  // Run cleanup periodically (hourly)
  setInterval(() => {
    cleanupOldRecordings(client).catch(e => {
      console.warn('Periodic cleanup failed', e);
    });
  }, 60 * 60 * 1000);

  console.log('demo module initialized');
}

