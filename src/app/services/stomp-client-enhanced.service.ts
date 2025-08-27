import { Injectable, OnDestroy, EventEmitter } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

// Configuration interfaces
export interface StompConfig {
  url: string;
  clientId?: string;
  dataType?: 'positions' | 'trades';
  messageRate?: number;
  batchSize?: number;
  snapshotEndToken?: string;
  keyColumn?: string;
  reconnectDelay?: number;
  heartbeatIncoming?: number;
  heartbeatOutgoing?: number;
  debug?: boolean;
  snapshotTimeoutMs?: number;
}

export interface StompClientState {
  connected: boolean;
  connecting: boolean;
  error?: string;
  messagesReceived: number;
  messagesPerSecond: number;
  mode: 'idle' | 'snapshot' | 'realtime';
}

export interface SnapshotStats {
  rowCount: number;
  duration: number;
  startTime?: Date;
  endTime?: Date;
}

export interface Position {
  positionId: string;
  cusip: string;
  symbol?: string;
  description?: string;
  quantity: number;
  marketValue: number;
  bookValue?: number;
  pnl: number;
  pnlPercent: number;
  sector?: string;
  industry?: string;
  rating?: string;
  maturityDate?: string;
  couponRate?: number;
  duration?: number;
  convexity?: number;
  yieldToMaturity?: number;
  spreadToBenchmark?: number;
  lastUpdated: Date;
}

@Injectable({
  providedIn: 'root'
})
export class StompClientEnhancedService implements OnDestroy {
  // Event emitters for different events
  public readonly connected = new EventEmitter<{ clientId: string }>();
  public readonly disconnected = new EventEmitter<void>();
  public readonly data = new EventEmitter<Position[]>();
  public readonly snapshotComplete = new EventEmitter<SnapshotStats>();
  public readonly error = new EventEmitter<Error>();
  
  // State management
  private clientStateSubject = new BehaviorSubject<StompClientState>({
    connected: false,
    connecting: false,
    messagesReceived: 0,
    messagesPerSecond: 0,
    mode: 'idle'
  });
  
  public readonly clientState$ = this.clientStateSubject.asObservable();
  
  // Worker communication
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private providerId: string = '';
  
  // Snapshot tracking
  private snapshotStartTime: number = 0;
  private rowCount: number = 0;
  private isReceivingSnapshot: boolean = false;
  
  // Message rate tracking
  private messageRateBuffer: number[] = [];
  private messageRateInterval: any;
  
  constructor() {
    this.initializeWorker();
    this.startMessageRateTracking();
  }
  
  ngOnDestroy(): void {
    this.disconnect();
    if (this.messageRateInterval) {
      clearInterval(this.messageRateInterval);
    }
  }
  
  private initializeWorker(): void {
    try {
      // Use enhanced worker
      this.worker = new SharedWorker('/assets/stomp-worker-enhanced.js', 'stomp-worker-enhanced');
      this.port = this.worker.port;
      
      this.port.onmessage = (event) => this.handleWorkerMessage(event.data);
      this.port.onmessageerror = (error) => this.handleWorkerError(error);
      this.port.start();
      
      console.log('[StompClientEnhanced] SharedWorker initialized');
    } catch (error) {
      console.error('[StompClientEnhanced] Failed to initialize SharedWorker:', error);
      this.updateClientState({ error: `Worker initialization failed: ${error}` });
      this.error.emit(error as Error);
    }
  }
  
  async connect(config: StompConfig): Promise<void> {
    if (!this.port) {
      throw new Error('SharedWorker not initialized');
    }
    
    this.updateClientState({ connecting: true, error: undefined, mode: 'idle' });
    
    // Generate provider ID
    this.providerId = this.generateProviderId(config.clientId);
    
    // Reset snapshot tracking
    this.snapshotStartTime = Date.now();
    this.rowCount = 0;
    this.isReceivingSnapshot = true;
    
    try {
      // Send connect request to worker
      await this.sendWorkerMessage('connect', {
        providerId: this.providerId,
        config: {
          websocketUrl: config.url,
          dataType: config.dataType || 'positions',
          messageRate: config.messageRate || 1000,
          batchSize: config.batchSize,
          snapshotEndToken: config.snapshotEndToken || 'success',
          keyColumn: config.keyColumn || 'positionId',
          snapshotTimeoutMs: config.snapshotTimeoutMs || 30000
        }
      });
      
      console.log('[StompClientEnhanced] Connection request sent');
    } catch (error) {
      this.updateClientState({ 
        connecting: false, 
        error: `Connection failed: ${error}` 
      });
      this.error.emit(error as Error);
      throw error;
    }
  }
  
  async disconnect(): Promise<void> {
    if (!this.port || !this.providerId) return;
    
    try {
      await this.sendWorkerMessage('disconnect', {
        providerId: this.providerId
      });
      
      this.updateClientState({ 
        connected: false, 
        connecting: false,
        mode: 'idle'
      });
      
      this.disconnected.emit();
    } catch (error) {
      console.error('[StompClientEnhanced] Disconnect error:', error);
      this.error.emit(error as Error);
    }
  }
  
  async refresh(): Promise<void> {
    if (!this.port || !this.providerId) {
      throw new Error('Not connected');
    }
    
    // Reset state for new snapshot
    this.snapshotStartTime = Date.now();
    this.rowCount = 0;
    this.isReceivingSnapshot = true;
    this.updateClientState({ mode: 'idle' });
    
    try {
      await this.sendWorkerMessage('refresh', {
        providerId: this.providerId
      });
      
      console.log('[StompClientEnhanced] Refresh request sent');
    } catch (error) {
      console.error('[StompClientEnhanced] Refresh error:', error);
      this.error.emit(error as Error);
      throw error;
    }
  }
  
