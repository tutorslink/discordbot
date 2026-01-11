/**
 * webserver.js
 * Web server module for authentication and API endpoints
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Authentication tokens: token -> { expiresAt, createdAt }
const authTokens = new Map();

// Generate authentication token (cryptographically secure random token)
export function generateAuthToken() {
  // Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (2 * 60 * 1000); // 2 minutes
  
  // Hash the token for secure storage (using SHA-256)
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  // Store the hash with expiration
  authTokens.set(tokenHash, {
    expiresAt,
    createdAt: Date.now()
  });
  
  // Cleanup expired tokens after expiration
  setTimeout(() => {
    authTokens.delete(tokenHash);
  }, 2 * 60 * 1000);
  
  // Return the original token (not the hash) for the user
  return token;
}

// Verify authentication token
export function verifyAuthToken(token) {
  if (!token) return false;
  
  // Hash the provided token to compare with stored hash
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  const tokenData = authTokens.get(tokenHash);
  if (!tokenData) return false;
  
  if (Date.now() > tokenData.expiresAt) {
    authTokens.delete(tokenHash);
    return false;
  }
  
  return true;
}

// Cleanup expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of authTokens.entries()) {
    if (now > data.expiresAt) {
      authTokens.delete(token);
    }
  }
}, 60000); // Check every minute

// Load metadata
function loadMetadata() {
  try {
    const metadataFile = path.join(__dirname, 'recordings', 'metadata.json');
    if (fs.existsSync(metadataFile)) {
      const data = fs.readFileSync(metadataFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('Failed to load metadata.json', e);
  }
  return {};
}

// Setup web server routes
export function setupWebServer(app) {
  // Parse JSON bodies
  app.use(express.json());
  app.use(express.static(path.join(__dirname)));
  
  // Serve CSS file
  app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
  });
  
  // Serve webapp HTML
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp.html'));
  });
  
  // Serve recording page
  app.get('/recording/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp.html'));
  });
  
  // API: Authenticate
  app.post('/api/auth', (req, res) => {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }
    
    if (verifyAuthToken(token)) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  
  // API: Get all recordings (requires auth)
  app.get('/api/recordings', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    
    if (!verifyAuthToken(token)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const metadata = loadMetadata();
    const recordings = Object.values(metadata).map(rec => ({
      recordingId: rec.recordingId,
      title: rec.title,
      tutorId: rec.tutorId,
      studentId: rec.studentId,
      createdAt: rec.createdAt,
      userIds: rec.userIds || []
    })).sort((a, b) => b.createdAt - a.createdAt);
    
    res.json({ recordings });
  });
  
  // API: Get recording details (requires auth)
  app.get('/api/recordings/:id', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    
    if (!verifyAuthToken(token)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { id } = req.params;
    const metadata = loadMetadata();
    const recording = metadata[id];
    
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    
    // Get list of audio files in the recording directory
    const recordingDir = path.join(__dirname, 'recordings', id);
    let audioFiles = [];
    
    if (fs.existsSync(recordingDir) && fs.statSync(recordingDir).isDirectory()) {
      try {
        const files = fs.readdirSync(recordingDir);
        // Include .raw files (raw Opus frame dumps)
        audioFiles = files
          .filter(f => f.endsWith('.raw'))
          .map(f => {
            const userId = f.replace(/\.raw$/i, '');
            return {
              userId,
              filename: f,
              url: `/api/recordings/${id}/audio/${f}?token=${encodeURIComponent(token)}`
            };
          })
          // Remove duplicates (same userId)
          .filter((file, index, self) => 
            index === self.findIndex(f => f.userId === file.userId)
          );
      } catch (e) {
        console.error('Error reading recording directory', e);
      }
    }
    
    res.json({
      ...recording,
      audioFiles
    });
  });
  
  // API: Get audio file (requires auth)
  app.get('/api/recordings/:id/audio/:filename', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    
    if (!verifyAuthToken(token)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { id, filename } = req.params;
    
    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).send('Invalid filename');
    }
    
    let filePath = path.join(__dirname, 'recordings', id, filename);
    
    // Set appropriate Content-Type for raw dump files
    if (filename.endsWith('.raw')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else if (filename.endsWith('.opus') || filename.endsWith('.ogg')) {
      res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
    } else if (filename.endsWith('.wav')) {
      res.setHeader('Content-Type', 'audio/wav');
    } else {
      // Default: try to detect from extension
      if (filename.endsWith('.mp3')) {
        res.setHeader('Content-Type', 'audio/mpeg');
      } else if (filename.endsWith('.m4a')) {
        res.setHeader('Content-Type', 'audio/mp4');
      }
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }
    
    res.sendFile(filePath);
  });
  
  // API: Delete recording (requires delete key)
  app.delete('/api/recordings/:id', (req, res) => {
    const { id } = req.params;
    const { deleteKey } = req.body;
    
    if (!deleteKey) {
      return res.status(400).json({ error: 'Delete key required' });
    }
    
    const metadata = loadMetadata();
    const recording = metadata[id];
    
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    
    if (recording.deleteKey !== deleteKey) {
      return res.status(403).json({ error: 'Invalid delete key' });
    }
    
    // Delete recording directory
    const recordingDir = path.join(__dirname, 'recordings', id);
    try {
      if (fs.existsSync(recordingDir)) {
        fs.rmSync(recordingDir, { recursive: true, force: true });
      }
      
      // Remove from metadata
      delete metadata[id];
      const metadataFile = path.join(__dirname, 'recordings', 'metadata.json');
      fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8');
      
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting recording', e);
      res.status(500).json({ error: 'Failed to delete recording' });
    }
  });
  
  // Legacy route for direct file access (for backward compatibility)
  app.get('/recordings/:id/:filename', (req, res) => {
    const { id, filename } = req.params;
    
    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).send('Invalid filename');
    }
    
    let filePath = path.join(__dirname, 'recordings', id, filename);
    
    // Set appropriate Content-Type
    if (filename.endsWith('.raw')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    } else if (filename.endsWith('.opus') || filename.endsWith('.ogg')) {
      res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
    } else if (filename.endsWith('.wav')) {
      res.setHeader('Content-Type', 'audio/wav');
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }
    
    res.sendFile(filePath);
  });
}

