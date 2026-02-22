const test = require('node:test');
const assert = require('node:assert/strict');

test('nextManualMicToggle switches between listening and muted states', async () => {
  const ux = await import('../src/uxState.mjs');

  const muted = ux.nextManualMicToggle({
    micState: ux.MIC_LISTENING,
    muteReason: ux.MUTE_REASON_NONE,
  });
  assert.equal(muted.micState, ux.MIC_MUTED);
  assert.equal(muted.muteReason, ux.MUTE_REASON_MANUAL);
  assert.equal(muted.micEnabled, false);

  const listening = ux.nextManualMicToggle({
    micState: ux.MIC_MUTED,
    muteReason: ux.MUTE_REASON_AUTO,
  });
  assert.equal(listening.micState, ux.MIC_LISTENING);
  assert.equal(listening.muteReason, ux.MUTE_REASON_NONE);
  assert.equal(listening.micEnabled, true);
});

test('computeAutoMuteTrigger applies all selected safety signals', async () => {
  const ux = await import('../src/uxState.mjs');

  assert.equal(
    ux.computeAutoMuteTrigger({
      connectionState: ux.CONNECTION_DISCONNECTED,
      deviceKnown: false,
      deviceConnected: true,
      isWearing: true,
      isInCase: false,
    }),
    'backend_disconnected',
  );

  assert.equal(
    ux.computeAutoMuteTrigger({
      connectionState: ux.CONNECTION_CONNECTED,
      deviceKnown: true,
      deviceConnected: false,
      isWearing: true,
      isInCase: false,
    }),
    'device_disconnected',
  );

  assert.equal(
    ux.computeAutoMuteTrigger({
      connectionState: ux.CONNECTION_CONNECTED,
      deviceKnown: true,
      deviceConnected: true,
      isWearing: false,
      isInCase: false,
    }),
    'not_wearing',
  );

  assert.equal(
    ux.computeAutoMuteTrigger({
      connectionState: ux.CONNECTION_CONNECTED,
      deviceKnown: true,
      deviceConnected: true,
      isWearing: true,
      isInCase: true,
    }),
    'in_case',
  );

  assert.equal(
    ux.computeAutoMuteTrigger({
      connectionState: ux.CONNECTION_CONNECTED,
      deviceKnown: true,
      deviceConnected: true,
      isWearing: true,
      isInCase: false,
    }),
    null,
  );
});

test('shouldAutoResume only returns true for auto-muted state with healthy signals', async () => {
  const ux = await import('../src/uxState.mjs');

  assert.equal(
    ux.shouldAutoResume({
      micState: ux.MIC_MUTED,
      muteReason: ux.MUTE_REASON_AUTO,
      autoMuteTrigger: null,
    }),
    true,
  );

  assert.equal(
    ux.shouldAutoResume({
      micState: ux.MIC_MUTED,
      muteReason: ux.MUTE_REASON_MANUAL,
      autoMuteTrigger: null,
    }),
    false,
  );

  assert.equal(
    ux.shouldAutoResume({
      micState: ux.MIC_LISTENING,
      muteReason: ux.MUTE_REASON_NONE,
      autoMuteTrigger: null,
    }),
    false,
  );

  assert.equal(
    ux.shouldAutoResume({
      micState: ux.MIC_MUTED,
      muteReason: ux.MUTE_REASON_AUTO,
      autoMuteTrigger: 'backend_disconnected',
    }),
    false,
  );
});

test('toggleFocusMode flips boolean state', async () => {
  const ux = await import('../src/uxState.mjs');

  assert.equal(ux.toggleFocusMode(false), true);
  assert.equal(ux.toggleFocusMode(true), false);
});

test('mapScrollEventToDelta inverts scroll direction', async () => {
  const ux = await import('../src/uxState.mjs');

  assert.equal(ux.mapScrollEventToDelta(ux.OS_EVENT_SCROLL_TOP, 100, true), 100);
  assert.equal(ux.mapScrollEventToDelta(ux.OS_EVENT_SCROLL_BOTTOM, 100, true), -100);

  assert.equal(ux.mapScrollEventToDelta(ux.OS_EVENT_SCROLL_TOP, 100, false), -100);
  assert.equal(ux.mapScrollEventToDelta(ux.OS_EVENT_SCROLL_BOTTOM, 100, false), 100);

  assert.equal(ux.mapScrollEventToDelta(ux.OS_EVENT_CLICK, 100, true), 0);
});
