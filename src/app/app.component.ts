import { Component, OnInit, OnDestroy } from '@angular/core';
import { ColDef, GridApi, GetRowIdParams, GridReadyEvent, StatusPanelDef } from 'ag-grid-enterprise';
import { Subject, takeUntil } from 'rxjs';
import { StompClientEnhancedService, Position, StompClientState, SnapshotStats } from './services/stomp-client-enhanced.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'angular16-app';
  private destroy$ = new Subject<void>();

  // AG Grid properties
  private gridApi!: GridApi;
  snapshotComplete = false;  // Made public for template access

  // STOMP connection state
  stompState: StompClientState = {
    connected: false,
    connecting: false,
    messagesReceived: 0,
    messagesPerSecond: 0,
    mode: 'idle'
  };

  // Statistics tracking
  statistics = {
    snapshot: {
      totalRows: 0,
      receivedRows: 0,
      startTime: null as Date | null,
      endTime: null as Date | null,
      duration: 0,
      complete: false
    },
    realtime: {
      messagesReceived: 0,
      updatesReceived: 0,
      addsReceived: 0,
      messagesPerSecond: 0,
      lastUpdateTime: null as Date | null
    },
    performance: {
      gridRows: 0,
      pendingTransactions: 0,
      lastFlushTime: null as Date | null
    }
  };

  // Performance tracking
  private performanceInterval: any;
  private messageRateBuffer: number[] = [];
  private lastMessageTime = Date.now();

  // Row Data: Real-time position data from STOMP server
  rowData: Position[] = [];
  
  // Snapshot data accumulator - collect all snapshot data before setting to grid
  private snapshotData: Position[] = [];

  // Column Definitions: Financial position columns
  colDefs: ColDef[] = [
    {
      field: "positionId",
      headerName: "Position ID",
      sortable: true,
      filter: true,
      width: 150,
      pinned: 'left',
      enableCellChangeFlash: false  // ID doesn't change, no need to flash
    },
    {
      field: "cusip",
      headerName: "CUSIP",
      sortable: true,
      filter: true,
      width: 120,
      enableCellChangeFlash: false  // Static field
    },
    {
      field: "symbol",
      headerName: "Symbol",
      sortable: true,
      filter: true,
      width: 100,
      enableCellChangeFlash: false  // Static field
    },
    {
      field: "description",
      headerName: "Description",
      sortable: true,
      filter: true,
      width: 200,
      enableCellChangeFlash: false  // Static field
    },
    {
      field: "quantity",
      headerName: "Quantity",
      sortable: true,
      filter: true,
      width: 120,
      enableValue: true,  // Enable for aggregation
      valueFormatter: (params) => params.value?.toLocaleString() || '0'
    },
    {
      field: "marketValue",
      headerName: "Market Value",
      sortable: true,
      filter: true,
      width: 150,
      enableValue: true,  // Enable for aggregation
      valueFormatter: (params) => '$' + (params.value?.toLocaleString() || '0'),
      cellStyle: (params) => {
        if (params.value > 1000000) return { backgroundColor: '#e8f5e8' };
        if (params.value < 0) return { backgroundColor: '#ffe8e8' };
        return null;
      }
    },
    {
      field: "pnl",
      headerName: "P&L",
      sortable: true,
      filter: true,
      width: 120,
      enableValue: true,  // Enable for aggregation
      valueFormatter: (params) => '$' + (params.value?.toLocaleString() || '0'),
      cellStyle: (params) => {
        if (params.value > 0) return { color: 'green', fontWeight: 'bold' };
        if (params.value < 0) return { color: 'red', fontWeight: 'bold' };
        return null;
      }
    },
    {
      field: "pnlPercent",
      headerName: "P&L %",
      sortable: true,
      filter: true,
      width: 100,
      enableValue: true,  // Enable for aggregation
      valueFormatter: (params) => (params.value?.toFixed(2) || '0.00') + '%',
      cellStyle: (params) => {
        if (params.value > 0) return { color: 'green', fontWeight: 'bold' };
        if (params.value < 0) return { color: 'red', fontWeight: 'bold' };
        return null;
      }
    },
    {
      field: "sector",
      headerName: "Sector",
      sortable: true,
      filter: true,
      width: 120,
      enableCellChangeFlash: false  // Static field
    },
    {
      field: "rating",
      headerName: "Rating",
      sortable: true,
      filter: true,
      width: 100,
      enableCellChangeFlash: false  // Static field
    },
    {
      field: "duration",
      headerName: "Duration",
      sortable: true,
      filter: true,
      width: 100,
      enableValue: true,  // Enable for aggregation
      valueFormatter: (params) => params.value?.toFixed(2) || '0.00'
    },
    {
      field: "yieldToMaturity",
      headerName: "YTM",
      sortable: true,
      filter: true,
      width: 100,
      enableValue: true,  // Enable for aggregation
      valueFormatter: (params) => (params.value?.toFixed(2) || '0.00') + '%'
    },
    {
      field: "lastUpdated",
      headerName: "Last Updated",
      sortable: true,
      filter: true,
      width: 180,
      enableCellChangeFlash: false,  // Always changes, no need to flash
      valueFormatter: (params) => {
        if (params.value) {
          const date = new Date(params.value);
          return date.toLocaleString();
        }
        return '';
      }
    }
  ];

  // Default column definition
  defaultColDef: ColDef = {
    resizable: true,
    sortable: true,
    filter: true,
    flex: 1,
    minWidth: 100,
    enableCellChangeFlash: true,  // Enable cell flashing on value changes
    equals: (valueA: any, valueB: any) => {
      // Custom equals function to properly detect changes
      if (valueA === valueB) return true;
      if (valueA == null && valueB == null) return true;
      if (valueA == null || valueB == null) return false;
      // For numbers, check with precision
      if (typeof valueA === 'number' && typeof valueB === 'number') {
        return Math.abs(valueA - valueB) < 0.0001;
      }
      return valueA === valueB;
    }
  };

  // Row ID function - uses positionId for unique identification
  getRowId = (params: GetRowIdParams<Position>) => {
    return params.data.positionId;
  };

  // Status Bar configuration
  statusBar = {
    statusPanels: [
      {
        statusPanel: 'agTotalAndFilteredRowCountComponent',
        align: 'left' as const
      },
      {
        statusPanel: 'agAggregationComponent',
        align: 'right' as const,
        statusPanelParams: {
          aggFuncs: ['sum', 'avg', 'min', 'max', 'count']
        }
      }
    ]
  };

  constructor(private stompService: StompClientEnhancedService) {}

  ngOnInit(): void {
    // Don't auto-connect, let user manually connect for debugging
    this.subscribeToStompUpdates();
    this.startPerformanceTracking();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.performanceInterval) {
      clearInterval(this.performanceInterval);
    }
    this.stompService.disconnect();
  }

  private async initializeStompConnection(): Promise<void> {
    try {
      // Reset statistics
      this.resetStatistics();
      
      // Connect to STOMP server
      await this.stompService.connect({
        url: 'ws://localhost:8080', // STOMP server running on port 8080
        clientId: 'ANGULAR_CLIENT_001',
        dataType: 'positions',
        messageRate: 1000,
        snapshotEndToken: 'Success',
        keyColumn: 'positionId',
        reconnectDelay: 5000,
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,
        debug: true
      });

      console.log('[AppComponent] Connected to STOMP server');

      // Mark snapshot start time
      this.statistics.snapshot.startTime = new Date();
      
      // The connect method already handles the snapshot request

    } catch (error) {
      console.error('[AppComponent] Failed to connect to STOMP server:', error);
    }
  }

  private subscribeToStompUpdates(): void {
    // Subscribe to connection state changes
    this.stompService.clientState$
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.stompState = state;
        console.log('[AppComponent] STOMP state updated:', state);
      });

    // Subscribe to data events (both snapshot and real-time)
    this.stompService.data
      .pipe(takeUntil(this.destroy$))
      .subscribe(positions => {
        console.log(`[AppComponent] Received ${positions.length} positions in ${this.stompState.mode} mode`);

        if (this.stompState.mode === 'snapshot') {
          // During snapshot: accumulate data, don't update grid yet
          this.snapshotData.push(...positions);
          this.statistics.snapshot.receivedRows += positions.length;
          console.log(`[AppComponent] Snapshot data accumulated: ${this.snapshotData.length} total positions`);
        } else if (this.stompState.mode === 'realtime') {
          // Real-time updates after snapshot
          this.handleRealtimeUpdates(positions);
        }
        
        this.updatePerformanceStats();
      });

    // Subscribe to snapshot complete event
    this.stompService.snapshotComplete
      .pipe(takeUntil(this.destroy$))
      .subscribe((stats: SnapshotStats) => {
        this.handleSnapshotComplete(stats);
      });

    // Subscribe to connection events
    this.stompService.connected
      .pipe(takeUntil(this.destroy$))
      .subscribe(({ clientId }) => {
        console.log('[AppComponent] Connected with clientId:', clientId);
      });

    // Subscribe to error events
    this.stompService.error
      .pipe(takeUntil(this.destroy$))
      .subscribe(error => {
        console.error('[AppComponent] STOMP error:', error);
      });
  }

  private handleRealtimeUpdates(positions: Position[]): void {
    if (!this.gridApi || !this.snapshotComplete) {
      console.warn('[AppComponent] Cannot apply updates - grid not ready or snapshot not complete');
      return;
    }

    // Create transactions for updates
    const updates: Position[] = [];
    const adds: Position[] = [];
    
    // Check which positions exist
    const existingIds = new Set(this.rowData.map(r => r.positionId));

    positions.forEach(position => {
      if (existingIds.has(position.positionId)) {
        updates.push(position);
      } else {
        adds.push(position);
      }
    });

    // Apply transaction - AG-Grid will automatically flash changed cells
    if (updates.length > 0 || adds.length > 0) {
      this.gridApi.applyTransactionAsync({
        update: updates,
        add: adds
      });

      // Update local rowData
      updates.forEach(update => {
        const index = this.rowData.findIndex(r => r.positionId === update.positionId);
        if (index >= 0) {
          this.rowData[index] = update;
        }
      });
      adds.forEach(add => {
        this.rowData.push(add);
      });
    }

    // Update statistics
    this.statistics.realtime.messagesReceived += positions.length;
    this.statistics.realtime.updatesReceived += updates.length;
    this.statistics.realtime.addsReceived += adds.length;
    this.statistics.realtime.lastUpdateTime = new Date();
  }

  private handleSnapshotComplete(stats: SnapshotStats): void {
    console.log(`[AppComponent] Snapshot complete: ${stats.rowCount} rows in ${stats.duration}ms`);
    
    // Update statistics
    this.statistics.snapshot.totalRows = stats.rowCount;
    this.statistics.snapshot.endTime = new Date();
    this.statistics.snapshot.duration = stats.duration;
    this.statistics.snapshot.complete = true;

    // Set the accumulated snapshot data to grid
    if (this.gridApi && this.snapshotData.length > 0) {
      console.log(`[AppComponent] Setting ${this.snapshotData.length} snapshot rows to grid`);
      this.rowData = [...this.snapshotData];
      
      // Clear any existing data and set new data
      this.gridApi.setGridOption('rowData', this.rowData);
      
      // Auto-size columns after data load
      setTimeout(() => {
        this.gridApi.sizeColumnsToFit();
      }, 100);
    }

    // Clear snapshot accumulator
    this.snapshotData = [];
    this.snapshotComplete = true;
    
    console.log('[AppComponent] Grid ready for real-time updates');
  }

  // AG Grid event handlers
  onGridReady(params: GridReadyEvent<Position>): void {
    this.gridApi = params.api;

    // Auto-size columns
    this.gridApi.sizeColumnsToFit();

    console.log('[AppComponent] AG Grid ready with getRowId configured for positionId');
  }

  // Manual connection controls
  async connectToStomp(): Promise<void> {
    try {
      console.log('[AppComponent] Manual connection initiated');
      await this.initializeStompConnection();
    } catch (error) {
      console.error('[AppComponent] Manual connection failed:', error);
    }
  }

  async disconnectFromStomp(): Promise<void> {
    // Flush any pending async transactions before disconnecting
    if (this.gridApi) {
      this.gridApi.flushAsyncTransactions();
    }
    await this.stompService.disconnect();
  }

  // Force flush of async transactions (useful for debugging)
  flushTransactions(): void {
    if (this.gridApi) {
      this.gridApi.flushAsyncTransactions();
      console.log('[AppComponent] Flushed all pending async transactions');
    }
  }


  // Utility methods
  getConnectionStatusColor(): string {
    if (this.stompState.connected) return 'green';
    if (this.stompState.connecting) return 'orange';
    return 'red';
  }

  getConnectionStatusText(): string {
    if (this.stompState.connected) return 'Connected';
    if (this.stompState.connecting) return 'Connecting...';
    return 'Disconnected';
  }

  // Statistics methods
  private resetStatistics(): void {
    this.statistics = {
      snapshot: {
        totalRows: 0,
        receivedRows: 0,
        startTime: null,
        endTime: null,
        duration: 0,
        complete: false
      },
      realtime: {
        messagesReceived: 0,
        updatesReceived: 0,
        addsReceived: 0,
        messagesPerSecond: 0,
        lastUpdateTime: null
      },
      performance: {
        gridRows: 0,
        pendingTransactions: 0,
        lastFlushTime: null
      }
    };
    this.messageRateBuffer = [];
    this.snapshotData = [];  // Clear snapshot accumulator
    this.snapshotComplete = false;
    this.rowData = [];
  }

  private updatePerformanceStats(): void {
    // Update grid row count
    if (this.snapshotComplete) {
      this.statistics.performance.gridRows = this.rowData.length;
    } else {
      // During snapshot, show accumulator count
      this.statistics.performance.gridRows = this.snapshotData.length;
    }

    // Calculate messages per second
    const now = Date.now();
    this.messageRateBuffer.push(now);
    
    // Keep only messages from last second
    this.messageRateBuffer = this.messageRateBuffer.filter(t => now - t < 1000);
    this.statistics.realtime.messagesPerSecond = this.messageRateBuffer.length;
  }

  private startPerformanceTracking(): void {
    // Update performance stats every second
    this.performanceInterval = setInterval(() => {
      if (this.gridApi) {
        // Update grid statistics
        const rowCount = this.gridApi.getDisplayedRowCount();
        this.statistics.performance.gridRows = rowCount;
      }

      // Update messages per second (decay if no new messages)
      const now = Date.now();
      this.messageRateBuffer = this.messageRateBuffer.filter(t => now - t < 1000);
      this.statistics.realtime.messagesPerSecond = this.messageRateBuffer.length;
    }, 1000);
  }

  getSnapshotProgress(): number {
    if (this.statistics.snapshot.totalRows === 0) {
      return this.statistics.snapshot.complete ? 100 : 0;
    }
    return Math.round((this.statistics.snapshot.receivedRows / this.statistics.snapshot.totalRows) * 100);
  }

  getTotalMessagesReceived(): number {
    return this.statistics.snapshot.receivedRows + this.statistics.realtime.messagesReceived;
  }
}
