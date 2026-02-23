export const MIC_LISTENING = 'listening';
export const MIC_MUTED = 'muted';

export const CONNECTION_UNKNOWN = 'unknown';
export const CONNECTION_CONNECTED = 'connected';
export const CONNECTION_RECONNECTING = 'reconnecting';
export const CONNECTION_DISCONNECTED = 'disconnected';
export const CONNECTION_ERROR = 'error';

export const MUTE_REASON_NONE = 'none';
export const MUTE_REASON_MANUAL = 'manual';
export const MUTE_REASON_AUTO = 'auto';

export const OS_EVENT_CLICK = 0;
export const OS_EVENT_SCROLL_TOP = 1;
export const OS_EVENT_SCROLL_BOTTOM = 2;
export const OS_EVENT_DOUBLE_CLICK = 3;

export function nextManualMicToggle({ micState }) {
  if (micState === MIC_MUTED) {
    return {
      micState: MIC_LISTENING,
      muteReason: MUTE_REASON_NONE,
      micEnabled: true,
    };
  }

  return {
    micState: MIC_MUTED,
    muteReason: MUTE_REASON_MANUAL,
    micEnabled: false,
  };
}

export function toggleFocusMode(current) {
  return !Boolean(current);
}

export function computeAutoMuteTrigger({
  connectionState,
  deviceKnown,
  deviceConnected,
  isWearing,
  isInCase,
}) {
  if (
    connectionState === CONNECTION_RECONNECTING ||
    connectionState === CONNECTION_DISCONNECTED ||
    connectionState === CONNECTION_ERROR
  ) {
    return 'backend_disconnected';
  }

  if (!deviceKnown) return null;

  if (deviceConnected === false) return 'device_disconnected';
  if (isWearing === false) return 'not_wearing';
  if (isInCase === true) return 'in_case';

  return null;
}

export function shouldAutoResume({ micState, muteReason, autoMuteTrigger }) {
  return micState === MIC_MUTED && muteReason === MUTE_REASON_AUTO && !autoMuteTrigger;
}

export function compactStatusLabel({ micState, connectionState }) {
  const mic = micState === MIC_MUTED ? MIC_MUTED : MIC_LISTENING;

  if (connectionState === CONNECTION_CONNECTED) {
    return `${mic} | connected`;
  }
  if (connectionState === CONNECTION_RECONNECTING) {
    return `${mic} | reconnecting`;
  }
  if (connectionState === CONNECTION_DISCONNECTED) {
    return `${mic} | disconnected`;
  }
  if (connectionState === CONNECTION_ERROR) {
    return `${mic} | error`;
  }

  return `${mic} | initializing`;
}
