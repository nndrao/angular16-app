/**
 * SharedWorker for STOMP server communication
 * Handles WebSocket connections, STOMP protocol, and message distribution
 */

class StompSharedWorker {
  constructor() {
    this.connections = new Map(); // Port connections from different tabs/components
    this.websocket = null;
    this.stompConnected = false;
    this.config = null;
    this.subscriptions = new Map();
    this.messageQueue = [];
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.messageId = 0;
    this.stats = {
      messagesReceived: 0,
      messagesPerSecond: 0,
      lastSecondCount: 0,
      lastSecondTime: Date.now()
    };

    // Start message rate calculation
    this.startStatsCalculation();
  }

  // Handle new port connections
  onConnect(event) {
    const port = event.ports[0];
    const connectionId = this.generateId();
    
    this.connections.set(connectionId, {
      port: port,
      subscriptions: new Set(),
      active: true
    });

    port.onmessage = (e) => this.handlePortMessage(connectionId, e.data);
    port.onmessageerror = (e) => this.handlePortError(connectionId, e);
    
    port.start();
    
    // Send connection confirmation
    this.sendToPort(connectionId, {
      id: 'connection',
      type: 'connected',
      payload: { connectionId }
    });

    console.log(`[StompWorker] New connection: ${connectionId}`);
  }

  // Handle messages from Angular components
  handlePortMessage(connectionId, message) {
    const { id, type, payload } = message;

    try {
      switch (type) {
        case 'connect':
          this.handleConnect(connectionId, id, payload);
          break;
        case 'disconnect':
          this.handleDisconnect(connectionId, id);
          break;
        case 'subscribe':
          this.handleSubscribe(connectionId, id, payload);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(connectionId, id, payload);
          break;
        case 'send':
          this.handleSend(connectionId, id, payload);
          break;
        case 'config':
          this.handleConfig(connectionId, id, payload);
          break;
        default:
          this.sendError(connectionId, id, `Unknown message type: ${type}`);
      }
    } catch (error) {
      this.sendError(connectionId, id, error.message);
    }
  }

  // Connect to STOMP server
  handleConnect(connectionId, messageId, config) {
    this.config = { ...this.config, ...config };
    
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.sendToPort(connectionId, {
        id: messageId,
        type: 'connected',
        payload: { alreadyConnected: true }
      });
      return;
    }

