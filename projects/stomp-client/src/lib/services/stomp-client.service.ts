import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, fromEvent, merge } from 'rxjs';
import { filter, map, takeUntil, tap, share, distinctUntilChanged } from 'rxjs/operators';
import {
  StompConfig,
  StompClientState,
  DataStreamState,
  Position,
  Trade,
  SnapshotResponse,
  StreamConfig,
  WorkerMessage,
  WorkerResponse
} from '../models/interfaces';

@Injectable({
  providedIn: 'root'
})
export class StompClientService implements OnDestroy {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private destroy$ = new Subject<void>();
  private messageId = 0;
  private pendingMessages = new Map<string, { resolve: Function; reject: Function }>();

  // State observables
  private clientStateSubject = new BehaviorSubject<StompClientState>({
    connected: false,
    connecting: false,
    messagesReceived: 0,
    messagesPerSecond: 0
  });

  private dataStreamStateSubject = new BehaviorSubject<DataStreamState>({
    active: false,
    snapshotComplete: false,
    totalRecords: 0,
    receivedRecords: 0,
    lastUpdate: new Date(),
    messagesPerSecond: 0
  });

  // Data streams
  private positionsSubject = new Subject<Position[]>();
  private positionUpdatesSubject = new Subject<Position>();
  private tradesSubject = new Subject<Trade[]>();
  private tradeUpdatesSubject = new Subject<Trade>();
  private snapshotResponseSubject = new Subject<SnapshotResponse>();

  // Public observables
  public readonly clientState$ = this.clientStateSubject.asObservable();
  public readonly dataStreamState$ = this.dataStreamStateSubject.asObservable();
  public readonly positions$ = this.positionsSubject.asObservable();
  public readonly positionUpdates$ = this.positionUpdatesSubject.asObservable();
  public readonly trades$ = this.tradesSubject.asObservable();
  public readonly tradeUpdates$ = this.tradeUpdatesSubject.asObservable();
  public readonly snapshotResponse$ = this.snapshotResponseSubject.asObservable();

  // Combined streams for convenience
  public readonly allPositions$ = merge(
    this.positions$.pipe(map(positions => ({ type: 'batch' as const, data: positions }))),
    this.positionUpdates$.pipe(map(position => ({ type: 'update' as const, data: [position] })))
  ).pipe(share());

  public readonly allTrades$ = merge(
    this.trades$.pipe(map(trades => ({ type: 'batch' as const, data: trades }))),
    this.tradeUpdates$.pipe(map(trade => ({ type: 'update' as const, data: [trade] })))
  ).pipe(share());

  constructor() {
    this.initializeWorker();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.disconnect();
  }

  /**
   * Initialize SharedWorker connection
   */
  private initializeWorker(): void {
    try {
      // Create SharedWorker with the worker script
      this.worker = new SharedWorker('/assets/stomp-worker.js', 'stomp-client-worker');
      this.port = this.worker.port;

      // Set up message handling
      this.port.onmessage = (event) => this.handleWorkerMessage(event.data);
      this.port.onmessageerror = (error) => this.handleWorkerError(error);

      // Start the port
      this.port.start();

      console.log('[StompClientService] SharedWorker initialized');
    } catch (error) {
      console.error('[StompClientService] Failed to initialize SharedWorker:', error);
      this.updateClientState({ error: `Worker initialization failed: ${error}` });
    }
  }

  /**
   * Connect to STOMP server
   */
  async connect(config: StompConfig): Promise<void> {
    if (!this.port) {
      throw new Error('SharedWorker not initialized');
    }

    this.updateClientState({ connecting: true, error: undefined });

    try {
      await this.sendWorkerMessage('connect', {
        url: config.url,
        clientId: config.clientId,
        reconnectDelay: config.reconnectDelay || 5000,
        heartbeatIncoming: config.heartbeatIncoming || 10000,
        heartbeatOutgoing: config.heartbeatOutgoing || 10000,
        debug: config.debug || false
      });

      console.log('[StompClientService] Connection initiated');
    } catch (error) {
      this.updateClientState({ 
        connecting: false, 
        error: `Connection failed: ${error}` 
      });
      throw error;
    }
  }

