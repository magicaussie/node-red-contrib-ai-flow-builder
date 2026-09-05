module.exports = function (RED) {
  function AiHomeAssistantConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.label = config.name;
    this.baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
    this.allowedHosts = config.allowedHosts || "";
  }

  RED.nodes.registerType("ai-home-assistant-config", AiHomeAssistantConfigNode, {
    credentials: {
      token: { type: "password" }
    }
  });
};