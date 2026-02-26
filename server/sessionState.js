class ClientSessionState {
  constructor(clientId) {
    this.clientId = clientId;
    this.running = false;
    this.threadId = null;
    this.activeTurnId = null;

    this.metrics = {
      framesReceived: 0,
      framesDropped: 0,
      sttFinals: 0,
      turnsStarted: 0,
      turnsSteered: 0,
      sessionStartRequests: 0,
      sessionStartInFlightRejected: 0,
      codexTransportLosses: 0,
      codexRecoveryAttempts: 0,
      codexRecoverySuccesses: 0,
      codexRecoveryFailures: 0,
      codexLastRecoveryLatencyMs: null,
      threadResumeSuccesses: 0,
      threadResumeFailures: 0,
      lastError: null,
    };
  }

  markRunning(threadId) {
    this.running = true;
    this.threadId = threadId;
  }

  markStopped() {
    this.running = false;
    this.threadId = null;
    this.activeTurnId = null;
  }

  setActiveTurn(turnId) {
    this.activeTurnId = turnId || null;
  }

  clearActiveTurn() {
    this.activeTurnId = null;
  }

  resetMetrics() {
    this.metrics = {
      framesReceived: 0,
      framesDropped: 0,
      sttFinals: 0,
      turnsStarted: 0,
      turnsSteered: 0,
      sessionStartRequests: 0,
      sessionStartInFlightRejected: 0,
      codexTransportLosses: 0,
      codexRecoveryAttempts: 0,
      codexRecoverySuccesses: 0,
      codexRecoveryFailures: 0,
      codexLastRecoveryLatencyMs: null,
      threadResumeSuccesses: 0,
      threadResumeFailures: 0,
      lastError: null,
    };
  }
}

module.exports = {
  ClientSessionState,
};
