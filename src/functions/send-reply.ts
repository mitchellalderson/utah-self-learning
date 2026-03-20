/** Send Reply — routes agent.reply.ready events to the correct channel handler. */

import { inngest, agentReplyReady } from "../client.ts";
import { getChannel } from "../channels/index.ts";

export const sendReply = inngest.createFunction(
  { id: "send-reply", retries: 3, triggers: [agentReplyReady] },
  async ({ event, step, logger }) => {
    const { response, channel, destination, channelMeta } = event.data;

    const handler = getChannel(channel);
    if (!handler) {
      logger.warn({ channel }, `Unknown channel: ${channel}`);
      return { error: `Unknown channel: ${channel}` };
    }

    await step.run("send", async () => {
      await handler.sendReply({ response, destination, channelMeta });
    });
  },
);
