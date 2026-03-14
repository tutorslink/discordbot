/**
 * ogg-writer.js
 * Ogg/Opus container writer for raw Opus packet passthrough
 * Implements Ogg page structure, OpusHead, and OpusTags headers
 */

import fs from 'fs';

/**
 * OggWriter - Writes raw Opus packets to Ogg container format
 */
export class OggWriter {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.channels = options.channels || 2; // Default to stereo
    this.sampleRate = options.sampleRate || 48000;
    this.preSkip = options.preSkip || 0;
    this.outputGain = options.outputGain || 0;
    this.vendorString = options.vendorString || 'Craig-style Opus Recorder';
    this.comments = options.comments || [];
    
    // Ogg stream state
    this.serialNumber = Math.floor(Math.random() * 0xFFFFFFFF);
    this.pageSequenceNumber = 0;
    this.granulePosition = 0; // Total samples encoded
    this.currentPacket = Buffer.alloc(0);
    
    // File handle
    this.fd = null;
    this.bytesWritten = 0;
    this.packetsWritten = 0;
    this.firstPacketReceived = false;
    
    // Track TOC bytes for diagnostics
    this.tocBytes = [];
  }

  /**
   * Open file and write Ogg stream header pages (OpusHead, OpusTags)
   */
  async init() {
    try {
      // Open file for writing
      this.fd = await fs.promises.open(this.filePath, 'w');
      
      // Write OpusHead page
      const opusHead = this.createOpusHead();
      await this.writeOggPage(opusHead, {
        headerType: 0x02, // Beginning of stream
        granulePos: 0
      });
      
      // Write OpusTags page
      const opusTags = this.createOpusTags();
      await this.writeOggPage(opusTags, {
        headerType: 0x00, // Continuation
        granulePos: 0
      });
      
      console.log(`[OggWriter] ✅ Initialized Ogg file: ${this.filePath}`);
      console.log(`[OggWriter] Serial number: ${this.serialNumber}, Channels: ${this.channels}, Sample rate: ${this.sampleRate}`);
      
      return true;
    } catch (error) {
      console.error(`[OggWriter] ❌ Failed to initialize file ${this.filePath}:`, error);
      throw error;
    }
  }

  /**
   * Create OpusHead identification header packet
   */
  createOpusHead() {
    const buffer = Buffer.alloc(19);
    let offset = 0;
    
    // Magic signature "OpusHead"
    buffer.write('OpusHead', offset); offset += 8;
    
    // Version (always 1)
    buffer.writeUInt8(1, offset); offset += 1;
    
    // Channel count
    buffer.writeUInt8(this.channels, offset); offset += 1;
    
    // Pre-skip (2 bytes, little-endian)
    buffer.writeUInt16LE(this.preSkip, offset); offset += 2;
    
    // Input sample rate (4 bytes, little-endian)
    buffer.writeUInt32LE(this.sampleRate, offset); offset += 4;
    
    // Output gain (2 bytes, little-endian, signed)
    buffer.writeInt16LE(this.outputGain, offset); offset += 2;
    
    // Channel mapping (0 = mono/stereo no mapping, 1 = Vorbis mapping)
    buffer.writeUInt8(0, offset); offset += 1;
    
    return buffer;
  }

  /**
   * Create OpusTags comment header packet
   */
  createOpusTags() {
    const vendorLength = Buffer.byteLength(this.vendorString, 'utf8');
    const commentCount = this.comments.length;
    
    // Calculate total size: magic (8) + vendor len (4) + vendor + count (4) + comments
    let totalSize = 8 + 4 + vendorLength + 4;
    for (const comment of this.comments) {
      totalSize += 4 + Buffer.byteLength(comment, 'utf8');
    }
    
    const buffer = Buffer.alloc(totalSize);
    let offset = 0;
    
    // Magic signature "OpusTags"
    buffer.write('OpusTags', offset); offset += 8;
    
    // Vendor string length
    buffer.writeUInt32LE(vendorLength, offset); offset += 4;
    
    // Vendor string
    buffer.write(this.vendorString, offset, 'utf8'); offset += vendorLength;
    
    // Comment count
    buffer.writeUInt32LE(commentCount, offset); offset += 4;
    
    // Comments
    for (const comment of this.comments) {
      const commentLength = Buffer.byteLength(comment, 'utf8');
      buffer.writeUInt32LE(commentLength, offset); offset += 4;
      buffer.write(comment, offset, 'utf8'); offset += commentLength;
    }
    
    return buffer;
  }

  /**
   * Write an Ogg page to the file
   * @param {Buffer} packet - The packet data to write
   * @param {Object} options - Page options (headerType, granulePos)
   */
  async writeOggPage(packet, options = {}) {
    const headerType = options.headerType !== undefined ? options.headerType : 0x00;
    const granulePos = options.granulePos !== undefined ? options.granulePos : this.granulePosition;
    const continuedPacket = options.continuedPacket || false;
    
    // Segment table: split packet into segments of max 255 bytes
    const maxSegmentSize = 255;
    const segments = [];
    
    if (packet.length === 0) {
      // Empty packet
      segments.push(0);
    } else {
      let remaining = packet.length;
      let packetOffset = 0;
      
      while (remaining > 0) {
        const segmentSize = Math.min(remaining, maxSegmentSize);
        segments.push(segmentSize);
        remaining -= segmentSize;
        packetOffset += segmentSize;
      }
    }
    
    // Build segment table buffer (segment sizes only, count goes in header)
    const segmentTable = Buffer.alloc(segments.length);
    for (let i = 0; i < segments.length; i++) {
      segmentTable.writeUInt8(segments[i], i);
    }
    
    // Calculate page size: header (27) + segment table + packet
    const pageSize = 27 + segmentTable.length + packet.length;
    
    // Build Ogg page header (27 bytes)
    const pageHeader = Buffer.alloc(27);
    let offset = 0;
    
    // Capture pattern "OggS" (4 bytes)
    pageHeader.write('OggS', offset); offset += 4;
    
    // Version (1 byte)
    pageHeader.writeUInt8(0, offset); offset += 1;
    
    // Header type (1 byte)
    pageHeader.writeUInt8(headerType, offset); offset += 1;
    
    // Granule position (8 bytes, little-endian)
    const granulePosLow = granulePos & 0xFFFFFFFF;
    const granulePosHigh = Math.floor(granulePos / 0x100000000);
    pageHeader.writeUInt32LE(granulePosLow, offset); offset += 4;
    pageHeader.writeUInt32LE(granulePosHigh, offset); offset += 4;
    
    // Serial number (4 bytes, little-endian)
    pageHeader.writeUInt32LE(this.serialNumber, offset); offset += 4;
    
    // Page sequence number (4 bytes, little-endian)
    pageHeader.writeUInt32LE(this.pageSequenceNumber, offset); offset += 4;
    
    // Checksum (4 bytes, will be calculated, start with 0)
    pageHeader.writeUInt32LE(0, offset); offset += 4;
    
    // Page segments count (1 byte) - last byte of header
    pageHeader.writeUInt8(segments.length, offset); offset += 1;
    
    // Calculate checksum over header + segment table + packet
    const checksum = this.calculateOggChecksum(pageHeader, segmentTable, packet);
    pageHeader.writeUInt32LE(checksum, 22); // Write checksum at offset 22
    
    // Write to file
    await this.fd.write(pageHeader);
    await this.fd.write(segmentTable);
    
    // Write packet data in segments
    let packetOffset = 0;
    for (const segmentSize of segments) {
      if (segmentSize > 0) {
        await this.fd.write(packet.slice(packetOffset, packetOffset + segmentSize));
        packetOffset += segmentSize;
      }
    }
    
    // Update state
    this.pageSequenceNumber++;
    this.bytesWritten += pageSize;
    
    return pageSize;
  }

  /**
   * Get or generate CRC32 lookup table (cached)
   */
  getCRC32Table() {
    if (!this._crc32Table) {
      // Ogg uses CRC32 with polynomial 0x04C11DB7, reflected
      const polynomial = 0x04C11DB7;
      this._crc32Table = new Array(256);
      
      for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
          if (crc & 1) {
            crc = (crc >>> 1) ^ polynomial;
          } else {
            crc = crc >>> 1;
          }
        }
        this._crc32Table[i] = crc >>> 0;
      }
    }
    return this._crc32Table;
  }

  /**
   * Calculate Ogg page checksum (CRC32)
   */
  calculateOggChecksum(header, segmentTable, packet) {
    const crc32Table = this.getCRC32Table();
    let crc = 0;
    
    const updateCRC = (data) => {
      for (let i = 0; i < data.length; i++) {
        const index = (crc ^ data[i]) & 0xFF;
        crc = ((crc >>> 8) ^ crc32Table[index]) >>> 0;
      }
    };
    
    // Process header with checksum field set to 0
    const headerForCRC = Buffer.from(header);
    headerForCRC.writeUInt32LE(0, 22); // Zero out checksum
    updateCRC(headerForCRC);
    updateCRC(segmentTable);
    updateCRC(packet);
    
    return crc;
  }

  /**
   * Parse Opus TOC byte to determine frame duration and count
   * @param {number} tocByte - Opus TOC byte
   * @returns {Object} Frame configuration
   */
  parseOpusTOC(tocByte) {
    // Opus TOC byte structure:
    // Bits 0-2: Configuration number (0-7)
    // Bit 3: Stereo flag (0=mono, 1=stereo)
    // Bits 4-7: Frame count code
    
    const config = tocByte & 0x03; // Lower 2 bits determine frame duration
    const stereo = (tocByte & 0x04) !== 0;
    const frameCountCode = (tocByte >> 4) & 0x0F;
    
    // Frame duration mapping based on config (for CBR/VBR)
    // Config % 4 determines duration:
    // 0: 10ms, 1: 20ms, 2: 40ms, 3: 60ms
    const durationMs = [10, 20, 40, 60][config % 4];
    
    // Frame count determination:
    // 0: 1 frame
    // 1: 2 frames (CBR)
    // 2: 2 frames (CBR)
    // 3: variable number of frames (need to parse from packet, but Discord typically uses 1)
    // 4-15: (frameCountCode - 3) frames
    let frameCount = 1;
    if (frameCountCode === 0) {
      frameCount = 1;
    } else if (frameCountCode === 1 || frameCountCode === 2) {
      frameCount = 2;
    } else if (frameCountCode === 3) {
      // Frame count code 3 means variable frames
      // For Discord, packets typically contain 1 frame, so we default to 1
      // If multi-frame packets are encountered, we'd need to parse the VBR header
      frameCount = 1;
    } else {
      // Codes 4-15: number of frames = code - 3
      frameCount = frameCountCode - 3;
    }
    
    // Calculate samples per packet
    // Granule position is in samples (at sample rate)
    // For Opus, granule position is per channel, so for stereo we still advance by samples/frame
    const samplesPerFrame = (durationMs * this.sampleRate) / 1000;
    const samplesPerPacket = samplesPerFrame * frameCount;
    
    return {
      config,
      stereo,
      frameCountCode,
      durationMs,
      frameCount,
      samplesPerFrame,
      samplesPerPacket
    };
  }

  /**
   * Write raw Opus packet (from Discord receiver)
   * @param {Buffer} packet - Raw Opus packet (unmodified from Discord)
   */
  async writeOpusPacket(packet) {
    if (!Buffer.isBuffer(packet) || packet.length === 0) {
      console.warn(`[OggWriter] ⚠️ Invalid packet: not a buffer or empty`);
      return;
    }

    if (!this.firstPacketReceived) {
      this.firstPacketReceived = true;
      console.log(`[OggWriter] 🎵 First Opus packet received, size: ${packet.length} bytes`);
      
      // Log first packet TOC for diagnostics
      if (packet.length > 0) {
        const tocByte = packet[0];
        const tocInfo = this.parseOpusTOC(tocByte);
        console.log(`[OggWriter] First packet TOC: 0x${tocByte.toString(16).toUpperCase().padStart(2, '0')}`);
        console.log(`[OggWriter]   Config: ${tocInfo.config}, Stereo: ${tocInfo.stereo}, Duration: ${tocInfo.durationMs}ms, Frames: ${tocInfo.frameCount}, Samples: ${tocInfo.samplesPerPacket}`);
        this.tocBytes.push(tocByte);
      }
    } else if (this.tocBytes.length < 10) {
      // Log first 10 TOC bytes for diagnostics
      const tocByte = packet[0];
      this.tocBytes.push(tocByte);
      if (this.tocBytes.length === 10) {
        console.log(`[OggWriter] First 10 TOC bytes: ${this.tocBytes.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ')}`);
      }
    }
    
    // Parse TOC byte to determine frame duration and samples
    const tocByte = packet[0];
    const tocInfo = this.parseOpusTOC(tocByte);
    
    // Update granule position BEFORE writing the page
    // Granule position represents the number of PCM samples (decoded) up to and including this packet
    // For Opus, this is per channel, so we use samplesPerPacket directly
    this.granulePosition += tocInfo.samplesPerPacket;
    this.packetsWritten++;
    
    // Log granule position updates for first few packets
    if (this.packetsWritten <= 5) {
      console.log(`[OggWriter] Packet ${this.packetsWritten}: TOC=0x${tocByte.toString(16).toUpperCase().padStart(2, '0')}, Duration=${tocInfo.durationMs}ms, Samples+=${tocInfo.samplesPerPacket}, Granule=${this.granulePosition}`);
    }
    
    // Determine header type
    let headerType = 0x00; // Continuation
    
    // Write the packet as an Ogg page
    // CRITICAL: Write packet bytes directly without modification
    await this.writeOggPage(packet, {
      headerType,
      granulePos: this.granulePosition
    });
  }

  /**
   * Finalize the Ogg stream (write final page with end-of-stream flag)
   */
  async finalize() {
    try {
      // Write a final page with end-of-stream flag (headerType 0x04)
      // Use empty packet for finalization
      await this.writeOggPage(Buffer.alloc(0), {
        headerType: 0x04, // End of stream
        granulePos: this.granulePosition
      });
      
      // Sync and close file
      await this.fd.sync();
      await this.fd.close();
      
      console.log(`[OggWriter] ✅ Finalized Ogg file: ${this.filePath}`);
      console.log(`[OggWriter] Total bytes written: ${this.bytesWritten}, Packets: ${this.packetsWritten}, Granule position: ${this.granulePosition}`);
      
      return {
        bytesWritten: this.bytesWritten,
        packetsWritten: this.packetsWritten,
        granulePosition: this.granulePosition
      };
    } catch (error) {
      console.error(`[OggWriter] ❌ Error finalizing file ${this.filePath}:`, error);
      throw error;
    }
  }
}

