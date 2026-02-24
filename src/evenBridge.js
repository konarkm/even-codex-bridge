import {
  OsEventTypeList,
  StartUpPageCreateResult,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

const STATUS_CONTAINER_ID = 1;
const STATUS_CONTAINER_NAME = 'ambient-status';
const CONTENT_CONTAINER_ID = 2;
const CONTENT_CONTAINER_NAME = 'ambient-main';
const LIST_CAPTURE_CONTAINER_ID = 3;
const LIST_CAPTURE_CONTAINER_NAME = 'ambient-capture';
const INITIAL_STATUS_TEXT = 'listening | init | starting';
const INITIAL_CONTENT_TEXT = '';
const STATUS_CONTAINER_FRAME = {
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 36,
  borderWidth: 0,
  borderColor: 7,
  borderRdaius: 0,
  paddingLength: 0,
};
const CONTENT_CONTAINER_FRAME = {
  xPosition: 0,
  yPosition: 38,
  width: 576,
  height: 250,
  borderWidth: 1,
  borderColor: 7,
  borderRdaius: 2,
  paddingLength: 6,
};
const LIST_CAPTURE_CONTAINER_FRAME = {
  xPosition: 0,
  yPosition: 282,
  width: 20,
  height: 6,
  borderWidth: 0,
  borderColor: 0,
  borderRdaius: 0,
  paddingLength: 0,
};
const STATUS_MAX_CHARS = 56;

function normalizeStatusSegment(value, maxChars) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return compact.slice(0, maxChars);
}

function normalizeOsEventType(rawType) {
  const direct = OsEventTypeList.fromJson(rawType);
  if (direct != null) return direct;

  // Some firmware builds send eventType as numeric strings (e.g. "0").
  // The SDK parser handles numeric values, but not numeric-string values.
  if (typeof rawType === 'string' && /^[0-9]+$/.test(rawType.trim())) {
    const parsed = Number(rawType.trim());
    return OsEventTypeList.fromJson(parsed);
  }

  return undefined;
}

function normalizeStartResult(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  return -1;
}

export class EvenBridgeController {
  constructor(logger, options = {}) {
    this.logger = logger;
    this.bridge = null;
    this.initialized = false;
    this.eventCaptureMode = options.eventCaptureMode === 'list' ? 'list' : 'text';
    this.lastStatusText = '';
    this.lastContentText = '';
    this.audioSubscribers = new Set();
    this.textSubscribers = new Set();
    this.uiSubscribers = new Set();
    this.hubUnsubscribe = null;
  }

  async init() {
    if (this.initialized) return;

    this.bridge = await waitForEvenAppBridge();
    this.logger?.info?.('Initializing Even bridge containers', {
      eventCaptureMode: this.eventCaptureMode,
    });
    const startupContainer = this.#buildTextContainers(INITIAL_STATUS_TEXT, INITIAL_CONTENT_TEXT);

    const startupResult = await this.bridge.createStartUpPageContainer(startupContainer);

    const normalizedResult = normalizeStartResult(startupResult);
    if (normalizedResult === StartUpPageCreateResult.success) {
      this.initialized = true;
      this.lastStatusText = INITIAL_STATUS_TEXT;
      this.lastContentText = INITIAL_CONTENT_TEXT;
      return;
    }

    if (normalizedResult === StartUpPageCreateResult.invalid) {
      // SDK behavior: startup container creation is one-time; a second call returns invalid.
      this.logger?.warn?.('createStartUpPageContainer returned invalid; startup container likely already exists');
      const rebuilt = await this.bridge.rebuildPageContainer(startupContainer);
      if (rebuilt) {
        this.logger?.info?.('rebuildPageContainer succeeded after invalid startup create');
      } else {
        this.logger?.warn?.('rebuildPageContainer failed after invalid startup create; trying textContainerUpgrade fallback');
        const statusUpgraded = await this.bridge.textContainerUpgrade({
          containerID: STATUS_CONTAINER_ID,
          containerName: STATUS_CONTAINER_NAME,
          content: INITIAL_STATUS_TEXT,
        });
        const contentUpgraded = await this.bridge.textContainerUpgrade({
          containerID: CONTENT_CONTAINER_ID,
          containerName: CONTENT_CONTAINER_NAME,
          content: INITIAL_CONTENT_TEXT,
        });
        if (!statusUpgraded || !contentUpgraded) {
          this.logger?.warn?.('textContainerUpgrade fallback also failed; continuing with existing SDK UI state');
        }
      }

      this.initialized = true;
      this.lastStatusText = INITIAL_STATUS_TEXT;
      this.lastContentText = INITIAL_CONTENT_TEXT;
      return;
    }

    if (normalizedResult !== StartUpPageCreateResult.success) {
      throw new Error(`createStartUpPageContainer failed with code ${normalizedResult}`);
    }
  }

