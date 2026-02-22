import {
  StartUpPageCreateResult,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

const TEXT_CONTAINER_ID = 1;
const TEXT_CONTAINER_NAME = 'ambient-main';
const INITIAL_TEXT = 'Starting Codex bridge...';
// SDK docs define text container ranges:
// x: 0-576, y: 0-288, width: 0-576, height: 0-288.
const TEXT_CONTAINER_FRAME = {
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
};

function normalizeStartResult(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  return -1;
}

export class EvenBridgeController {
  constructor(logger) {
    this.logger = logger;
    this.bridge = null;
    this.initialized = false;
    this.lastRenderedText = '';
    this.lastRenderedOffset = 0;
    this.lastRenderedLength = 0;
  }

  async init() {
    if (this.initialized) return;

    this.bridge = await waitForEvenAppBridge();
    const startupContainer = this.#buildTextContainer(INITIAL_TEXT);

    const startupResult = await this.bridge.createStartUpPageContainer(startupContainer);

    const normalizedResult = normalizeStartResult(startupResult);
    if (normalizedResult === StartUpPageCreateResult.success) {
      this.initialized = true;
      this.lastRenderedText = INITIAL_TEXT;
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
        const upgraded = await this.bridge.textContainerUpgrade({
          containerID: TEXT_CONTAINER_ID,
          containerName: TEXT_CONTAINER_NAME,
          content: INITIAL_TEXT,
        });
        if (!upgraded) {
          this.logger?.warn?.('textContainerUpgrade fallback also failed; continuing with existing SDK UI state');
        }
      }

      this.initialized = true;
      this.lastRenderedText = INITIAL_TEXT;
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

    const unsubscribe = this.bridge.onEvenHubEvent((event) => {
      if (!event?.audioEvent?.audioPcm) return;
      onAudioFrame(event.audioEvent.audioPcm);
    });

    return unsubscribe;
  }

  subscribeTextEvents(onTextEvent) {
    if (!this.bridge) {
      throw new Error('Even bridge not initialized');
    }

    const unsubscribe = this.bridge.onEvenHubEvent((event) => {
      if (!event?.textEvent) return;
      onTextEvent(event.textEvent);
    });

    return unsubscribe;
  }

  async startMic() {
    if (!this.bridge || !this.initialized) {
      throw new Error('Even bridge not initialized');
    }

    const ok = await this.bridge.audioControl(true);
    if (!ok) {
      throw new Error('Failed to open mic via audioControl(true)');
    }
  }

  async stopMic() {
    if (!this.bridge || !this.initialized) return;

    try {
      await this.bridge.audioControl(false);
    } catch {
      // No-op.
    }
  }

  async updateText(text, options = {}) {
    if (!this.bridge || !this.initialized) return;

    const content = String(text || '').slice(0, 2000);
    const hasOffset = Number.isFinite(options.contentOffset);
    const hasLength = Number.isFinite(options.contentLength);
    const contentOffset = hasOffset ? Math.max(0, Math.floor(options.contentOffset)) : 0;
    const contentLength = hasLength ? Math.max(1, Math.floor(options.contentLength)) : content.length;

    if (
      content === this.lastRenderedText &&
      contentOffset === this.lastRenderedOffset &&
      contentLength === this.lastRenderedLength
    ) {
      return;
    }

    const updatePayload = {
      containerID: TEXT_CONTAINER_ID,
      containerName: TEXT_CONTAINER_NAME,
      content,
    };

    if (hasOffset) {
      updatePayload.contentOffset = contentOffset;
    }
    if (hasLength) {
      updatePayload.contentLength = contentLength;
    }

    const ok = await this.bridge.textContainerUpgrade(updatePayload);

    if (ok) {
      this.lastRenderedText = content;
      this.lastRenderedOffset = contentOffset;
      this.lastRenderedLength = contentLength;
      return;
    }

    // Fallback path: rebuild the container then retry text update once.
    await this.bridge.rebuildPageContainer(this.#buildTextContainer(content));

    const retryOk = await this.bridge.textContainerUpgrade(updatePayload);

    if (retryOk) {
      this.lastRenderedText = content;
      this.lastRenderedOffset = contentOffset;
      this.lastRenderedLength = contentLength;
      return;
    }

    this.logger?.warn?.('textContainerUpgrade failed after rebuild retry');
  }

  #buildTextContainer(content) {
    return {
      containerTotalNum: 1,
      textObject: [
        {
          ...TEXT_CONTAINER_FRAME,
          containerID: TEXT_CONTAINER_ID,
          containerName: TEXT_CONTAINER_NAME,
          content,
          isEventCapture: 1,
        },
      ],
    };
  }
}
