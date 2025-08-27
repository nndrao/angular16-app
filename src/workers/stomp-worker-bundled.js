/**
 * SharedWorker for STOMP server communication using @stomp/stompjs (bundled version)
 * This version imports @stomp/stompjs from npm instead of CDN
 */

import { Client } from '@stomp/stompjs';

class StompSharedWorker {
  constructor() {
    this.connections = new Map(); // Port connections from different tabs/components
    this.stompClient = null;
    this.stompConnected = false;
    this.config = null;
    this.subscriptions = new Map();
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

  // Connect to STOMP server using @stomp/stompjs
  handleConnect(connectionId, messageId, config) {
    this.config = { ...this.config, ...config };
    
    if (this.stompClient && this.stompClient.connected) {
      this.sendToPort(connectionId, {
        id: messageId,
        type: 'connected',
        payload: { alreadyConnected: true }
      });
      return;
    }

    try {
      // Create STOMP client using imported Client class
      this.stompClient = new Client({
        brokerURL: this.config.url,
        connectHeaders: {
          login: this.config.login || '',
          passcode: this.config.passcode || '',
          host: this.config.clientId || 'stomp-client'
        },
        debug: this.config.debug ? (str) => console.log('[STOMP Debug]', str) : undefined,
        reconnectDelay: this.config.reconnectDelay || 5000,
        heartbeatIncoming: this.config.heartbeatIncoming || 10000,
        heartbeatOutgoing: this.config.heartbeatOutgoing || 10000,
        
        // Connection callbacks
        onConnect: (frame) => this.onStompConnect(connectionId, messageId, frame),
        onDisconnect: (frame) => this.onStompDisconnect(frame),
        onStompError: (frame) => this.onStompError(connectionId, messageId, frame),
        onWebSocketError: (error) => this.onWebSocketError(connectionId, messageId, error),
        onWebSocketClose: (event) => this.onWebSocketClose(event)
      });

      // Activate the client
      this.stompClient.activate();
      
    } catch (error) {
      this.sendError(connectionId, messageId, `Connection failed: ${error.message}`);
    }
  }

  // STOMP.js event handlers
  onStompConnect(connectionId, messageId, frame) {
    console.log('[StompWorker] STOMP connected', frame);
    this.stompConnected = true;
    
    // Notify all connections
    this.broadcastToAllPorts({
      id: 'stomp-connected',
      type: 'connected',
      payload: { stompConnected: true }
    });

    // Send response to the requesting connection
    this.sendToPort(connectionId, {
      id: messageId,
      type: 'connected',
      payload: { frame }
    });
  }

  onStompDisconnect(frame) {
    console.log('[StompWorker] STOMP disconnected', frame);
    this.stompConnected = false;
    
    this.broadcastToAllPorts({
      id: 'stomp-disconnected',
      type: 'disconnected',
      payload: { frame }
    });
  }

  onStompError(connectionId, messageId, frame) {
    console.error('[StompWorker] STOMP error:', frame);
    
    this.sendError(connectionId, messageId, `STOMP Error: ${frame.body}`);
    
    this.broadcastToAllPorts({
      id: 'stomp-error',
      type: 'error',
      error: `STOMP Error: ${frame.body}`,
      payload: { frame }
    });
  }

  onWebSocketClose(event) {
    console.log('[StompWorker] WebSocket closed:', event.code, event.reason);
    this.stompConnected = false;
    
    this.broadcastToAllPorts({
      id: 'stomp-disconnected',
      type: 'disconnected',
      payload: { code: event.code, reason: event.reason }
    });
  }

  onWebSocketError(connectionId, messageId, error) {
    console.error('[StompWorker] WebSocket error:', error);
    this.sendError(connectionId, messageId, `WebSocket error: ${error.message || error}`);
  }

  // Message handling using STOMP.js
  handleStompMessage(message) {
    this.updateStats();
    
    try {
      const messageData = {
        destination: message.headers.destination,
        headers: message.headers,
        body: message.body,
        timestamp: new Date()
      };

      // Parse JSON body if possible
      try {
        messageData.data = JSON.parse(message.body);
      } catch (e) {
        messageData.data = message.body;
      }

      // Broadcast to subscribed connections
      this.broadcastToSubscribers(messageData.destination, {
        id: this.generateId(),
        type: 'message',
        payload: messageData
      });
      
    } catch (error) {
      console.error('[StompWorker] Error handling STOMP message:', error);
    }
  }

  // Subscription management using STOMP.js
  handleSubscribe(connectionId, messageId, { destination, headers = {} }) {
    if (!this.stompConnected || !this.stompClient) {
      this.sendError(connectionId, messageId, 'Not connected to STOMP server');
      return;
    }

    try {
      const subscriptionId = this.generateId();
      
      // Subscribe using STOMP.js
      const subscription = this.stompClient.subscribe(destination, 
        (message) => this.handleStompMessage(message),
        { id: subscriptionId, ...headers }
      );
      
      // Track subscription
      this.subscriptions.set(subscriptionId, {
        destination,
        connectionId,
        headers,
        subscription // Store the STOMP.js subscription object
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
      
    } catch (error) {
      this.sendError(connectionId, messageId, `Subscription failed: ${error.message}`);
    }
  }

  handleUnsubscribe(connectionId, messageId, { subscriptionId }) {
    const subscriptionData = this.subscriptions.get(subscriptionId);
    if (!subscriptionData) {
      this.sendError(connectionId, messageId, 'Subscription not found');
      return;
    }

    try {
      // Unsubscribe using STOMP.js
      if (subscriptionData.subscription) {
        subscriptionData.subscription.unsubscribe();
      }
      
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
      
    } catch (error) {
      this.sendError(connectionId, messageId, `Unsubscribe failed: ${error.message}`);
    }
  }

  handleSend(connectionId, messageId, { destination, body = '', headers = {} }) {
    if (!this.stompConnected || !this.stompClient) {
      this.sendError(connectionId, messageId, 'Not connected to STOMP server');
      return;
    }

    try {
      // Send using STOMP.js
      this.stompClient.publish({
        destination: destination,
        body: body,
        headers: {
          'content-type': 'text/plain',
          ...headers
        }
      });
      
      this.sendToPort(connectionId, {
        id: messageId,
        type: 'sent',
        payload: { destination, body }
      });
      
    } catch (error) {
      this.sendError(connectionId, messageId, `Send failed: ${error.message}`);
    }
  }

  // Rest of the utility methods remain the same...
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
    if (this.connections.size === 0 && this.stompClient) {
      this.stompClient.deactivate();
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
    this.connections.forEach((_, connectionId) => {
      this.sendToPort(connectionId, message);
    });
  }

  broadcastToSubscribers(destination, message) {
    this.subscriptions.forEach((subscription) => {
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
}

// Initialize the SharedWorker
const stompWorker = new StompSharedWorker();

// Handle new connections
self.onconnect = (event) => {
  stompWorker.onConnect(event);
};

console.log('[StompWorker] SharedWorker initialized with bundled @stomp/stompjs');