  async getDeviceInfo() {
    if (!this.bridge) return null;
    try {
      return await this.bridge.getDeviceInfo();
    } catch {
      return null;
    }
  }

  subscribeAudio(onAudioFrame) {
    if (!this.bridge) {
      throw new Error('Even bridge not initialized');
    }

    this.audioSubscribers.add(onAudioFrame);
    this.#ensureHubListener();
    return () => {
      this.audioSubscribers.delete(onAudioFrame);
      this.#cleanupHubListenerIfIdle();
    };
  }

  subscribeTextEvents(onTextEvent) {
    if (!this.bridge) {
      throw new Error('Even bridge not initialized');
    }

    this.textSubscribers.add(onTextEvent);
    this.#ensureHubListener();
    return () => {
      this.textSubscribers.delete(onTextEvent);
      this.#cleanupHubListenerIfIdle();
    };
  }

  subscribeUiEvents(onUiEvent) {
    if (!this.bridge) {
      throw new Error('Even bridge not initialized');
    }

    this.uiSubscribers.add(onUiEvent);
    this.#ensureHubListener();
    return () => {
      this.uiSubscribers.delete(onUiEvent);
      this.#cleanupHubListenerIfIdle();
    };
  }

  subscribeDeviceStatus(onDeviceStatus) {
    if (!this.bridge) {
      throw new Error('Even bridge not initialized');
    }

    return this.bridge.onDeviceStatusChanged((status) => {
      onDeviceStatus(status);
    });
  }

  async setMicEnabled(enabled) {
    if (!this.bridge || !this.initialized) {
      throw new Error('Even bridge not initialized');
    }

    const desired = Boolean(enabled);
    const ok = await this.bridge.audioControl(desired);
    if (ok) return;

    // Some firmware/build combinations can transiently reject mic toggles;
    // retry once before surfacing a hard failure.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const retryOk = await this.bridge.audioControl(desired);
    if (!retryOk) {
      throw new Error(`Failed to ${enabled ? 'open' : 'close'} mic via audioControl(${enabled ? 'true' : 'false'})`);
    }
  }

  async startMic() {
    await this.setMicEnabled(true);
  }

  async stopMic() {
    if (!this.bridge || !this.initialized) return;

    try {
      await this.setMicEnabled(false);
    } catch {
      // No-op.
    }
  }

