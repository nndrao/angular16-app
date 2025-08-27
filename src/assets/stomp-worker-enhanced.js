/**
 * Enhanced STOMP SharedWorker with snapshot caching and statistics
 */

// Import STOMP.js library
try {
  importScripts('/assets/lib/stomp.umd.min.js');
  console.log('[StompWorkerEnhanced] STOMP.js library loaded successfully');
} catch (error) {
  console.error('[StompWorkerEnhanced] Failed to load STOMP.js library:', error);
  // Fallback to CDN
  try {
    importScripts('https://cdn.jsdelivr.net/npm/@stomp/stompjs@7.0.0/bundles/stomp.umd.min.js');
    console.log('[StompWorkerEnhanced] STOMP.js library loaded from CDN');
  } catch (cdnError) {
    console.error('[StompWorkerEnhanced] Failed to load STOMP.js from CDN:', cdnError);
  }
}

// Provider connection class
class ProviderConnection {
  constructor(providerId, config) {
    this.providerId = providerId;
    this.config = config;
    this.snapshot = new Map(); // Cache for snapshot data
    this.lastUpdate = Date.now();
    this.subscribers = new Map(); // Port connections
    this.connection = null; // STOMP client
    this.subscription = null; // STOMP subscription
    this.statistics = {
      snapshotRowsReceived: 0,
      updateRowsReceived: 0,
      connectionCount: 0,
      disconnectionCount: 0,
      isConnected: false,
      bytesReceived: 0,
      mode: 'idle' // idle, snapshot, realtime
    };
    this.isConnecting = false;
    this.isSnapshotComplete = false;
    this.snapshotStartTime = 0;
  }

