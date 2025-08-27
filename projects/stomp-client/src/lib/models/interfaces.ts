// Core STOMP and WebSocket interfaces
export interface StompConfig {
  url: string;
  clientId: string;
  reconnectDelay?: number;
  heartbeatIncoming?: number;
  heartbeatOutgoing?: number;
  debug?: boolean;
}

export interface StompMessage {
  command: string;
  headers: { [key: string]: string };
  body: string;
}

// Financial data interfaces based on STOMP server schema
export interface Position {
  positionId: string;
  cusip: string;
  symbol?: string;
  description?: string;
  quantity: number;
  marketValue: number;
  bookValue: number;
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
  riskMetrics?: RiskMetrics;
  analytics?: Analytics;
  liquidity?: LiquidityMetrics;
  compliance?: ComplianceMetrics;
  lastUpdated: Date;
}

export interface RiskMetrics {
  var95?: number;
  var99?: number;
  expectedShortfall?: number;
  sharpeRatio?: number;
  informationRatio?: number;
  trackingError?: number;
  beta?: number;
  alpha?: number;
}

export interface Analytics {
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    rho?: number;
  };
  scenarioAnalysis?: {
    parallelShiftUp100?: number;
    parallelShiftDown100?: number;
    steepening50?: number;
    flattening50?: number;
  };
}

export interface LiquidityMetrics {
  bidAskSpread?: number;
  liquidityScore?: number;
  averageDailyVolume?: number;
  daysToLiquidate?: number;
}

export interface ComplianceMetrics {
  regulatoryCapital?: number;
  rwa?: number;
  leverageRatio?: number;
  breachStatus?: string;
  limitUtilization?: number;
}

export interface Trade {
  tradeId: string;
  cusip: string;
  tradeDate: Date;
  settlementDate: Date;
  quantity: number;
  price: number;
  tradeValue: number;
  side: 'BUY' | 'SELL';
  counterparty?: string;
  trader?: string;
  status: 'PENDING' | 'SETTLED' | 'FAILED';
  commission?: number;
  fees?: number;
}

// API Response interfaces
export interface SnapshotResponse {
  type: 'snapshot' | 'update' | 'complete' | 'error';
  data?: Position[] | Position;
  message?: string;
  timestamp: Date;
  clientId: string;
  totalRecords?: number;
  deliveredRecords?: number;
}

export interface StreamConfig {
  dataType: 'positions' | 'trades';
  clientId: string;
  messageRate?: number;
  batchSize?: number;
  enableLiveUpdates?: boolean;
}

// Worker communication interfaces
export interface WorkerMessage {
  id: string;
  type: 'connect' | 'disconnect' | 'subscribe' | 'unsubscribe' | 'send' | 'config';
  payload?: any;
}

export interface WorkerResponse {
  id: string;
  type: 'connected' | 'disconnected' | 'message' | 'error' | 'status';
  payload?: any;
  error?: string;
}

// Service API interfaces
export interface StompClientState {
  connected: boolean;
  connecting: boolean;
  error?: string;
  lastHeartbeat?: Date;
  messagesReceived: number;
  messagesPerSecond: number;
}

export interface DataStreamState {
  active: boolean;
  snapshotComplete: boolean;
  totalRecords: number;
  receivedRecords: number;
  lastUpdate: Date;
  messagesPerSecond: number;
}
