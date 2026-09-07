(function () {
  "use strict";

  const CODE_FENCE = /```([\w:\-]+)?\n([\s\S]*?)```/g;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function isApplyable(lang) {
    return /^json:(flow|node|subflow):[\w-]+$/.test(lang || "") ||
           /^json:(delete|connect|disconnect|ha-service)$/.test(lang || "");
  }

  // Flags node types that aren't installed and properties that don't match the real
  // Node-RED schema, computed from RED.nodes.getType() rather than guessed.
  function buildValidationWarnings(lang, code) {
    if (typeof RED === "undefined" || !RED.nodes || typeof RED.nodes.getType !== "function") return [];
    const planner = window.NRAFB_PLANNER;
    if (!planner) return [];
    let data;
    try { data = JSON.parse(code); } catch (_) { return []; }

    const checkNode = (node, fallbackType, warnings) => {
      const type = (node && node.type) || fallbackType;
      if (!node || !type || type === "tab") return;
      const def = RED.nodes.getType(type);
      if (!def) { warnings.push(`Unknown node type: ${type}`); return; }
      const defaults = def.defaults || {};
      const properties = Object.keys(defaults);
      const required = properties.filter(k => defaults[k] && defaults[k].required);
      const { unexpectedKeys, missingRequiredKeys } = planner.diffNodeAgainstSchema(node, { properties, required });
      if (unexpectedKeys.length) warnings.push(`${type}: unexpected propert${unexpectedKeys.length > 1 ? "ies" : "y"} \u2014 ${unexpectedKeys.join(", ")}`);
      if (missingRequiredKeys.length) warnings.push(`${type}: missing required field${missingRequiredKeys.length > 1 ? "s" : ""} \u2014 ${missingRequiredKeys.join(", ")}`);
    };

    const warnings = [];
    if (/^json:flow:/.test(lang)) {
      (Array.isArray(data) ? data : [data]).forEach(n => checkNode(n, null, warnings));
    } else {
      const m = /^json:node:([\w-]+)$/.exec(lang || "");
      if (m) {
        const existing = RED.nodes.node(m[1]);
        checkNode(data, existing && existing.type, warnings);
      }
    }
    return warnings;
  }

  function renderCodeBlock(lang, code) {
    const safeLang = escapeHtml(lang || "text");
    const safeCode = escapeHtml(code);
    const applyBtn = isApplyable(lang)
      ? `<button class="nrafb-apply" data-lang="${safeLang}">Apply</button><button class="nrafb-preview" data-lang="${safeLang}">Preview</button>`
      : "";
    const warnings = buildValidationWarnings(lang, code);
    const warningsHtml = warnings.length
      ? `<div class="nrafb-codeblock-warnings">${warnings.map(w => `\u26a0 ${escapeHtml(w)}`).join("<br>")}</div>`
      : "";
    return (
      `<div class="nrafb-codeblock" data-lang="${safeLang}">` +
        `<div class="nrafb-codeblock-header">` +
          `<span class="nrafb-lang">${safeLang}</span>` +
          `<button class="nrafb-copy">Copy</button>` +
          applyBtn +
        `</div>` +
        warningsHtml +
        `<pre><code>${safeCode}</code></pre>` +
      `</div>`
    );
  }

  function renderInline(text) {
    // Very small markdown: bold, italic, inline code, line breaks.
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, "<br>");
  }

  function render(markdown) {
    const src = String(markdown || "");
    let out = "";
    let applyableCount = 0;
    let lastIndex = 0;
    let m;
    CODE_FENCE.lastIndex = 0;
    while ((m = CODE_FENCE.exec(src)) !== null) {
      if (m.index > lastIndex) {
        out += renderInline(src.slice(lastIndex, m.index));
      }
      const lang = m[1] || "";
      if (isApplyable(lang)) applyableCount++;
      out += renderCodeBlock(lang, m[2]);
      lastIndex = CODE_FENCE.lastIndex;
    }
    if (lastIndex < src.length) out += renderInline(src.slice(lastIndex));
    if (applyableCount > 1) {
      out = `<div class="nrafb-batch-actions"><button class="nrafb-btn nrafb-apply-all">Apply all ${applyableCount} changes</button></div>` + out;
    }
    return out;
  }

  // Event delegation for Copy / Apply / Preview buttons.
  $(document).on("click", ".nrafb-codeblock .nrafb-copy", function () {
    const code = $(this).closest(".nrafb-codeblock").find("code").text();
    navigator.clipboard.writeText(code).then(() => {
      const $btn = $(this);
      const prev = $btn.text();
      $btn.text("copied ✓");
      setTimeout(() => $btn.text(prev), 1200);
    });
  });

  $(document).on("click", ".nrafb-codeblock .nrafb-apply", function () {
    const $b = $(this).closest(".nrafb-codeblock");
    const lang = $b.data("lang");
    const code = $b.find("code").text();
    console.log("[NRAFB_RENDER] Apply click", { lang, hasHandler: !!(window.NRAFB_APPLY && window.NRAFB_APPLY.apply) });
    if (window.NRAFB_APPLY && typeof window.NRAFB_APPLY.apply === "function") {
      window.NRAFB_APPLY.apply(lang, code);
    } else {
      alert("Apply handler not loaded yet.");
    }
  });

  $(document).on("click", ".nrafb-codeblock .nrafb-preview", function () {
    const $b = $(this).closest(".nrafb-codeblock");
    const lang = $b.data("lang");
    const code = $b.find("code").text();
    if (window.NRAFB_APPLY && typeof window.NRAFB_APPLY.preview === "function") {
      window.NRAFB_APPLY.preview(lang, code);
    } else {
      alert("Preview handler not loaded yet.");
    }
  });

  $(document).on("click", ".nrafb-apply-all", function () {
    const $message = $(this).closest(".nrafb-msg");
    const blocks = $message.find(".nrafb-codeblock").filter(function () {
      return isApplyable($(this).data("lang"));
    }).map(function () {
      return { lang: $(this).data("lang"), code: $(this).find("code").text() };
    }).get();
    if (!blocks.length) return;
    if (window.NRAFB_APPLY && typeof window.NRAFB_APPLY.applyBatch === "function") {
      const $overlay = $(`<div class="nrafb-viewer-overlay"></div>`);
      const $body = $(`<div class="nrafb-viewer-body" style="min-width:360px;max-width:720px;"><h4 style="margin-top:0">Review AI changes</h4><div class="nrafb-review-list"></div><div style="text-align:right;margin-top:8px"><button class="nrafb-btn nrafb-review-cancel">Cancel</button><button class="nrafb-btn nrafb-review-apply" style="background:#4a9;color:#fff;">Apply selected</button></div></div>`);
      blocks.forEach((block, index) => {
        const firstLine = String(block.code || "").split("\n").find(Boolean) || "(empty)";
        const $row = $(`<label class="nrafb-context-row"><input type="checkbox" checked data-index="${index}"><span><strong></strong><small></small></span></label>`);
        $row.find("strong").text(block.lang);
        $row.find("small").text(firstLine.slice(0, 160));
        $body.find(".nrafb-review-list").append($row);
      });
      $overlay.append($body);
      $("body").append($overlay);
      $overlay.on("click", e => {
        if (e.target === $overlay[0] || $(e.target).hasClass("nrafb-review-cancel")) $overlay.remove();
        if ($(e.target).hasClass("nrafb-review-apply")) {
          const selected = $body.find("input:checked").map(function () { return blocks[Number($(this).data("index"))]; }).get();
          if (selected.length && confirm(`Apply ${selected.length} selected AI change(s) to the canvas?`)) window.NRAFB_APPLY.applyBatch(selected);
          $overlay.remove();
        }
      });
    } else {
      alert("Apply handler not loaded yet.");
    }
  });

  window.NRAFB_RENDER = { render };
})();
