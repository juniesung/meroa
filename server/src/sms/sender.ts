import { logger } from '../logger.ts';

export interface SmsSender {
  send(phoneE164: string, body: string): Promise<void>;
}

/**
 * Logs the OTP to the server console instead of sending a real text.
 * The outbound SMS provider is Phase 9 — swap this implementation there,
 * everything else (OTP flow, continuity) already depends only on this interface.
 */
export const devConsoleSmsSender: SmsSender = {
  async send(phoneE164, body) {
    logger.info(`[dev-sms] to ${phoneE164}: ${body}`);
  },
};

export const smsSender: SmsSender = devConsoleSmsSender;