  // Generate client ID
  generateClientId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    return `stomp-${timestamp}-${random}`;
  }

  // Build trigger destination
  buildTriggerDestination(clientId) {
    const dataType = this.config.dataType || 'positions';
    const rate = this.config.messageRate || 1000;
    let destination = `/snapshot/${dataType}/${clientId}/${rate}`;
    
    if (this.config.batchSize) {
      destination += `/${this.config.batchSize}`;
    }
    
    return destination;
  }

  // Build listener topic
  buildListenerTopic(clientId) {
    const dataType = this.config.dataType || 'positions';
    return `/snapshot/${dataType}/${clientId}`;
  }

  // Check if message is end token
  isEndToken(messageBody) {
    if (!this.config.snapshotEndToken) return false;
    
    const trimmedBody = messageBody.trim().toLowerCase();
    const endToken = this.config.snapshotEndToken.toLowerCase();
    
    // Check for "Success" in the message
    return trimmedBody.includes(endToken) || trimmedBody.includes('success');
  }

  // Connect to STOMP
  async connect() {
    if (this.isConnecting || this.statistics.isConnected) {
      return;
    }

    this.isConnecting = true;
    const clientId = this.generateClientId();

    try {
      const listenerTopic = this.buildListenerTopic(clientId);
      const triggerDestination = this.buildTriggerDestination(clientId);

      // Create STOMP client
      this.connection = new StompJs.Client({
        brokerURL: this.config.websocketUrl,
        reconnectDelay: 5000,
        heartbeatIncoming: 4000,
        heartbeatOutgoing: 4000,
        debug: (str) => {
          if (str.includes('ERROR') || str.includes('WARN')) {
            console.error('[StompWorkerEnhanced Debug]', str);
          }
        }
      });

      // Connection handler
      this.connection.onConnect = () => {
        this.statistics.isConnected = true;
        this.statistics.connectionCount++;
        this.statistics.mode = 'snapshot';
        this.isConnecting = false;
        this.snapshotStartTime = Date.now();
        
        // Clear snapshot cache for new data
        this.snapshot.clear();
        this.statistics.snapshotRowsReceived = 0;
        this.isSnapshotComplete = false;

        // Notify subscribers
        this.broadcast({
          type: 'connected',
          providerId: this.providerId,
          clientId: clientId
        });

        // Subscribe to topic
        this.subscription = this.connection.subscribe(listenerTopic, (message) => {
          this.handleMessage(message);
        });

        // Send trigger message
        this.connection.publish({
          destination: triggerDestination,
          body: ''
        });
      };

      // Error handlers
      this.connection.onStompError = (frame) => {
        const errorMsg = frame.headers['message'] || 'STOMP connection error';
        console.error('[StompWorkerEnhanced] STOMP error:', errorMsg);
        this.broadcast({
          type: 'error',
          providerId: this.providerId,
          error: errorMsg
        });
      };

      this.connection.onWebSocketError = (event) => {
        console.error('[StompWorkerEnhanced] WebSocket error:', event);
        this.broadcast({
          type: 'error',
          providerId: this.providerId,
          error: 'WebSocket connection error'
        });
      };

      this.connection.onDisconnect = () => {
        this.statistics.isConnected = false;
        this.statistics.disconnectionCount++;
        this.statistics.mode = 'idle';
        this.isConnecting = false;
        
        this.broadcast({
          type: 'disconnected',
          providerId: this.providerId
        });
      };

      // Activate connection
      this.connection.activate();

    } catch (error) {
      console.error(`[StompWorkerEnhanced] Connection error for ${this.providerId}:`, error);
      this.isConnecting = false;
      throw error;
    }
  }

  // Handle incoming messages
  handleMessage(message) {
    try {
      const messageBody = message.body.trim();
      this.statistics.bytesReceived += messageBody.length;

      // Check for end token
      if (!this.isSnapshotComplete && this.isEndToken(messageBody)) {
        const duration = Date.now() - this.snapshotStartTime;
        this.isSnapshotComplete = true;
        this.statistics.mode = 'realtime';
        
        this.broadcast({
          type: 'snapshot-complete',
          providerId: this.providerId,
          rowCount: this.statistics.snapshotRowsReceived,
          duration: duration
        });
        return;
      }

      // Try to parse JSON
      let data;
      try {
        data = JSON.parse(messageBody);
      } catch (parseError) {
        // Skip non-JSON messages silently
        return;
      }

      // Process data
      const positions = Array.isArray(data) ? data : [data];
      
      if (this.isSnapshotComplete) {
        // Real-time update
        this.statistics.updateRowsReceived += positions.length;
        this.applyUpdatesToSnapshot(positions);
      } else {
        // Snapshot data
        this.statistics.snapshotRowsReceived += positions.length;
        this.applyUpdatesToSnapshot(positions);
      }

      // Broadcast data to subscribers
      this.broadcast({
        type: 'data',
        providerId: this.providerId,
        data: positions,
        isSnapshot: !this.isSnapshotComplete
      });

    } catch (error) {
      console.error(`[StompWorkerEnhanced] Error processing message for ${this.providerId}:`, error);
      this.broadcast({
        type: 'error',
        providerId: this.providerId,
        error: error.message
      });
    }
  }

  // Apply updates to snapshot cache
  applyUpdatesToSnapshot(updates) {
    const keyColumn = this.config.keyColumn || 'positionId';
    
    updates.forEach(update => {
      const key = update[keyColumn];
      if (key !== undefined && key !== null) {
        this.snapshot.set(String(key), update);
      }
    });
    
    this.lastUpdate = Date.now();
  }

  // Disconnect from STOMP
  disconnect() {
    if (this.subscription) {
      try {
        this.subscription.unsubscribe();
      } catch (error) {
        console.error('[StompWorkerEnhanced] Error unsubscribing:', error);
      }
      this.subscription = null;
    }

    if (this.connection) {
      try {
        this.connection.deactivate();
      } catch (error) {
        console.error('[StompWorkerEnhanced] Error deactivating client:', error);
      }
      this.connection = null;
    }

    this.statistics.isConnected = false;
    this.statistics.mode = 'idle';
    this.isConnecting = false;
  }

  // Broadcast to all subscribers
  broadcast(message) {
    this.subscribers.forEach((port, portId) => {
      try {
        port.postMessage(message);
      } catch (error) {
        console.error(`[StompWorkerEnhanced] Error broadcasting to port ${portId}:`, error);
        // Remove dead port
        this.subscribers.delete(portId);
      }
    });
  }

  // Get snapshot data
  getSnapshot() {
    return Array.from(this.snapshot.values());
  }
}

