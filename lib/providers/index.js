"use strict";

const { streamOpenAI } = require("./openai");
const { streamAnthropic } = require("./anthropic");

async function* streamProvider({ configNode, systemPrompt, messages, signal }) {
  switch (configNode.provider) {
    case "openai":
      yield* streamOpenAI({ configNode, systemPrompt, messages, signal });
      return;
    case "anthropic":
      yield* streamAnthropic({ configNode, systemPrompt, messages, signal });
      return;
    default:
      yield { type: "error", error: `unknown provider: ${configNode.provider}` };
  }
}

module.exports = { streamProvider };