  /**
   * Disconnect from STOMP server
   */
  async disconnect(): Promise<void> {
    if (!this.port) return;

    try {
      await this.sendWorkerMessage('disconnect', {});
      this.updateClientState({ 
        connected: false, 
        connecting: false 
      });
    } catch (error) {
      console.error('[StompClientService] Disconnect error:', error);
    }
  }

  /**
   * Start streaming positions data
   */
  async startPositionsStream(config: StreamConfig): Promise<void> {
    if (!this.clientStateSubject.value.connected) {
      throw new Error('Not connected to STOMP server');
    }

    const destination = `/snapshot/positions/${config.clientId}`;
    
    // Subscribe to the destination
    await this.sendWorkerMessage('subscribe', {
      destination,
      headers: {}
    });

    // Send trigger message to start the stream
    const triggerDestination = `${destination}/${config.messageRate || 1000}`;
    await this.sendWorkerMessage('send', {
      destination: triggerDestination,
      body: '',
      headers: {}
    });

    this.updateDataStreamState({ 
      active: true, 
      snapshotComplete: false,
      receivedRecords: 0
    });

    console.log(`[StompClientService] Started positions stream for ${config.clientId} at ${config.messageRate} msg/sec`);
  }

  /**
   * Start streaming trades data
   */
  async startTradesStream(config: StreamConfig): Promise<void> {
    if (!this.clientStateSubject.value.connected) {
      throw new Error('Not connected to STOMP server');
    }

    const destination = `/snapshot/trades/${config.clientId}`;
    
    await this.sendWorkerMessage('subscribe', {
      destination,
      headers: {}
    });

    const triggerDestination = `${destination}/${config.messageRate || 1000}`;
    await this.sendWorkerMessage('send', {
      destination: triggerDestination,
      body: '',
      headers: {}
    });

    console.log(`[StompClientService] Started trades stream for ${config.clientId} at ${config.messageRate} msg/sec`);
  }

  /**
   * Stop all data streams
   */
  async stopAllStreams(): Promise<void> {
    // This would require tracking subscription IDs and unsubscribing
    // For now, we'll just update the state
    this.updateDataStreamState({ 
      active: false, 
      snapshotComplete: false 
    });
  }

  /**
   * Get current client state
   */
  getClientState(): StompClientState {
    return this.clientStateSubject.value;
  }

  /**
   * Get current data stream state
   */
  getDataStreamState(): DataStreamState {
    return this.dataStreamStateSubject.value;
  }