    try {
      this.websocket = new WebSocket(this.config.url);
      
      this.websocket.onopen = () => this.onWebSocketOpen(connectionId, messageId);
      this.websocket.onmessage = (event) => this.onWebSocketMessage(event);
      this.websocket.onclose = (event) => this.onWebSocketClose(event);
      this.websocket.onerror = (error) => this.onWebSocketError(connectionId, messageId, error);
      
    } catch (error) {
      this.sendError(connectionId, messageId, `Connection failed: ${error.message}`);
    }
  }

  // WebSocket event handlers
  onWebSocketOpen(connectionId, messageId) {
    console.log('[StompWorker] WebSocket connected');
    
    // Send STOMP CONNECT frame
    const connectFrame = this.buildStompFrame('CONNECT', {
      'accept-version': '1.0,1.1,1.2',
      'heart-beat': `${this.config.heartbeatOutgoing || 10000},${this.config.heartbeatIncoming || 10000}`,
      'host': this.config.clientId || 'stomp-client'
    });
    
    this.websocket.send(connectFrame);
  }

  onWebSocketMessage(event) {
    const frame = this.parseStompFrame(event.data);
    
    if (frame.command === 'CONNECTED') {
      this.stompConnected = true;
      this.startHeartbeat();
      
      // Notify all connections
      this.broadcastToAllPorts({
        id: 'stomp-connected',
        type: 'connected',
        payload: { stompConnected: true }
      });
      
    } else if (frame.command === 'MESSAGE') {
      this.handleStompMessage(frame);
    } else if (frame.command === 'ERROR') {
      this.handleStompError(frame);
    }
  }

  onWebSocketClose(event) {
    console.log('[StompWorker] WebSocket closed:', event.code, event.reason);
    this.stompConnected = false;
    this.stopHeartbeat();
    
    this.broadcastToAllPorts({
      id: 'stomp-disconnected',
      type: 'disconnected',
      payload: { code: event.code, reason: event.reason }
    });

    // Auto-reconnect if not intentional
    if (event.code !== 1000 && this.config?.reconnectDelay) {
      this.scheduleReconnect();
    }
  }

  onWebSocketError(connectionId, messageId, error) {
    console.error('[StompWorker] WebSocket error:', error);
    this.sendError(connectionId, messageId, `WebSocket error: ${error.message}`);
  }

  // STOMP protocol methods
  buildStompFrame(command, headers = {}, body = '') {
    let frame = command + '\n';
    
    Object.keys(headers).forEach(key => {
      frame += `${key}:${headers[key]}\n`;
    });
    
    frame += '\n' + body + '\0';
    return frame;
  }

  parseStompFrame(data) {
    const lines = data.split('\n');
    const command = lines[0];
    const headers = {};
    let bodyStart = 1;
    
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '') {
        bodyStart = i + 1;
        break;
      }
      const [key, value] = lines[i].split(':');
      if (key && value !== undefined) {
        headers[key] = value;
      }
    }
    
    const body = lines.slice(bodyStart).join('\n').replace(/\0$/, '');
    
    return { command, headers, body };
  }

  // Message handling
  handleStompMessage(frame) {
    this.updateStats();
    
    try {
      const destination = frame.headers.destination;
      const messageData = {
        destination,
        headers: frame.headers,
        body: frame.body,
        timestamp: new Date()
      };

      // Parse JSON body if possible
      try {
        messageData.data = JSON.parse(frame.body);
      } catch (e) {
        messageData.data = frame.body;
      }

      // Broadcast to subscribed connections
      this.broadcastToSubscribers(destination, {
        id: this.generateId(),
        type: 'message',
        payload: messageData
      });
      
    } catch (error) {
      console.error('[StompWorker] Error handling STOMP message:', error);
    }
  }

  // Subscription management
  handleSubscribe(connectionId, messageId, { destination, headers = {} }) {
    if (!this.stompConnected) {
      this.sendError(connectionId, messageId, 'Not connected to STOMP server');
      return;
    }

    const subscriptionId = this.generateId();

    // Send STOMP SUBSCRIBE frame
    const subscribeFrame = this.buildStompFrame('SUBSCRIBE', {
      id: subscriptionId,
      destination: destination,
      ...headers
    });

    this.websocket.send(subscribeFrame);

    // Track subscription
    this.subscriptions.set(subscriptionId, {
      destination,
      connectionId,
      headers
    });

    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.subscriptions.add(subscriptionId);
    }

    this.sendToPort(connectionId, {
      id: messageId,
      type: 'subscribed',
      payload: { subscriptionId, destination }
    });
  }

  handleUnsubscribe(connectionId, messageId, { subscriptionId }) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      this.sendError(connectionId, messageId, 'Subscription not found');
      return;
    }

    // Send STOMP UNSUBSCRIBE frame
    const unsubscribeFrame = this.buildStompFrame('UNSUBSCRIBE', {
      id: subscriptionId
    });

    this.websocket.send(unsubscribeFrame);

    // Remove subscription
    this.subscriptions.delete(subscriptionId);

    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.subscriptions.delete(subscriptionId);
    }

    this.sendToPort(connectionId, {
      id: messageId,
      type: 'unsubscribed',
      payload: { subscriptionId }
    });
  }

  handleSend(connectionId, messageId, { destination, body = '', headers = {} }) {
    if (!this.stompConnected) {
      this.sendError(connectionId, messageId, 'Not connected to STOMP server');
      return;
    }

    // Send STOMP SEND frame
    const sendFrame = this.buildStompFrame('SEND', {
      destination: destination,
      'content-type': 'text/plain',
      ...headers
    }, body);

    this.websocket.send(sendFrame);

    this.sendToPort(connectionId, {
      id: messageId,
      type: 'sent',
      payload: { destination, body }
    });
  }

  handleDisconnect(connectionId, messageId) {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.active = false;

      // Unsubscribe from all subscriptions for this connection
      connection.subscriptions.forEach(subscriptionId => {
        this.handleUnsubscribe(connectionId, 'auto-unsubscribe', { subscriptionId });
      });

      this.connections.delete(connectionId);
    }

    // If no more connections, disconnect from STOMP server
    if (this.connections.size === 0 && this.websocket) {
      const disconnectFrame = this.buildStompFrame('DISCONNECT');
      this.websocket.send(disconnectFrame);
      this.websocket.close();
    }

    this.sendToPort(connectionId, {
      id: messageId,
      type: 'disconnected',
      payload: { connectionId }
    });
  }

  handleConfig(connectionId, messageId, config) {
    this.config = { ...this.config, ...config };

    this.sendToPort(connectionId, {
      id: messageId,
      type: 'configured',
      payload: { config: this.config }
    });
  }

  handlePortError(connectionId, error) {
    console.error(`[StompWorker] Port error for connection ${connectionId}:`, error);
    this.connections.delete(connectionId);
  }

  handleStompError(frame) {
    console.error('[StompWorker] STOMP error:', frame.headers, frame.body);

    this.broadcastToAllPorts({
      id: 'stomp-error',
      type: 'error',
      error: `STOMP Error: ${frame.body}`,
      payload: { headers: frame.headers, body: frame.body }
    });
  }

  // Utility methods
  generateId() {
    return `msg-${++this.messageId}-${Date.now()}`;
  }

  sendToPort(connectionId, message) {
    const connection = this.connections.get(connectionId);
    if (connection && connection.active) {
      try {
        connection.port.postMessage(message);
      } catch (error) {
        console.error('[StompWorker] Error sending to port:', error);
        this.connections.delete(connectionId);
      }
    }
  }

  sendError(connectionId, messageId, error) {
    this.sendToPort(connectionId, {
      id: messageId,
      type: 'error',
      error: error
    });
  }

  broadcastToAllPorts(message) {
    this.connections.forEach((connection, connectionId) => {
      this.sendToPort(connectionId, message);
    });
  }

  broadcastToSubscribers(destination, message) {
    this.subscriptions.forEach((subscription, subscriptionId) => {
      if (subscription.destination === destination) {
        this.sendToPort(subscription.connectionId, message);
      }
    });
  }

  updateStats() {
    this.stats.messagesReceived++;
    this.stats.lastSecondCount++;
  }

  startStatsCalculation() {
    setInterval(() => {
      const now = Date.now();
      const timeDiff = now - this.stats.lastSecondTime;
      
      if (timeDiff >= 1000) {
        this.stats.messagesPerSecond = Math.round((this.stats.lastSecondCount * 1000) / timeDiff);
        this.stats.lastSecondCount = 0;
        this.stats.lastSecondTime = now;
        
        // Broadcast stats to all connections
        this.broadcastToAllPorts({
          id: 'stats-update',
          type: 'status',
          payload: {
            messagesReceived: this.stats.messagesReceived,
            messagesPerSecond: this.stats.messagesPerSecond,
            connected: this.stompConnected
          }
        });
      }
    }, 1000);
  }

  startHeartbeat() {
    if (this.config.heartbeatOutgoing > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
          this.websocket.send('\n');
        }
      }, this.config.heartbeatOutgoing);
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    this.reconnectTimer = setTimeout(() => {
      console.log('[StompWorker] Attempting to reconnect...');
      this.handleConnect('auto-reconnect', 'reconnect', this.config);
    }, this.config.reconnectDelay);
  }
}

// Initialize the SharedWorker
const stompWorker = new StompSharedWorker();

// Handle new connections
self.onconnect = (event) => {
  stompWorker.onConnect(event);
};

console.log('[StompWorker] SharedWorker initialized');