  async getSnapshot(): Promise<Position[]> {
    if (!this.port || !this.providerId) {
      return [];
    }
    
    try {
      const response = await this.sendWorkerMessage('get-snapshot', {
        providerId: this.providerId
      });
      
      return response.data || [];
    } catch (error) {
      console.error('[StompClientEnhanced] Get snapshot error:', error);
      return [];
    }
  }
  
  private sendWorkerMessage(type: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('SharedWorker port not available'));
        return;
      }
      
      const messageId = this.generateMessageId();
      const message = {
        id: messageId,
        type,
        ...payload
      };
      
      // Set up one-time response handler
      const responseHandler = (event: MessageEvent) => {
        const response = event.data;
        if (response.id === messageId) {
          this.port!.removeEventListener('message', responseHandler);
          
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        }
      };
      
      this.port.addEventListener('message', responseHandler);
      this.port.postMessage(message);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        this.port!.removeEventListener('message', responseHandler);
        reject(new Error(`Message timeout: ${type}`));
      }, 10000);
    });
  }
  
  private handleWorkerMessage(message: any): void {
    const { type, providerId, data, error: errorMsg } = message;
    
    // Ignore messages for other providers
    if (providerId && providerId !== this.providerId) {
      return;
    }
    
    switch (type) {
      case 'connected':
        this.handleConnected(message);
        break;
        
      case 'disconnected':
        this.handleDisconnected();
        break;
        
      case 'data':
        this.handleData(data);
        break;
        
      case 'snapshot-complete':
        this.handleSnapshotComplete(message);
        break;
        
      case 'error':
        this.handleError(new Error(errorMsg || 'Unknown error'));
        break;
        
      case 'status':
        this.handleStatus(message);
        break;
        
      default:
        // Response to a request - handled by sendWorkerMessage
        break;
    }
  }
  
  private handleConnected(message: any): void {
    this.updateClientState({ 
      connected: true, 
      connecting: false,
      mode: 'snapshot',
      error: undefined
    });
    
    this.connected.emit({ clientId: message.clientId || this.providerId });
    console.log('[StompClientEnhanced] Connected successfully');
  }
  
  private handleDisconnected(): void {
    this.updateClientState({ 
      connected: false, 
      connecting: false,
      mode: 'idle'
    });
    
    this.disconnected.emit();
    console.log('[StompClientEnhanced] Disconnected');
  }
  
  private handleData(data: any): void {
    if (!data) return;
    
    const positions = Array.isArray(data) ? data : [data];
    
    // Transform and emit data
    const transformedPositions = positions.map(this.transformPosition);
    
    if (this.isReceivingSnapshot) {
      this.rowCount += positions.length;
    }
    
    // Track message rate
    this.messageRateBuffer.push(Date.now());
    
    // Update state
    const currentState = this.clientStateSubject.value;
    this.updateClientState({
      messagesReceived: currentState.messagesReceived + positions.length
    });
    
    // Emit data
    this.data.emit(transformedPositions);
  }
  
  private handleSnapshotComplete(message: any): void {
    this.isReceivingSnapshot = false;
    
    const duration = Date.now() - this.snapshotStartTime;
    const stats: SnapshotStats = {
      rowCount: message.rowCount || this.rowCount,
      duration,
      startTime: new Date(this.snapshotStartTime),
      endTime: new Date()
    };
    
    this.updateClientState({ mode: 'realtime' });
    this.snapshotComplete.emit(stats);
    
    console.log(`[StompClientEnhanced] Snapshot complete: ${stats.rowCount} rows in ${stats.duration}ms`);
  }
  
  private handleError(error: Error): void {
    this.updateClientState({ error: error.message });
    this.error.emit(error);
    console.error('[StompClientEnhanced] Error:', error);
  }
  
  private handleStatus(status: any): void {
    if (status.statistics) {
      // Update message rate from worker statistics
      const stats = status.statistics;
      this.updateClientState({
        messagesReceived: stats.snapshotRowsReceived + stats.updateRowsReceived
      });
    }
  }
  
  private handleWorkerError(error: any): void {
    console.error('[StompClientEnhanced] SharedWorker error:', error);
    this.updateClientState({ 
      error: `SharedWorker error: ${error.message || error}` 
    });
    this.error.emit(new Error(`SharedWorker error: ${error.message || error}`));
  }
  
  private transformPosition(rawData: any): Position {
    return {
      ...rawData,
      lastUpdated: new Date(rawData.lastUpdated || Date.now())
    } as Position;
  }
  
  private updateClientState(updates: Partial<StompClientState>): void {
    const currentState = this.clientStateSubject.value;
    this.clientStateSubject.next({ ...currentState, ...updates });
  }
  
  private startMessageRateTracking(): void {
    this.messageRateInterval = setInterval(() => {
      const now = Date.now();
      this.messageRateBuffer = this.messageRateBuffer.filter(t => now - t < 1000);
      
      this.updateClientState({
        messagesPerSecond: this.messageRateBuffer.length
      });
    }, 1000);
  }
  
  private generateProviderId(clientId?: string): string {
    if (clientId) return clientId;
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    return `provider-${timestamp}-${random}`;
  }
  
  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
  
  getClientState(): StompClientState {
    return this.clientStateSubject.value;
  }
  
  isConnected(): boolean {
    return this.clientStateSubject.value.connected;
  }
}