  /**
   * Send message to SharedWorker
   */
  private sendWorkerMessage(type: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('SharedWorker port not available'));
        return;
      }

      const messageId = this.generateMessageId();
      const message: WorkerMessage = {
        id: messageId,
        type: type as any,
        payload
      };

      this.pendingMessages.set(messageId, { resolve, reject });

      // Set timeout for message response
      setTimeout(() => {
        if (this.pendingMessages.has(messageId)) {
          this.pendingMessages.delete(messageId);
          reject(new Error(`Message timeout: ${type}`));
        }
      }, 10000);

      this.port.postMessage(message);
    });
  }

  /**
   * Handle messages from SharedWorker
   */
  private handleWorkerMessage(response: WorkerResponse): void {
    const { id, type, payload, error } = response;

    // Handle pending message responses
    if (this.pendingMessages.has(id)) {
      const { resolve, reject } = this.pendingMessages.get(id)!;
      this.pendingMessages.delete(id);

      if (error) {
        reject(new Error(error));
      } else {
        resolve(payload);
      }
      return;
    }

    // Handle broadcast messages
    switch (type) {
      case 'connected':
        this.updateClientState({ 
          connected: true, 
          connecting: false, 
          error: undefined 
        });
        break;

      case 'disconnected':
        this.updateClientState({ 
          connected: false, 
          connecting: false 
        });
        break;

      case 'message':
        this.handleDataMessage(payload);
        break;

      case 'status':
        this.updateClientState({
          messagesReceived: payload.messagesReceived,
          messagesPerSecond: payload.messagesPerSecond,
          connected: payload.connected
        });
        break;

      case 'error':
        this.updateClientState({ error });
        console.error('[StompClientService] Worker error:', error);
        break;

      default:
        console.log('[StompClientService] Unknown message type:', type, payload);
    }
  }

  /**
   * Handle data messages from STOMP server
   */
  private handleDataMessage(messageData: any): void {
    try {
      const { destination, data, timestamp } = messageData;

      if (typeof data === 'string') {
        // Handle completion messages
        if (data.includes('Success: All') && data.includes('records delivered')) {
          this.updateDataStreamState({ snapshotComplete: true });
          
          const match = data.match(/(\d+) records delivered/);
          if (match) {
            const totalRecords = parseInt(match[1], 10);
            this.updateDataStreamState({ totalRecords });
          }

          this.snapshotResponseSubject.next({
            type: 'complete',
            message: data,
            timestamp: new Date(timestamp),
            clientId: this.extractClientIdFromDestination(destination)
          });
          return;
        }
      }

      // Handle position data
      if (destination.includes('/positions/')) {
        if (Array.isArray(data)) {
          // Batch of positions
          const positions = data.map(this.transformPosition);
          this.positionsSubject.next(positions);
          
          this.updateDataStreamState({ 
            receivedRecords: this.dataStreamStateSubject.value.receivedRecords + positions.length,
            lastUpdate: new Date(timestamp)
          });
        } else {
          // Single position update
          const position = this.transformPosition(data);
          this.positionUpdatesSubject.next(position);
        }
      }

      // Handle trade data
      if (destination.includes('/trades/')) {
        if (Array.isArray(data)) {
          const trades = data.map(this.transformTrade);
          this.tradesSubject.next(trades);
        } else {
          const trade = this.transformTrade(data);
          this.tradeUpdatesSubject.next(trade);
        }
      }

    } catch (error) {
      console.error('[StompClientService] Error handling data message:', error);
    }
  }

  /**
   * Transform raw position data to Position interface
   */
  private transformPosition(rawData: any): Position {
    return {
      ...rawData,
      lastUpdated: new Date(rawData.lastUpdated || Date.now())
    } as Position;
  }

  /**
   * Transform raw trade data to Trade interface
   */
  private transformTrade(rawData: any): Trade {
    return {
      ...rawData,
      tradeDate: new Date(rawData.tradeDate),
      settlementDate: new Date(rawData.settlementDate)
    } as Trade;
  }

  /**
   * Extract client ID from destination path
   */
  private extractClientIdFromDestination(destination: string): string {
    const parts = destination.split('/');
    return parts[parts.length - 1] || 'unknown';
  }

  /**
   * Update client state
   */
  private updateClientState(updates: Partial<StompClientState>): void {
    const currentState = this.clientStateSubject.value;
    this.clientStateSubject.next({ ...currentState, ...updates });
  }

  /**
   * Update data stream state
   */
  private updateDataStreamState(updates: Partial<DataStreamState>): void {
    const currentState = this.dataStreamStateSubject.value;
    this.dataStreamStateSubject.next({ ...currentState, ...updates });
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    return `msg-${++this.messageId}-${Date.now()}`;
  }

  /**
   * Handle SharedWorker errors
   */
  private handleWorkerError(error: any): void {
    console.error('[StompClientService] SharedWorker error:', error);
    this.updateClientState({ 
      error: `SharedWorker error: ${error.message || error}` 
    });
  }
}
