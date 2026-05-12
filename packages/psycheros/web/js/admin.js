/**
 * Admin Panel Client-Side Logic
 *
 * Handles log filtering, manual refresh, clipboard copy,
 * and local timezone formatting.
 * Loaded lazily — only when the admin panel fragment is active.
 */

(function () {
  /**
   * Format all <time class="admin-local-time"> elements to the browser's local timezone.
   */
  function formatLocalTimes(root) {
    (root || document).querySelectorAll("time.admin-local-time").forEach(function (el) {
      if (el.dataset.formatted) return;
      el.textContent = new Date(el.getAttribute("datetime")).toLocaleTimeString();
      el.dataset.formatted = "1";
    });
  }

  /**
   * Flash a button's text briefly to confirm an action.
   */
  function flashButton(btn, text, ms) {
    var original = btn.innerHTML;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.innerHTML = original;
      btn.disabled = false;
    }, ms || 1500);
  }

  /**
   * Refresh the log entries by fetching filtered data from the API.
   */
  window.adminRefreshLogs = function () {
    var level = document.getElementById("admin-log-level")?.value || "";
    var component = document.getElementById("admin-log-component")?.value || "";
    var limit = document.getElementById("admin-log-limit")?.value || "100";

    var params = new URLSearchParams();
    if (level) params.set("level", level);
    if (component) params.set("component", component);
    params.set("limit", limit);

    var target = document.getElementById("admin-log-entries");
    if (target) {
      htmx.ajax("GET", "/api/admin/logs/entries?" + params, { target: target, swap: "innerHTML" });
    }
  };

  /**
   * Copy current log entries to clipboard as formatted text.
   * Fetches from the JSON API using current filter state.
   */
  window.adminCopyLogs = async function (btn) {
    var level = document.getElementById("admin-log-level")?.value || "";
    var component = document.getElementById("admin-log-component")?.value || "";
    var limit = document.getElementById("admin-log-limit")?.value || "100";

    var params = new URLSearchParams();
    if (level) params.set("level", level);
    if (component) params.set("component", component);
    params.set("limit", limit);

    try {
      var res = await fetch("/api/admin/logs?" + params);
      var data = await res.json();

      var filters = [];
      if (level) filters.push("level=" + level);
      if (component) filters.push("component=" + component);
      var filterLine = filters.length ? " (filtered: " + filters.join(", ") + ")" : "";

      var text = "# Psycheros Logs" + filterLine + "\n";
      text += "Entries: " + data.entries.length + " | Counts: error=" + data.counts.error + " warn=" + data.counts.warn + " info=" + data.counts.info + "\n\n";
      text += "```\n";
      for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        var ts = new Date(e.timestamp).toISOString();
        text += ts + " [" + e.level.toUpperCase().padEnd(5) + "] [" + e.component + "] " + e.message + "\n";
      }
      text += "```\n";

      await navigator.clipboard.writeText(text);
      flashButton(btn, "Copied!");
    } catch (_) {
      flashButton(btn, "Failed");
    }
  };

  /**
   * Copy diagnostics snapshot to clipboard as formatted markdown.
   * Fetches from the JSON API for structured data.
   */
  window.adminCopyDiagnostics = async function (btn) {
    try {
      var res = await fetch("/api/admin/diagnostics");
      var s = await res.json();

      var uptime = formatUptimeText(s.uptime);
      var dbSize = s.database.dbSizeBytes !== null ? formatBytesText(s.database.dbSizeBytes) : "unknown";
      var vecStatus = s.vector.available ? "loaded (" + s.vector.version + ")" : "not loaded";
      var msgSync = s.vector.messageSyncOk ? "OK" : "DESYNC";
      var memSync = s.vector.memorySyncOk ? "OK" : "DESYNC";
      var mcpStatus = s.mcp.enabled ? (s.mcp.connected ? "connected" : "disconnected") : "disabled";
      var graphInfo = s.knowledgeGraph.stats
        ? s.knowledgeGraph.stats.totalNodes + " nodes, " + s.knowledgeGraph.stats.totalEdges + " edges"
        : "unavailable";

      var text = "# Psycheros Diagnostics\n";
      text += "Timestamp: " + s.timestamp + "\n\n";
      text += "## Overview\n";
      text += "- Uptime: " + uptime + "\n";
      text += "- SSE Clients: " + s.sse.connectedClients + "\n";
      text += "- Database Size: " + dbSize + "\n\n";
      text += "## Database\n";
      text += "| Table | Rows |\n|-------|------|\n";
      text += "| conversations | " + s.database.conversations + " |\n";
      text += "| messages | " + s.database.messages + " |\n";
      text += "| lorebooks | " + s.database.lorebooks + " |\n";
      text += "| lorebook_entries | " + s.database.lorebookEntries + " |\n";
      text += "| memory_summaries | " + s.database.memorySummaries + " |\n\n";
      text += "## Vector System\n";
      text += "- sqlite-vec: " + vecStatus + "\n";
      text += "- message_embeddings: " + s.vector.messageEmbeddings + " main / " + s.vector.vecMessages + " vec — " + msgSync + "\n";
      text += "- memory_chunks: " + s.vector.memoryChunks + " main / " + s.vector.vecMemoryChunks + " vec — " + memSync + "\n\n";
      text += "## RAG\n";
      text += "- Status: " + (s.rag.enabled ? "enabled" : "disabled") + "\n";
      text += "- Indexed Files: " + s.rag.indexedFiles + "\n";
      text += "- Chunks: " + s.rag.indexedChunks + "\n\n";
      text += "## Memory Consolidation\n";
      text += "- Status: " + (s.memory.enabled ? "enabled" : "disabled") + "\n";
      text += "- Daily: " + s.memory.dailySummaries + " | Weekly: " + s.memory.weeklySummaries + " | Monthly: " + s.memory.monthlySummaries + " | Yearly: " + s.memory.yearlySummaries + "\n";
      text += "- Chats Summarized: " + s.memory.summarizedChats + "\n\n";
      text += "## MCP (entity-core)\n";
      text += "- Status: " + mcpStatus + "\n";
      text += "- Last Sync: " + (s.mcp.lastSync || "never") + "\n";
      text += "- Pending Identity: " + s.mcp.pendingIdentity + " | Pending Memories: " + s.mcp.pendingMemories + "\n\n";
      text += "## Knowledge Graph\n";
      text += "- " + graphInfo + "\n";

      await navigator.clipboard.writeText(text);
      flashButton(btn, "Copied!");
    } catch (_) {
      flashButton(btn, "Failed");
    }
  };

  function formatUptimeText(seconds) {
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    if (m > 0) parts.push(m + "m");
    if (parts.length === 0) parts.push(s + "s");
    return parts.join(" ");
  }


  function formatBytesText(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  /**
   * Run the batch-populate-graph script via the admin API.
   * Shows output in the #admin-action-output container.
   */
  window.adminRunBatchPopulate = async function () {
    var btn = document.getElementById("admin-batch-run-btn");
    var outputSection = document.getElementById("admin-action-output-section");
    var outputEl = document.getElementById("admin-action-output");

    if (!btn || !outputEl) return;

    var days = parseInt(document.getElementById("admin-batch-days")?.value, 10) || 30;
    var granularity = document.getElementById("admin-batch-granularity")?.value || "daily";
    var dryRun = document.getElementById("admin-batch-dry-run")?.checked || false;
    var verbose = document.getElementById("admin-batch-verbose")?.checked || false;

    // Disable button and show loading state
    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Running...';

    if (outputSection) outputSection.style.display = "";
    outputEl.textContent = "Spawning batch-populate-graph script...\n(This may take a while depending on memory count)\n";

    try {
      var res = await fetch("/api/admin/actions/batch-populate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: days, granularity: granularity, dryRun: dryRun, verbose: verbose }),
      });

      var data = await res.json();

      // Render output with monospace formatting
      var header = data.success
        ? "Exit code: " + data.exitCode
        : "FAILED (exit code " + data.exitCode + ")";
      outputEl.innerHTML = "<div class=\"admin-action-output-header\">" + escapeHtmlForOutput(header) + "</div>"
        + "<pre class=\"admin-action-output-pre\">" + escapeHtmlForOutput(data.output) + "</pre>";
    } catch (err) {
      outputEl.innerHTML = "<div class=\"admin-action-output-header admin-action-error\">Request failed: " + escapeHtmlForOutput(err.message) + "</div>";
    }

    // Restore button
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Script';
  };

  /**
   * Add instance suffix to old memory files via the admin API.
   * Shows output in the #admin-action-output container.
   */
  window.adminRunAddInstanceSuffix = async function () {
    var btn = document.getElementById("admin-suffix-run-btn");
    var outputSection = document.getElementById("admin-action-output-section");
    var outputEl = document.getElementById("admin-action-output");

    if (!btn || !outputEl) return;

    var instanceId = document.getElementById("admin-suffix-instance")?.value || "";
    var scopes = document.getElementById("admin-suffix-scopes")?.value || "both";
    var apply = document.getElementById("admin-suffix-apply")?.checked || false;

    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Running...';

    if (outputSection) outputSection.style.display = "";
    outputEl.textContent = "Scanning memory directories...\n";

    try {
      var body = { scopes: scopes, apply: apply };
      if (instanceId.trim()) body.instanceId = instanceId.trim();

      var res = await fetch("/api/admin/actions/add-instance-suffix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      var data = await res.json();

      var header = data.success
        ? "Done — " + (data.renamed || 0) + " renamed, " + data.total + " found"
        : "Completed with " + (data.errors || 0) + " error(s)";
      outputEl.innerHTML = "<div class=\"admin-action-output-header\">" + escapeHtmlForOutput(header) + "</div>"
        + "<pre class=\"admin-action-output-pre\">" + escapeHtmlForOutput(data.output) + "</pre>";
    } catch (err) {
      outputEl.innerHTML = "<div class=\"admin-action-output-header admin-action-error\">Request failed: " + escapeHtmlForOutput(err.message) + "</div>";
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run';
  };

  function escapeHtmlForOutput(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /**
   * Export entity data — fetches zip from the server and triggers a download.
   */
  window.adminExportEntity = async function () {
    var btn = document.getElementById("admin-export-btn");
    var outputSection = document.getElementById("admin-entity-output-section");
    var outputEl = document.getElementById("admin-entity-output");

    if (!btn || !outputEl) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Exporting...';

    if (outputSection) outputSection.style.display = "";
    outputEl.textContent = "Collecting entity data from entity-core and Psycheros...\n";

    try {
      var res = await fetch("/api/admin/entity-data/export", { method: "POST" });

      if (!res.ok) {
        var errorData = await res.json().catch(function () { return { error: res.statusText }; });
        throw new Error(errorData.error || "Export failed");
      }

      // Trigger browser download
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.split("filename=")[1]?.replace(/"/g, "") || "entity-export.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      var sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
      outputEl.innerHTML = '<div class="admin-action-output-header">Export complete — ' + escapeHtmlForOutput(sizeMB + " MB") + '</div>'
        + '<p>File downloaded to your browser. Keep it in a safe location for backup or migration.</p>';
    } catch (err) {
      outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">Export failed: ' + escapeHtmlForOutput(err.message) + '</div>';
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export Entity';
  };

  /**
   * Import entity data — shows confirmation dialog, uploads zip to server.
   */
  window.adminImportEntity = function () {
    var fileInput = document.getElementById("admin-import-file");
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      alert("Please select a zip file first.");
      return;
    }

    var file = fileInput.files[0];
    if (!file.name.endsWith(".zip")) {
      alert("Please select a .zip file.");
      return;
    }

    if (!confirm(
      "This will FULLY OVERWRITE all entity data:\n\n" +
      "- Identity files, memories, and knowledge graph (via MCP)\n" +
      "- Conversations, lorebooks, vault documents, and images\n\n" +
      "A snapshot is taken before overwriting entity-core data.\n" +
      "This action cannot be undone.\n\n" +
      "Proceed with import of " + file.name + " (" + (file.size / (1024 * 1024)).toFixed(1) + " MB)?"
    )) {
      return;
    }

    // Confirmed — run the actual import
    window.adminConfirmImport(file);
  };

  /**
   * Perform the actual import after user confirmation.
   */
  window.adminConfirmImport = async function (file) {
    var btn = document.getElementById("admin-import-btn");
    var outputSection = document.getElementById("admin-entity-output-section");
    var outputEl = document.getElementById("admin-entity-output");

    if (!btn || !outputEl) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Importing...';

    if (outputSection) outputSection.style.display = "";
    outputEl.textContent = "Importing " + file.name + "...\n(This may take a while)\n";

    try {
      var formData = new FormData();
      formData.append("file", file);

      // Read file as ArrayBuffer for the server
      var arrayBuffer = await file.arrayBuffer();
      var res = await fetch("/api/admin/entity-data/import", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: arrayBuffer,
      });

      var data = await res.json();

      if (data.success) {
        var lines = ["Import complete."];
        var d = data.details;
        if (d) {
          if (d.psycheros) {
            if (d.psycheros.conversations_restored !== undefined) {
              lines.push("Conversations: " + d.psycheros.conversations_restored);
              lines.push("Messages: " + d.psycheros.messages_restored);
            }
            if (d.psycheros.lorebooks_restored !== undefined) {
              lines.push("Lorebooks: " + d.psycheros.lorebooks_restored);
              lines.push("Lorebook entries: " + d.psycheros.lorebook_entries_restored);
            }
            if (d.psycheros.vault_documents_restored !== undefined) {
              lines.push("Vault documents: " + d.psycheros.vault_documents_restored);
            }
            if (d.psycheros.images_restored !== undefined) {
              lines.push("Images: " + d.psycheros.images_restored);
            }
            if (d.psycheros.anchor_images_restored !== undefined) {
              lines.push("Anchor images: " + d.psycheros.anchor_images_restored);
            }
          }
          if (d.entity_core) {
            lines.push("Entity-core: " + (d.entity_core.success ? "OK" : "FAILED — " + (d.entity_core.error || "unknown error")));
          }
          if (d.sync_pull) {
            lines.push("MCP sync pull: completed");
          }
        }
        outputEl.innerHTML = '<div class="admin-action-output-header">Import successful</div>'
          + '<pre class="admin-action-output-pre">' + escapeHtmlForOutput(lines.join("\n")) + '</pre>';
      } else {
        outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">Import failed: ' + escapeHtmlForOutput(data.error || "unknown error") + '</div>';
      }
    } catch (err) {
      outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">Request failed: ' + escapeHtmlForOutput(err.message) + '</div>';
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Full Overwrite Import';
  };

  /**
   * Import memory files via the data migration API.
   * @param {"daily"|"significant"} granularity
   */
  window.adminImportMemories = async function (granularity) {
    var fileInputId = granularity === "significant"
      ? "admin-migration-sig-files"
      : "admin-migration-daily-files";
    var btnId = granularity === "significant"
      ? "admin-migration-sig-btn"
      : "admin-migration-daily-btn";
    var outputId = granularity === "significant"
      ? "admin-migration-sig-output"
      : "admin-migration-daily-output";

    var fileInput = document.getElementById(fileInputId);
    var btn = document.getElementById(btnId);
    var outputEl = document.getElementById(outputId);

    if (!fileInput || !btn || !outputEl) return;

    if (!fileInput.files || fileInput.files.length === 0) {
      alert("Please select at least one .md file.");
      return;
    }

    var files = Array.from(fileInput.files);
    var invalidFiles = files.filter(function (f) { return !f.name.endsWith(".md"); });
    if (invalidFiles.length > 0) {
      alert("Only .md files are supported. Found: " + invalidFiles.map(function (f) { return f.name; }).join(", "));
      return;
    }

    var label = granularity === "significant" ? "Significant Memories" : "Daily Memories";
    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Importing...';

    outputEl.style.display = "";
    outputEl.textContent = "Importing " + files.length + " " + label.toLowerCase() + "...\n";

    try {
      var formData = new FormData();
      files.forEach(function (file) {
        formData.append("files", file);
      });
      formData.append("granularity", granularity);

      var res = await fetch("/api/admin/data-migration/memories", {
        method: "POST",
        body: formData,
      });

      var data = await res.json();

      if (data.error && !data.imported && !data.merged && (!data.errors || data.errors.length === 0)) {
        // Fatal error (e.g., entity-core data dir not found)
        outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">'
          + escapeHtmlForOutput(data.error) + '</div>';
      } else {
        var lines = [];
        lines.push(label + " import complete.");
        lines.push("Successfully imported: " + (data.imported || 0));
        if (data.merged) {
          lines.push("Merged with existing: " + data.merged);
        }

        if (data.errors && data.errors.length > 0) {
          lines.push("");
          lines.push("Errors (" + data.errors.length + "):");
          data.errors.forEach(function (e) {
            lines.push("  " + e.filename + ": " + e.error);
          });
        }

        outputEl.innerHTML = '<div class="admin-action-output-header">'
          + escapeHtmlForOutput(lines[0]) + '</div>'
          + '<pre class="admin-action-output-pre">' + escapeHtmlForOutput(lines.join("\n")) + '</pre>';
      }
    } catch (err) {
      outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">'
        + 'Request failed: ' + escapeHtmlForOutput(err.message) + '</div>';
    }

    // Restore button
    var btnText = granularity === "significant" ? "Import Significant Memories" : "Import Daily Memories";
    var btnSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
      + '<polyline points="17 8 12 3 7 8"/>'
      + '<line x1="12" y1="3" x2="12" y2="15"/>'
      + '</svg>';
    btn.disabled = false;
    btn.innerHTML = btnSvg + " " + btnText;

    // Clear file input after import
    fileInput.value = "";
  };

  /**
   * Import conversations from entity-loom chats.db via streaming NDJSON.
   * Reads progress events and updates the progress bar in real time.
   */
  window.adminImportChats = async function () {
    var fileInput = document.getElementById("admin-migration-chat-files");
    var btn = document.getElementById("admin-migration-chat-btn");
    var progressSection = document.getElementById("admin-migration-chat-progress");
    var progressFill = document.getElementById("admin-migration-chat-fill");
    var progressText = document.getElementById("admin-migration-chat-text");
    var outputEl = document.getElementById("admin-migration-chat-output");

    if (!fileInput || !btn || !outputEl) return;

    if (!fileInput.files || fileInput.files.length === 0) {
      alert("Please select a .db file.");
      return;
    }

    var file = fileInput.files[0];
    if (!file.name.endsWith(".db")) {
      alert("Please select a .db file.");
      return;
    }

    if (!confirm(
      "Import conversations from " + file.name + " (" + (file.size / (1024 * 1024)).toFixed(1) + " MB)?\n\n" +
      "Existing conversations are skipped by ID.\n" +
      "New messages are merged (never overwritten).\n" +
      "If RAG embedding is enabled, this may take several minutes."
    )) {
      return;
    }

    var doEmbed = document.getElementById("admin-migration-chat-embed")?.checked ?? true;

    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Importing...';

    if (progressSection) progressSection.style.display = "";
    if (progressFill) progressFill.style.width = "0%";
    if (progressText) progressText.textContent = "Preparing...";
    outputEl.style.display = "none";
    outputEl.innerHTML = "";

    try {
      var formData = new FormData();
      formData.append("file", file);
      formData.append("embed", doEmbed ? "true" : "false");

      var res = await fetch("/api/admin/data-migration/chats", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        var errorData = await res.json().catch(function () { return { error: res.statusText }; });
        throw new Error(errorData.error || "Import failed");
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var dbPhaseTotal = 0;
      var embedPhaseTotal = 0;
      var finalData = null;

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });

        var lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          try {
            var evt = JSON.parse(line);
          } catch (_) {
            continue;
          }

          if (evt.phase === "db" && !evt.done) {
            // DB phase progress
            var pct = evt.total > 0 ? Math.round((evt.conversations_processed / evt.total) * 100) : 0;
            if (progressFill) progressFill.style.width = pct + "%";
            if (progressText) progressText.textContent = evt.status + " (" + evt.conversations_processed + "/" + evt.total + ")";
            dbPhaseTotal = evt.total;
          } else if (evt.phase === "db" && evt.done) {
            // DB phase complete
            if (progressFill) progressFill.style.width = "100%";
            if (progressText) progressText.textContent = "Database import complete.";
            finalData = evt;
          } else if (evt.phase === "embed") {
            // Embedding phase progress
            var pct = evt.total > 0 ? Math.round((evt.current / evt.total) * 100) : 0;
            if (progressFill) progressFill.style.width = pct + "%";
            if (progressText) progressText.textContent = evt.status + " (" + evt.current + "/" + evt.total + ", " + evt.elapsed + ")";
            embedPhaseTotal = evt.total;
          } else if (evt.phase === "done") {
            // All done
            finalData = evt;
          }
        }
      }

      // Show final output
      if (progressSection) progressSection.style.display = "none";
      outputEl.style.display = "";

      if (finalData) {
        var lines = ["Chat import complete."];
        lines.push("Conversations created: " + (finalData.conversations_created || 0));
        if (finalData.conversations_forked) {
          lines.push("Conversations forked (continued on both sides): " + finalData.conversations_forked);
        }
        if (finalData.conversations_up_to_date) {
          lines.push("Conversations up to date: " + finalData.conversations_up_to_date);
        }
        lines.push("Messages imported: " + (finalData.messages_imported || 0));
        if (finalData.messages_skipped) {
          lines.push("Messages skipped (already exist): " + finalData.messages_skipped);
        }
        if (finalData.messages_embedded) {
          lines.push("Messages embedded for RAG: " + finalData.messages_embedded);
        }
        if (finalData.messages_embed_skipped) {
          lines.push("Embedding failures (skipped): " + finalData.messages_embed_skipped);
        }
        if (finalData.duration) {
          lines.push("Duration: " + finalData.duration);
        }

        outputEl.innerHTML = '<div class="admin-action-output-header">'
          + escapeHtmlForOutput(lines[0]) + '</div>'
          + '<pre class="admin-action-output-pre">' + escapeHtmlForOutput(lines.join("\n")) + '</pre>';
      } else {
        outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">No response received</div>';
      }
    } catch (err) {
      if (progressSection) progressSection.style.display = "none";
      outputEl.style.display = "";
      outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">'
        + 'Request failed: ' + escapeHtmlForOutput(err.message) + '</div>';
    }

    // Restore button
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
      + '<polyline points="17 8 12 3 7 8"/>'
      + '<line x1="12" y1="3" x2="12" y2="15"/>'
      + '</svg> Import Conversations';

    fileInput.value = "";
  };

  /**
   * Import knowledge graph from entity-loom graph.db via streaming NDJSON.
   * Shows blocking overlay while entity-core is stopped.
   */
  window.adminImportGraph = async function () {
    var fileInput = document.getElementById("admin-migration-graph-files");
    var btn = document.getElementById("admin-migration-graph-btn");
    var progressSection = document.getElementById("admin-migration-graph-progress");
    var progressFill = document.getElementById("admin-migration-graph-fill");
    var progressText = document.getElementById("admin-migration-graph-text");
    var overlay = document.getElementById("admin-migration-graph-overlay");
    var outputEl = document.getElementById("admin-migration-graph-output");

    if (!fileInput || !btn || !outputEl) return;

    if (!fileInput.files || fileInput.files.length === 0) {
      alert("Please select a .db file.");
      return;
    }

    var file = fileInput.files[0];
    if (!file.name.endsWith(".db")) {
      alert("Please select a .db file.");
      return;
    }

    if (!confirm(
      "Import knowledge graph from " + file.name + " (" + (file.size / (1024 * 1024)).toFixed(1) + " MB)?\n\n" +
      "Entity-core will be temporarily stopped during import.\n" +
      "Existing nodes and edges are skipped by ID.\n" +
      "Missing vector embeddings will be computed."
    )) {
      return;
    }

    var doEmbed = document.getElementById("admin-migration-graph-embed")?.checked ?? true;

    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Importing...';

    if (progressSection) progressSection.style.display = "";
    if (progressFill) progressFill.style.width = "0%";
    if (progressText) progressText.textContent = "Preparing...";
    outputEl.style.display = "none";
    outputEl.innerHTML = "";

    try {
      var formData = new FormData();
      formData.append("file", file);
      formData.append("embed", doEmbed ? "true" : "false");

      var res = await fetch("/api/admin/data-migration/graph", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        var errorData = await res.json().catch(function () { return { error: res.statusText }; });
        throw new Error(errorData.error || "Import failed");
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var finalData = null;
      var totalItems = 0;

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });

        var lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          try {
            var evt = JSON.parse(line);
          } catch (_) {
            continue;
          }

          if (evt.phase === "restart") {
            if (evt.status && evt.status.indexOf("Stopping") !== -1) {
              // Show blocking overlay when entity-core is being stopped
              if (overlay) overlay.style.display = "";
            }
            if (progressText) progressText.textContent = evt.status;
          } else if (evt.phase === "db" && !evt.done) {
            // DB phase progress
            var items = evt.nodes_processed || evt.edges_processed || 0;
            totalItems = evt.total || totalItems;
            var pct = totalItems > 0 ? Math.round((items / totalItems) * 100) : 0;
            if (progressFill) progressFill.style.width = pct + "%";
            if (progressText) progressText.textContent = evt.status + " (" + items + "/" + totalItems + ")";
          } else if (evt.phase === "db" && evt.done) {
            finalData = evt;
            if (progressFill) progressFill.style.width = "100%";
            if (progressText) progressText.textContent = "Database import complete.";
          } else if (evt.phase === "embed") {
            var pct = evt.total > 0 ? Math.round((evt.current / evt.total) * 100) : 0;
            if (progressFill) progressFill.style.width = pct + "%";
            if (progressText) progressText.textContent = evt.status + " (" + evt.current + "/" + evt.total + ", " + evt.elapsed + ")";
          } else if (evt.phase === "done") {
            finalData = evt;
          } else if (evt.phase === "error") {
            throw new Error(evt.error || "Import failed");
          }
        }
      }

      // Hide overlay and progress, show output
      if (overlay) overlay.style.display = "none";
      if (progressSection) progressSection.style.display = "none";
      outputEl.style.display = "";

      if (finalData) {
        var lines = ["Knowledge graph import complete."];
        lines.push("Nodes imported: " + (finalData.nodes_imported || 0));
        if (finalData.nodes_skipped) {
          lines.push("Nodes skipped (already exist): " + finalData.nodes_skipped);
        }
        lines.push("Edges imported: " + (finalData.edges_imported || 0));
        if (finalData.edges_skipped) {
          lines.push("Edges skipped (already exist): " + finalData.edges_skipped);
        }
        if (finalData.nodes_embedded) {
          lines.push("Nodes embedded for vector search: " + finalData.nodes_embedded);
        }
        if (finalData.nodes_embed_skipped) {
          lines.push("Embedding failures (skipped): " + finalData.nodes_embed_skipped);
        }
        if (finalData.entity_core_restarted) {
          lines.push("Entity-core: restarted successfully");
        }
        if (finalData.duration) {
          lines.push("Duration: " + finalData.duration);
        }

        outputEl.innerHTML = '<div class="admin-action-output-header">'
          + escapeHtmlForOutput(lines[0]) + '</div>'
          + '<pre class="admin-action-output-pre">' + escapeHtmlForOutput(lines.join("\n")) + '</pre>';
      } else {
        outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">No response received</div>';
      }
    } catch (err) {
      if (overlay) overlay.style.display = "none";
      if (progressSection) progressSection.style.display = "none";
      outputEl.style.display = "";
      outputEl.innerHTML = '<div class="admin-action-output-header admin-action-error">'
        + 'Request failed: ' + escapeHtmlForOutput(err.message) + '</div>';
    }

    // Restore button
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
      + '<polyline points="17 8 12 3 7 8"/>'
      + '<line x1="12" y1="3" x2="12" y2="15"/>'
      + '</svg> Import Knowledge Graph';

    fileInput.value = "";
  };

  // Format timestamps already on the page
  formatLocalTimes();

  // Register htmx:afterSettle listener once (guard against re-execution)
  if (!window._adminAfterSettleRegistered) {
    window._adminAfterSettleRegistered = true;
    document.body.addEventListener("htmx:afterSettle", function (event) {
      formatLocalTimes(event.detail.elt);
    });
  }
})();