// Global state
const providers = new Map(); // All provider connections
const ports = new Map(); // All port connections
let portCounter = 0;

// Generate unique port ID
function generatePortId() {
  return `port-${Date.now()}-${++portCounter}`;
}

// Handle new port connections
self.onconnect = function(event) {
  const port = event.ports[0];
  const portId = generatePortId();
  
  ports.set(portId, port);
  
  port.onmessage = (e) => {
    handlePortMessage(portId, port, e.data);
  };
  
  port.onmessageerror = (e) => {
    console.error(`[StompWorkerEnhanced] Message error from ${portId}:`, e);
  };
  
  port.start();
};

// Handle messages from ports
async function handlePortMessage(portId, port, message) {
  const { id, type, providerId, config } = message;
  
  try {
    switch (type) {
      case 'connect':
        await handleConnect(portId, port, providerId, config, id);
        break;
        
      case 'disconnect':
        await handleDisconnect(providerId);
        port.postMessage({ id, type: 'response', success: true });
        break;
        
      case 'refresh':
        await handleRefresh(providerId);
        port.postMessage({ id, type: 'response', success: true });
        break;
        
      case 'get-snapshot':
        const snapshot = handleGetSnapshot(providerId);
        port.postMessage({ id, type: 'response', data: snapshot });
        break;
        
      case 'get-statistics':
        const stats = handleGetStatistics(providerId);
        port.postMessage({ id, type: 'response', statistics: stats });
        break;
        
      default:
        port.postMessage({ 
          id, 
          type: 'error', 
          error: `Unknown message type: ${type}` 
        });
    }
  } catch (error) {
    console.error(`[StompWorkerEnhanced] Error handling message:`, error);
    port.postMessage({ 
      id, 
      type: 'error', 
      error: error.message 
    });
  }
}

// Handle connect request
async function handleConnect(portId, port, providerId, config, messageId) {
  let provider = providers.get(providerId);
  
  if (!provider) {
    // Create new provider connection
    provider = new ProviderConnection(providerId, config);
    providers.set(providerId, provider);
  }
  
  // Add port as subscriber
  provider.subscribers.set(portId, port);
  
  // Connect if not already connected
  if (!provider.statistics.isConnected && !provider.isConnecting) {
    await provider.connect();
  } else if (provider.statistics.isConnected) {
    // Already connected, send current state
    port.postMessage({
      type: 'connected',
      providerId: providerId,
      clientId: providerId
    });
    
    // Send cached snapshot if available
    if (provider.snapshot.size > 0) {
      const snapshot = provider.getSnapshot();
      port.postMessage({
        type: 'data',
        providerId: providerId,
        data: snapshot,
        isSnapshot: false
      });
    }
  }
  
  // Send response message with the original ID to resolve the promise
  port.postMessage({ 
    id: messageId, 
    type: 'response', 
    success: true 
  });
  
  return { success: true };
}

// Handle disconnect request
async function handleDisconnect(providerId) {
  const provider = providers.get(providerId);
  if (!provider) return;
  
  provider.disconnect();
  providers.delete(providerId);
}

// Handle refresh request
async function handleRefresh(providerId) {
  const provider = providers.get(providerId);
  if (!provider) {
    throw new Error('Provider not connected');
  }
  
  // Disconnect and reconnect to get fresh data
  provider.disconnect();
  await new Promise(resolve => setTimeout(resolve, 100));
  await provider.connect();
}

// Get snapshot data
function handleGetSnapshot(providerId) {
  const provider = providers.get(providerId);
  if (!provider) return [];
  
  return provider.getSnapshot();
}

// Get statistics
function handleGetStatistics(providerId) {
  const provider = providers.get(providerId);
  if (!provider) return null;
  
  return provider.statistics;
}

console.log('[StompWorkerEnhanced] Worker initialized and ready');