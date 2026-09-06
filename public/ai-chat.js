(function () {
  "use strict";

  const NRAFB = {
    root: null,
    state: {
      conversationId: null,
      providerId: null,
      homeAssistantId: null,
      entityIds: [],
      serviceIds: [],
      nodeIds: [],
      extraTabIds: [],
      pendingAttachments: [],
      autoEnableNewNodes: false
    }
  };

  NRAFB.init = function ($root) {
    NRAFB.root = $root;
    NRAFB.refreshProviders();
    NRAFB.refreshConversations();
    NRAFB.bindUi();
    NRAFB.appendSystemMessage("Welcome! Create a new chat (+) or pick an existing one.");
  };

  NRAFB.appendSystemMessage = function (text) {
    NRAFB.root.find(".nrafb-messages").append($(`<div class="nrafb-msg assistant"></div>`).text(text));
  };

  NRAFB.providerLabel = function (n) {
    if (n.name) return n.name;
    return `${n.provider || "?"}:${n.model || "?"}`;
  };

  NRAFB.listLocalProviders = function () {
    const list = [];
    RED.nodes.eachConfig(n => {
      if (n.type === "ai-provider-config") {
        list.push({ id: n.id, label: NRAFB.providerLabel(n), provider: n.provider, model: n.model });
      }
    });
    return list;
  };

  NRAFB.renderProviders = function (list, preferredId) {
    const $sel = NRAFB.root.find(".nrafb-provider");
    const previous = preferredId || NRAFB.state.providerId || $sel.val();
    $sel.empty();
    if (!list.length) {
      $sel.append(`<option value="">(no providers — click ⚙)</option>`);
      NRAFB.state.providerId = null;
      return;
    }
    list.forEach(p => $sel.append(`<option value="${p.id}">${$("<div>").text(p.label).html()}</option>`));
    const pick = list.find(p => p.id === previous) ? previous : list[0].id;
    $sel.val(pick);
    NRAFB.state.providerId = pick;
  };

  NRAFB.refreshProviders = function (preferredId) {
    // Immediate snapshot from the editor (catches nodes not yet deployed).
    NRAFB.renderProviders(NRAFB.listLocalProviders(), preferredId);
    // Then reconcile with backend (the deployed ones).
    $.getJSON("ai-flow-builder/providers").done(serverList => {
      const localList = NRAFB.listLocalProviders();
      const map = new Map();
      [...serverList, ...localList].forEach(p => map.set(p.id, p));
      NRAFB.renderProviders([...map.values()], preferredId);
    });
  };

  NRAFB.renderHomeAssistant = function (list) {
    const $sel = NRAFB.root.find(".nrafb-home-assistant");
    const previous = NRAFB.state.homeAssistantId;
    $sel.empty().append(`<option value="">HA entities off</option>`);
    (list || []).forEach(c => $sel.append(`<option value="${c.id}">${$('<div>').text(c.label).html()}</option>`));
    const retained = list && list.find(c => c.id === previous);
    const selected = retained || (!previous && list && list.length === 1 ? list[0] : null);
    NRAFB.state.homeAssistantId = selected ? selected.id : null;
    $sel.val(NRAFB.state.homeAssistantId || "");
  };

  NRAFB.refreshHomeAssistant = function () {
    const list = [];
    RED.nodes.eachConfig(n => {
      if (n.type === "ai-home-assistant-config") list.push({ id: n.id, label: n.name || n.baseUrl || "Home Assistant" });
    });
    NRAFB.renderHomeAssistant(list);
    $.getJSON("ai-flow-builder/home-assistant").done(serverList => {
      const local = new Map(list.map(c => [c.id, c]));
      (serverList || []).forEach(c => local.set(c.id, c));
      NRAFB.renderHomeAssistant([...local.values()]);
    });
  };

  NRAFB.listLocalHomeAssistant = function () {
    const list = [];
    RED.nodes.eachConfig(n => {
      if (n.type === "ai-home-assistant-config") {
        list.push({ id: n.id, label: n.name || n.baseUrl || "Home Assistant" });
      }
    });
    return list;
  };

  NRAFB.openHomeAssistantEditor = function (targetId) {
    if (!RED.editor || typeof RED.editor.editConfig !== "function") {
      alert("Your Node-RED version does not expose RED.editor.editConfig.");
      return;
    }
    const mode = targetId || "_ADD_";
    if (mode !== "_ADD_" && !NRAFB.listLocalHomeAssistant().some(c => c.id === mode)) {
      RED.notify("Select a Home Assistant connection first, or use + to add one.", "warning");
      return;
    }
    const before = new Set(NRAFB.listLocalHomeAssistant().map(c => c.id));
    RED.editor.editConfig("", "ai-home-assistant-config", mode);
    const started = Date.now();
    const poll = setInterval(() => {
      const trayOpen = $(".red-ui-tray").length > 0;
      if (!trayOpen || Date.now() - started > 60000) {
        clearInterval(poll);
        const now = NRAFB.listLocalHomeAssistant();
        const added = now.find(c => !before.has(c.id));
        NRAFB.refreshHomeAssistant();
        if (RED.nodes.dirty()) {
          RED.notify("Home Assistant connection changed — click Deploy to persist it.", "warning");
        }
        if (added) NRAFB.state.homeAssistantId = added.id;
      }
    }, 300);
  };

  NRAFB.openProviderEditor = function (targetId) {
    if (!RED.editor || typeof RED.editor.editConfig !== "function") {
      alert("Your Node-RED version does not expose RED.editor.editConfig.");
      return;
    }
    const mode = targetId || "_ADD_";
    if (mode !== "_ADD_" && !NRAFB.listLocalProviders().some(p => p.id === mode)) {
      RED.notify("Select a provider first, or use + to add a new one.", "warning");
      return;
    }
    const before = new Set(NRAFB.listLocalProviders().map(p => p.id));
    RED.editor.editConfig("", "ai-provider-config", mode);

    const started = Date.now();
    const poll = setInterval(() => {
      const trayOpen = $(".red-ui-tray").length > 0;
      if (!trayOpen || Date.now() - started > 60000) {
        clearInterval(poll);
        const now = NRAFB.listLocalProviders();
        const added = now.find(p => !before.has(p.id));
        NRAFB.refreshProviders(added ? added.id : (mode !== "_ADD_" ? mode : null));
        if (RED.nodes.dirty()) {
          RED.notify("AI provider changed — click Deploy to persist it.", "warning");
        }
      }
    }, 300);
  };

  NRAFB.refreshConversations = function () {
    $.getJSON("ai-flow-builder/conversations").done(list => {
      const $sel = NRAFB.root.find(".nrafb-conversations");
      const current = NRAFB.state.conversationId;
      $sel.empty().append(`<option value="">— conversations (${list.length}) —</option>`);
      list.forEach(c => $sel.append(`<option value="${c.id}">${$("<div>").text(c.title).html()}</option>`));
      if (current) $sel.val(current);
    });
  };

  NRAFB.loadConversation = function (id) {
    NRAFB.resetHomeAssistantContext();
    if (!id) {
      NRAFB.state.conversationId = null;
      NRAFB.root.find(".nrafb-messages").empty();
      NRAFB.appendSystemMessage("No chat selected.");
      return;
    }
    $.getJSON(`ai-flow-builder/conversations/${id}`).done(conv => {
      NRAFB.state.conversationId = conv.id;
      const $m = NRAFB.root.find(".nrafb-messages").empty();
      (conv.messages || []).forEach(msg => {
        const $msg = $(`<div class="nrafb-msg ${msg.role}"></div>`);
        if (window.NRAFB_RENDER && typeof window.NRAFB_RENDER.render === "function" && msg.role === "assistant") {
          $msg.html(window.NRAFB_RENDER.render(msg.content || ""));
        } else {
          $msg.text(msg.content || "");
        }
        if ((msg.attachments || []).length) {
          const $att = $(`<div class="nrafb-attachments"></div>`);
          msg.attachments.forEach(a => $att.append(NRAFB.renderAttachmentChip(a, conv.id)));
          $msg.append($att);
        }
        $m.append($msg);
      });
    });
  };

  NRAFB.newConversation = function () {
    $.ajax({
      url: "ai-flow-builder/conversations",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ title: "New chat" })
    }).done(conv => {
      NRAFB.resetHomeAssistantContext();
      NRAFB.state.conversationId = conv.id;
      NRAFB.refreshConversations();
      NRAFB.root.find(".nrafb-messages").empty();
      NRAFB.appendSystemMessage("New chat ready.");
    });
  };

  NRAFB.deleteConversation = function () {
    const id = NRAFB.state.conversationId;
    if (!id) return;
    if (!confirm("Delete this conversation and its attachments?")) return;
    $.ajax({ url: `ai-flow-builder/conversations/${id}`, method: "DELETE" }).done(() => {
      NRAFB.state.conversationId = null;
      NRAFB.root.find(".nrafb-messages").empty();
      NRAFB.refreshConversations();
      NRAFB.appendSystemMessage("Conversation deleted.");
    });
  };

  NRAFB.exportConversation = function () {
    if (!NRAFB.state.conversationId) return;
    window.open(`ai-flow-builder/conversations/${NRAFB.state.conversationId}/export`, "_blank");
  };

  NRAFB.cleanupConversations = async function () {
    const days = window.prompt("Delete conversations older than how many days?", "30");
    if (days === null || !/^\d+$/.test(days) || Number(days) < 1) return;
    if (!confirm(`Delete conversations older than ${days} days?`)) return;
    const response = await fetch("ai-flow-builder/conversations/cleanup", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days })
    });
    const result = await response.json();
    if (!response.ok) return NRAFB.appendSystemMessage(`Cleanup failed: ${result.error || response.status}`);
    NRAFB.refreshConversations();
    NRAFB.appendSystemMessage(`Deleted ${result.deleted} old conversation(s).`);
  };

  NRAFB.bindUi = function () {
    NRAFB.root.on("click", ".nrafb-new", NRAFB.newConversation);
    NRAFB.root.on("click", ".nrafb-delete", NRAFB.deleteConversation);
    NRAFB.root.on("click", ".nrafb-export", NRAFB.exportConversation);
    NRAFB.root.on("click", ".nrafb-cleanup", NRAFB.cleanupConversations);
    NRAFB.root.on("change", ".nrafb-conversations", function () {
      NRAFB.loadConversation($(this).val());
    });

    const $root = NRAFB.root;

    $root.on("change", ".nrafb-provider", function () {
      NRAFB.state.providerId = $(this).val();
    });
    $root.on("change", ".nrafb-home-assistant", function () {
      NRAFB.state.homeAssistantId = $(this).val() || null;
    });
    $root.on("click", ".nrafb-home-assistant-add", () => NRAFB.openHomeAssistantEditor("_ADD_"));
    $root.on("click", ".nrafb-home-assistant-edit", () => NRAFB.openHomeAssistantEditor(NRAFB.state.homeAssistantId));
    $root.on("click", ".nrafb-entitypicker", () => NRAFB.openContextPicker("entities"));
    $root.on("click", ".nrafb-servicepicker", () => NRAFB.openContextPicker("services"));
    $root.on("click", ".nrafb-nodepicker", () => NRAFB.openContextPicker("nodes"));

    $root.on("click", ".nrafb-provider-add", () => NRAFB.openProviderEditor("_ADD_"));
    $root.on("click", ".nrafb-provider-edit", () => NRAFB.openProviderEditor(NRAFB.state.providerId));

    $root.on("click", ".nrafb-send", NRAFB.sendMessage);
    $root.on("keydown", ".nrafb-input", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        NRAFB.sendMessage();
      }
    });

    $root.on("click", ".nrafb-attach", () => $root.find(".nrafb-file").trigger("click"));
    $root.on("change", ".nrafb-file", NRAFB.uploadFiles);
    $root.on("change", ".nrafb-autoenable-input", function () {
      NRAFB.state.autoEnableNewNodes = this.checked;
    });

    $root.on("click", ".nrafb-tabpicker", NRAFB.openTabPicker);

    $root.on("click", ".nrafb-att-remove", function (e) {
      e.preventDefault();
      const id = $(this).data("id");
      NRAFB.state.pendingAttachments = (NRAFB.state.pendingAttachments || []).filter(a => a.id !== id);
      NRAFB.renderPendingAttachments();
    });

    $root.on("click", ".nrafb-attachment-chip", function (e) {
      if ($(e.target).hasClass("nrafb-att-remove")) return;
      const $c = $(this);
      NRAFB.openAttachmentViewer($c.data("url"), $c.data("mime"), $c.data("name"));
    });
  };

  NRAFB.uploadFiles = async function () {
    const fileInput = this;
    if (!NRAFB.state.conversationId) {
      NRAFB.appendSystemMessage("Create a new chat first before attaching files.");
      fileInput.value = "";
      return;
    }
    const fd = new FormData();
    for (const f of fileInput.files) fd.append("files", f);
    try {
      const resp = await fetch(`ai-flow-builder/conversations/${NRAFB.state.conversationId}/attachments`, {
        method: "POST",
        body: fd
      });
      const saved = await resp.json();
      NRAFB.state.pendingAttachments = (NRAFB.state.pendingAttachments || []).concat(saved);
      NRAFB.renderPendingAttachments();
    } catch (e) {
      NRAFB.appendSystemMessage(`Upload failed: ${e.message}`);
    }
    fileInput.value = "";
  };

  NRAFB.renderPendingAttachments = function () {
    let $wrap = NRAFB.root.find(".nrafb-attachments.pending");
    if (!$wrap.length) {
      $wrap = $(`<div class="nrafb-attachments pending"></div>`);
      NRAFB.root.find(".nrafb-context").append($wrap);
    }
    $wrap.empty();
    (NRAFB.state.pendingAttachments || []).forEach(a => {
      const $chip = NRAFB.renderAttachmentChip(a, NRAFB.state.conversationId);
      $chip.append(` <a href="#" class="nrafb-att-remove" data-id="${a.id}" title="remove">×</a>`);
      $wrap.append($chip);
    });
  };

  NRAFB.renderAttachmentChip = function (att, conversationId) {
    const url = `ai-flow-builder/conversations/${conversationId}/attachments/${att.storedName}`;
    const isImage = att.mimeType && att.mimeType.startsWith("image/");
    const preview = isImage
      ? `<img src="${url}" alt="${$("<div>").text(att.originalName).html()}" />`
      : `<i class="fa fa-file"></i>`;
    const $chip = $(`<span class="nrafb-attachment-chip" data-url="${url}" data-mime="${att.mimeType}" data-name="${$("<div>").text(att.originalName).html()}">${preview}<span>${$("<div>").text(att.originalName).html()}</span></span>`);
    return $chip;
  };

  NRAFB.openAttachmentViewer = function (url, mime, name) {
    const $overlay = $(`<div class="nrafb-viewer-overlay"></div>`);
    let inner = "";
    if (mime && mime.startsWith("image/")) {
      inner = `<img src="${url}" style="max-width:90vw;max-height:90vh;" />`;
    } else if (mime === "application/pdf") {
      inner = `<object data="${url}" type="application/pdf" style="width:80vw;height:85vh"></object>`;
    } else if (mime && (mime.startsWith("text/") || mime === "application/json")) {
      inner = `<pre class="nrafb-viewer-text" style="background:#1e1e1e;color:#d4d4d4;padding:12px;max-width:80vw;max-height:85vh;overflow:auto;">loading…</pre>`;
    } else {
      inner = `<a href="${url}" download="${name}" class="nrafb-btn">Download ${name}</a>`;
    }
    const $body = $(`<div class="nrafb-viewer-body"></div>`).append(inner);
    const $actions = $(`<div style="text-align:right;margin-top:8px"></div>`);
    $actions.append($("<a>").attr({ href: url, download: name }).text("download"));
    $actions.append(" · ");
    $actions.append($('<button class="nrafb-btn nrafb-viewer-close">close</button>'));
    $overlay.append($body.append($actions));
    $("body").append($overlay);
    if (mime && (mime.startsWith("text/") || mime === "application/json")) {
      fetch(url).then(r => r.text()).then(txt => $overlay.find(".nrafb-viewer-text").text(txt));
    }
    $overlay.on("click", e => { if (e.target === $overlay[0] || $(e.target).hasClass("nrafb-viewer-close")) $overlay.remove(); });
  };

  NRAFB.listTabs = function () {
    const tabs = [];
    if (RED.nodes.eachWorkspace) {
      RED.nodes.eachWorkspace(ws => tabs.push({ id: ws.id, label: ws.label || ws.id }));
    }
    return tabs;
  };

  NRAFB.updateTabPickerLabel = function () {
    const n = (NRAFB.state.extraTabIds || []).length;
    const txt = n > 0 ? `active + ${n} tab${n > 1 ? "s" : ""}` : "active tab";
    NRAFB.root.find(".nrafb-tabpicker-label").text(txt);
  };

  NRAFB.openTabPicker = function (e) {
    e.stopPropagation();
    $(".nrafb-tabpicker-panel").remove();
    const $btn = $(e.currentTarget);
    const activeId = RED.workspaces && RED.workspaces.active && RED.workspaces.active();
    const tabs = NRAFB.listTabs();
    const $panel = $(`<div class="nrafb-tabpicker-panel"></div>`);
    tabs.forEach(t => {
      const isActive = t.id === activeId;
      const isSelected = isActive || NRAFB.state.extraTabIds.includes(t.id);
      const $row = $(`
        <label>
          <input type="checkbox" data-tabid="${t.id}" ${isSelected ? "checked" : ""} ${isActive ? "disabled" : ""} />
          <span>${$("<div>").text(t.label).html()}${isActive ? " <i>(active)</i>" : ""}</span>
        </label>
      `);
      $panel.append($row);
    });
    const off = $btn.offset();
    $panel.css({ top: off.top + $btn.outerHeight() + 2, left: off.left });
    $("body").append($panel);

    const closeHandler = (ev) => {
      if ($(ev.target).closest(".nrafb-tabpicker-panel").length) return;
      NRAFB.state.extraTabIds = $panel.find("input:checked:not(:disabled)").map(function () {
        return $(this).data("tabid");
      }).get();
      NRAFB.updateTabPickerLabel();
      $panel.remove();
      $(document).off("mousedown", closeHandler);
    };
    setTimeout(() => $(document).on("mousedown", closeHandler), 0);
  };

  NRAFB.updateContextLabels = function () {
    NRAFB.root.find(".nrafb-entitypicker-label").text(NRAFB.state.entityIds.length ? `entities (${NRAFB.state.entityIds.length})` : "entities");
    NRAFB.root.find(".nrafb-servicepicker-label").text(NRAFB.state.serviceIds.length ? `services (${NRAFB.state.serviceIds.length})` : "services");
    NRAFB.root.find(".nrafb-nodepicker-label").text(NRAFB.state.nodeIds.length ? `nodes (${NRAFB.state.nodeIds.length})` : "nodes");
  };

  // Selections are per-conversation only — cleared whenever a chat is created or switched.
  NRAFB.resetHomeAssistantContext = function () {
    NRAFB.state.entityIds = [];
    NRAFB.state.serviceIds = [];
    NRAFB.state.nodeIds = [];
    if (NRAFB.root) NRAFB.updateContextLabels();
  };

  NRAFB.closePicker = function () {
    $(".nrafb-context-picker-overlay").remove();
  };

  NRAFB.CONTEXT_PICKER_KINDS = {
    entities: { title: "Choose Home Assistant entities", placeholder: "Search by entity, name, domain...", stateKey: "entityIds" },
    services: { title: "Choose allowed Home Assistant services", placeholder: "Search by domain, service, description...", stateKey: "serviceIds" },
    nodes: { title: "Choose Node-RED nodes", placeholder: "Search by node ID, type, tab...", stateKey: "nodeIds" }
  };

  NRAFB.openContextPicker = function (kind) {
    NRAFB.closePicker();
    const spec = NRAFB.CONTEXT_PICKER_KINDS[kind];
    const selected = new Set(NRAFB.state[spec.stateKey]);
    const $overlay = $("<div class='nrafb-context-picker-overlay'></div>");
    const $panel = $("<div class='nrafb-context-picker'></div>");
    const $search = $("<input type='search' class='nrafb-context-search'>").attr("placeholder", spec.placeholder);
    const $list = $("<div class='nrafb-context-picker-list'></div>");
    const $count = $("<span class='nrafb-context-picker-count'></span>");
    const $apply = $("<button class='nrafb-btn nrafb-context-apply'>Use selected</button>");
    const $clear = $("<button class='nrafb-btn nrafb-context-clear'>Clear</button>");
    const $close = $("<button class='nrafb-btn nrafb-context-close' title='Close'>×</button>");
    $panel.append($("<div class='nrafb-context-picker-header'></div>").append($('<strong>').text(spec.title), $close));
    $panel.append($search, $("<div class='nrafb-context-picker-toolbar'></div>").append($count, $clear, $apply), $list);
    $overlay.append($panel);
    $("body").append($overlay);

    let items = [];
    const render = () => {
      const query = String($search.val() || "").toLowerCase();
      $list.empty();
      const visible = items.filter(item => item.search.includes(query));
      if (!visible.length) $list.append($('<div class="nrafb-context-empty">').text(items.length ? "No matches" : "No items available"));
      visible.forEach(item => {
        const $row = $("<label class='nrafb-context-row'></label>");
        const $checkbox = $("<input type='checkbox'>").val(item.id).prop("checked", selected.has(item.id));
        $row.append($checkbox, $("<span>").append($('<strong>').text(item.label), $('<small>').text(item.detail)));
        $list.append($row);
      });
      $count.text(`${selected.size} selected`);
    };
    const finish = () => {
      NRAFB.state[spec.stateKey] = [...selected];
      NRAFB.updateContextLabels();
      NRAFB.closePicker();
    };
    $search.on("input", render);
    $list.on("change", "input", function () {
      if (this.checked) selected.add(this.value); else selected.delete(this.value);
      $count.text(`${selected.size} selected`);
    });
    $clear.on("click", () => { selected.clear(); render(); });
    $apply.on("click", finish);
    $close.on("click", NRAFB.closePicker);
    $overlay.on("click", event => { if (event.target === $overlay[0]) NRAFB.closePicker(); });

    if (!NRAFB.state.homeAssistantId && (kind === "entities" || kind === "services")) {
      $list.append($('<div class="nrafb-context-empty">').text("Select a Home Assistant connection first, then reopen this picker."));
      return;
    }

    if (kind === "entities") {
      $.getJSON(`ai-flow-builder/home-assistant/${NRAFB.state.homeAssistantId}/entities`)
        .done(snapshot => {
          items = (snapshot.states || []).map(entity => ({
            id: entity.entity_id,
            label: entity.entity_id,
            detail: `${entity.attributes && entity.attributes.friendly_name || ""}${entity.state ? ` · ${entity.state}` : ""}`,
            search: `${entity.entity_id} ${entity.attributes && entity.attributes.friendly_name || ""} ${entity.state || ""}`.toLowerCase()
          }));
          render();
        })
        .fail(xhr => {
          $list.empty().append($('<div class="nrafb-context-empty">').text(xhr.responseJSON && xhr.responseJSON.error || "Could not load entities"));
          $list.append($('<button class="nrafb-btn nrafb-context-retry">Retry</button>').on("click", () => NRAFB.openContextPicker("entities")));
        });
    } else if (kind === "services") {
      fetch("ai-flow-builder/home-assistant/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: NRAFB.state.homeAssistantId })
      }).then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        items = (result.services || []).map(entry => ({
          id: `${entry.domain}.${entry.service}`,
          label: `${entry.domain}.${entry.service}`,
          detail: entry.name && entry.name !== entry.service ? entry.name : (entry.description || ""),
          search: `${entry.domain} ${entry.service} ${entry.name || ""} ${entry.description || ""}`.toLowerCase()
        }));
        render();
      }).catch(error => {
        $list.empty().append($('<div class="nrafb-context-empty">').text(error.message));
        $list.append($('<button class="nrafb-btn nrafb-context-retry">Retry</button>').on("click", () => NRAFB.openContextPicker("services")));
      });
    } else {
      const tabs = {};
      NRAFB.listTabs().forEach(tab => { tabs[tab.id] = tab.label; });
      const allNodes = NRAFB.getAllFlowNodes();
      items = allNodes.filter(node => node && node.type !== "tab" && node.id).map(node => ({
        id: node.id,
        label: node.type,
        detail: `${tabs[node.z] || node.z || ""} · ${node.id}`,
        search: `${node.id} ${node.type} ${tabs[node.z] || ""}`.toLowerCase()
      }));
      render();
    }
  };


  NRAFB.getAllFlowNodes = function () {
    const byId = new Map();
    const add = node => {
      if (node && node.id) byId.set(node.id, node);
    };
    try {
      if (RED.nodes.createCompleteNodeSet) RED.nodes.createCompleteNodeSet().forEach(add);
    } catch (_) {}
    try {
      if (RED.nodes.getNodes) RED.nodes.getNodes().forEach(add);
    } catch (_) {}
    try {
      if (RED.nodes.eachNode) RED.nodes.eachNode(add);
    } catch (_) {}
    return [...byId.values()];
  };

  NRAFB.expandConnectedNodeIds = function (nodes, selectedIds) {
    const byId = new Map(nodes.filter(node => node && node.id).map(node => [node.id, node]));
    const included = new Set(selectedIds);
    const pending = [...included];
    while (pending.length) {
      const id = pending.pop();
      const node = byId.get(id);
      if (!node) continue;
      const neighbors = [];
      (node.wires || []).forEach(port => (port || []).forEach(target => neighbors.push(target)));
      nodes.forEach(candidate => {
        if ((candidate.wires || []).some(port => (port || []).includes(id))) neighbors.push(candidate.id);
      });
      neighbors.forEach(neighbor => {
        if (byId.has(neighbor) && !included.has(neighbor)) {
          included.add(neighbor);
          pending.push(neighbor);
        }
      });
    }
    return [...included];
  };

  NRAFB.collectFlowContext = function () {
    const activeTabId = RED.workspaces && RED.workspaces.active && RED.workspaces.active();
    const extraTabIds = NRAFB.state.extraTabIds || [];
    const tabIds = [activeTabId, ...extraTabIds].filter(Boolean);
    const allNodes = NRAFB.getAllFlowNodes();
    const selectedNodeIds = NRAFB.state.nodeIds.length
      ? NRAFB.expandConnectedNodeIds(allNodes, NRAFB.state.nodeIds)
      : [];
    const selectedSet = new Set(selectedNodeIds);
    const flowJson = allNodes.filter(n => {
      if (n.type === "tab") return tabIds.includes(n.id);
      if (selectedSet.size) return selectedSet.has(n.id);
      return tabIds.includes(n.z);
    });
    // Build palette context: every registered node type, grouped by module, core flagged.
    const paletteByModule = {};
    try {
      const reg = RED.nodes.registry;
      const list = (reg && reg.getNodeList && reg.getNodeList()) || [];
      list.forEach(entry => {
        if (!entry || entry.enabled === false) return;
        const mod = entry.module || "node-red";
        const version = entry.version || null;
        if (!paletteByModule[mod]) paletteByModule[mod] = { module: mod, version, core: mod === "node-red", types: [] };
        (entry.types || []).forEach(t => {
          if (!paletteByModule[mod].types.includes(t)) paletteByModule[mod].types.push(t);
        });
      });
    } catch (_) {}
    const palette = Object.values(paletteByModule).sort((a, b) => {
      if (a.core !== b.core) return a.core ? -1 : 1;
      return a.module.localeCompare(b.module);
    });
    // Real schemas (from the installed node's own `defaults`) for types already present in
    // this context, so the AI matches actual property names instead of guessing them.
    const typeSchemas = [];
    try {
      const seenTypes = new Set();
      flowJson.forEach(n => {
        if (!n || n.type === "tab" || seenTypes.has(n.type)) return;
        seenTypes.add(n.type);
        const def = RED.nodes.getType && RED.nodes.getType(n.type);
        if (!def) return;
        const defaults = def.defaults || {};
        const properties = Object.keys(defaults);
        const required = properties.filter(k => defaults[k] && defaults[k].required);
        typeSchemas.push({ type: n.type, properties, required });
      });
    } catch (_) {}
    return {
      activeTabId,
      extraTabIds,
      entityIds: NRAFB.state.entityIds,
      serviceIds: NRAFB.state.serviceIds,
      nodeIds: selectedNodeIds,
      flowJson,
      palette,
      typeSchemas
    };
  };

  NRAFB.sendMessage = async function () {
    if (!NRAFB.state.conversationId) {
      NRAFB.appendSystemMessage("Create a new chat first (+ button).");
      return;
    }
    if (!NRAFB.state.providerId) {
      NRAFB.appendSystemMessage("No AI provider configured. Add an ai-provider-config node and deploy.");
      return;
    }
    const $input = NRAFB.root.find(".nrafb-input");
    const text = ($input.val() || "").trim();
    if (!text) return;
    NRAFB.root.find(".nrafb-messages").append($(`<div class="nrafb-msg user"></div>`).text(text));
    $input.val("");

    const $assistant = $(`<div class="nrafb-msg assistant streaming"></div>`);
    NRAFB.root.find(".nrafb-messages").append($assistant);

    try {
      const body = {
        content: text,
        attachments: NRAFB.state.pendingAttachments,
        flowContext: NRAFB.collectFlowContext(),
        providerId: NRAFB.state.providerId,
        homeAssistantId: NRAFB.state.homeAssistantId
      };
      const resp = await fetch(`ai-flow-builder/conversations/${NRAFB.state.conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { detail = (await resp.json()).error || detail; } catch (_) {}
        throw new Error(detail);
      }
      NRAFB.state.pendingAttachments = [];
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop();
        for (const frame of frames) {
          const lines = frame.split("\n");
          let event = "message", data = "";
          for (const l of lines) {
            if (l.startsWith("event: ")) event = l.slice(7);
            else if (l.startsWith("data: ")) data += l.slice(6);
          }
          try { data = JSON.parse(data); } catch (_) {}
          if (event === "delta" && data && data.text) {
            acc += data.text;
            if (window.NRAFB_RENDER && typeof window.NRAFB_RENDER.render === "function") {
              $assistant.html(window.NRAFB_RENDER.render(acc));
            } else {
              $assistant.text(acc);
            }
          } else if (event === "error") {
            $assistant.append(`<div style="color:#c33">Error: ${data && data.error}</div>`);
          }
        }
      }
      $assistant.removeClass("streaming");
      NRAFB.refreshConversations();
    } catch (e) {
      $assistant.removeClass("streaming").append(`<div style="color:#c33">Request failed: ${e.message}</div>`);
    }
  };

  window.NRAFB = NRAFB;
})();
