/**
 * Entity Core Client-Side Logic
 *
 * Handles batch populate and embed memories script runners for the
 * Entity Core maintenance tab.
 */

(function () {
  function escapeHtmlForOutput(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /**
   * Run the batch-populate-graph script via the admin API.
   * Shows output in the #ec-batch-output container.
   */
  window.ecRunBatchPopulate = async function () {
    var btn = document.getElementById("ec-batch-run-btn");
    var outputSection = document.getElementById("ec-batch-output-section");
    var outputEl = document.getElementById("ec-batch-output");

    if (!btn || !outputEl) return;

    var days = parseInt(document.getElementById("ec-batch-days")?.value, 10) || 30;
    var granularity = document.getElementById("ec-batch-granularity")?.value || "daily";
    var dryRun = document.getElementById("ec-batch-dry-run")?.checked || false;
    var verbose = document.getElementById("ec-batch-verbose")?.checked || false;

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

      var header = data.success
        ? "Exit code: " + data.exitCode
        : "FAILED (exit code " + data.exitCode + ")";
      outputEl.innerHTML = "<div class=\"admin-action-output-header\">" + escapeHtmlForOutput(header) + "</div>"
        + "<pre class=\"admin-action-output-pre\">" + escapeHtmlForOutput(data.output) + "</pre>";
    } catch (err) {
      outputEl.innerHTML = "<div class=\"admin-action-output-header admin-action-error\">Request failed: " + escapeHtmlForOutput(err.message) + "</div>";
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Script';
  };

  /**
   * Run the embed-existing-memories script via the Entity Core API.
   * Shows output in the #ec-embed-output container.
   */
  window.ecRunEmbedMemories = async function () {
    var btn = document.getElementById("ec-embed-run-btn");
    var outputSection = document.getElementById("ec-embed-output-section");
    var outputEl = document.getElementById("ec-embed-output");

    if (!btn || !outputEl) return;

    var dryRun = document.getElementById("ec-embed-dry-run")?.checked || false;
    var verbose = document.getElementById("ec-embed-verbose")?.checked || false;

    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Running...';

    if (outputSection) outputSection.style.display = "";
    outputEl.textContent = "Spawning embed-existing-memories script...\n";

    try {
      var res = await fetch("/api/entity-core/actions/embed-memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: dryRun, verbose: verbose }),
      });

      var data = await res.json();

      var header = data.success
        ? "Exit code: " + data.exitCode
        : "FAILED (exit code " + data.exitCode + ")";
      outputEl.innerHTML = "<div class=\"admin-action-output-header\">" + escapeHtmlForOutput(header) + "</div>"
        + "<pre class=\"admin-action-output-pre\">" + escapeHtmlForOutput(data.output) + "</pre>";
    } catch (err) {
      outputEl.innerHTML = "<div class=\"admin-action-output-header admin-action-error\">Request failed: " + escapeHtmlForOutput(err.message) + "</div>";
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Script';
  };
})();