  async updateStatus(statusText) {
    if (!this.bridge || !this.initialized) return;

    const content = normalizeStatusSegment(statusText, STATUS_MAX_CHARS);
    if (content === this.lastStatusText) return;

    const updatePayload = {
      containerID: STATUS_CONTAINER_ID,
      containerName: STATUS_CONTAINER_NAME,
      content,
    };
    const ok = await this.bridge.textContainerUpgrade(updatePayload);
    if (ok) {
      this.lastStatusText = content;
      return;
    }

    await this.bridge.rebuildPageContainer(this.#buildTextContainers(content, this.lastContentText));
    const retryOk = await this.bridge.textContainerUpgrade(updatePayload);
    if (retryOk) {
      this.lastStatusText = content;
      return;
    }
    this.logger?.warn?.('status textContainerUpgrade failed after rebuild retry');
  }

  async updateContent(text) {
    if (!this.bridge || !this.initialized) return;

    const content = String(text || '').slice(0, 2000);
    if (content === this.lastContentText) {
      return;
    }

    const updatePayload = {
      containerID: CONTENT_CONTAINER_ID,
      containerName: CONTENT_CONTAINER_NAME,
      content,
    };

    const ok = await this.bridge.textContainerUpgrade(updatePayload);
    if (ok) {
      this.lastContentText = content;
      return;
    }

    await this.bridge.rebuildPageContainer(this.#buildTextContainers(this.lastStatusText || INITIAL_STATUS_TEXT, content));
    const retryOk = await this.bridge.textContainerUpgrade(updatePayload);
    if (retryOk) {
      this.lastContentText = content;
      return;
    }
    this.logger?.warn?.('content textContainerUpgrade failed after rebuild retry');
  }

  async updateText(text) {
    // Backward-compatible helper for older caller paths.
    await this.updateContent(text);
  }

  async reapplyLayout() {
    if (!this.bridge || !this.initialized) return false;

    const status = this.lastStatusText || INITIAL_STATUS_TEXT;
    const content = this.lastContentText || INITIAL_CONTENT_TEXT;
    const rebuilt = await this.bridge.rebuildPageContainer(this.#buildTextContainers(status, content));
    if (!rebuilt) {
      this.logger?.warn?.('rebuildPageContainer failed while reapplying layout');
      return false;
    }
    return true;
  }

  #buildTextContainers(statusContent, bodyContent) {
    const textObject = [
      {
        ...STATUS_CONTAINER_FRAME,
        containerID: STATUS_CONTAINER_ID,
        containerName: STATUS_CONTAINER_NAME,
        content: normalizeStatusSegment(statusContent, STATUS_MAX_CHARS),
        isEventCapture: 0,
      },
      {
        ...CONTENT_CONTAINER_FRAME,
        containerID: CONTENT_CONTAINER_ID,
        containerName: CONTENT_CONTAINER_NAME,
        content: String(bodyContent || '').slice(0, 2000),
        isEventCapture: this.eventCaptureMode === 'text' ? 1 : 0,
      },
    ];

    if (this.eventCaptureMode === 'list') {
      return {
        containerTotalNum: 3,
        textObject,
        listObject: [
          {
            ...LIST_CAPTURE_CONTAINER_FRAME,
            containerID: LIST_CAPTURE_CONTAINER_ID,
            containerName: LIST_CAPTURE_CONTAINER_NAME,
            isEventCapture: 1,
            itemContainer: {
              itemCount: 1,
              itemWidth: 0,
              isItemSelectBorderEn: 0,
              itemName: ['capture'],
            },
          },
        ],
      };
    }

    return {
      containerTotalNum: 2,
      textObject,
    };
  }

  #ensureHubListener() {
    if (this.hubUnsubscribe || !this.bridge) return;

    this.hubUnsubscribe = this.bridge.onEvenHubEvent((event) => {
      if (event?.audioEvent?.audioPcm) {
        for (const listener of this.audioSubscribers) {
          try {
            listener(event.audioEvent.audioPcm);
          } catch (error) {
            this.logger?.warn?.('Audio subscriber threw', { message: error?.message || String(error) });
          }
        }
      }

      if (event?.textEvent) {
        for (const listener of this.textSubscribers) {
          try {
            listener(event.textEvent);
          } catch (error) {
            this.logger?.warn?.('Text subscriber threw', { message: error?.message || String(error) });
          }
        }
      }

      const uiEventCandidates = [
        {
          source: 'sysEvent',
          eventType: normalizeOsEventType(event?.sysEvent?.eventType),
        },
        {
          source: 'textEvent',
          eventType: normalizeOsEventType(event?.textEvent?.eventType),
        },
        {
          source: 'listEvent',
          eventType: normalizeOsEventType(event?.listEvent?.eventType),
        },
      ].filter((entry) => entry.eventType != null);

      const seenEventTypes = new Set();
      const uniqueUiEvents = [];
      for (const entry of uiEventCandidates) {
        if (seenEventTypes.has(entry.eventType)) continue;
        seenEventTypes.add(entry.eventType);
        uniqueUiEvents.push(entry);
      }

      if (uniqueUiEvents.length > 0) {
        for (const entry of uniqueUiEvents) {
          for (const listener of this.uiSubscribers) {
            try {
              listener({
                eventType: entry.eventType,
                source: entry.source,
                rawEvent: event,
              });
            } catch (error) {
              this.logger?.warn?.('UI subscriber threw', { message: error?.message || String(error) });
            }
          }
        }
      }
    });
  }

  #cleanupHubListenerIfIdle() {
    if (!this.hubUnsubscribe) return;

    if (this.audioSubscribers.size > 0 || this.textSubscribers.size > 0 || this.uiSubscribers.size > 0) {
      return;
    }

    try {
      this.hubUnsubscribe();
    } catch {
      // No-op.
    }
    this.hubUnsubscribe = null;
  }
}
