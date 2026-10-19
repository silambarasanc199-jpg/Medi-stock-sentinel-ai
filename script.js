
"use strict";

const STORAGE_KEY = "medistock_sentinel_v2";
const EXPIRY_WARNING_DAYS = 60;
const TARGET_COVER_DAYS = 30;

const $ = (id) => document.getElementById(id);

function localDate(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

function money(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function daysUntil(dateString) {
  const target = new Date(dateString + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target - today) / 86400000);
}

function makeDemoData() {
  const batches = [
    {
      id: "b1", name: "Paracetamol 500mg", sku: "PARA500",
      batch: "P-101", expiry: localDate(25), qty: 400,
      daily: 10, reorder: 150, lead: 5, cost: 0.4
    },
    {
      id: "b2", name: "Paracetamol 500mg", sku: "PARA500",
      batch: "P-102", expiry: localDate(200), qty: 600,
      daily: 10, reorder: 150, lead: 5, cost: 0.4
    },
    {
      id: "b3", name: "Amoxicillin 250mg", sku: "AMOX250",
      batch: "A-77", expiry: localDate(40), qty: 120,
      daily: 12, reorder: 100, lead: 7, cost: 1.2
    },
    {
      id: "b4", name: "Insulin R", sku: "INS-R",
      batch: "I-09", expiry: localDate(150), qty: 30,
      daily: 6, reorder: 40, lead: 10, cost: 8.5
    },
    {
      id: "b5", name: "ORS Sachet", sku: "ORS",
      batch: "O-5", expiry: localDate(-5), qty: 80,
      daily: 2, reorder: 20, lead: 4, cost: 0.3
    },
    {
      id: "b6", name: "Cetirizine 10mg", sku: "CET10",
      batch: "C-3", expiry: localDate(300), qty: 300,
      daily: 8, reorder: 100, lead: 6, cost: 0.2
    }
  ];

  return {
    batches,
    actions: [],
    history: [{
      id: "h1",
      message: "Demo inventory initialized. Sample data only.",
      time: new Date().toISOString()
    }],
    lastRun: null
  };
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      if (
        data &&
        Array.isArray(data.batches) &&
        Array.isArray(data.actions) &&
        Array.isArray(data.history)
      ) {
        return data;
      }
    }
  } catch (error) {
    console.warn("Saved data could not be loaded.", error);
  }

  return makeDemoData();
}

let state = loadState();
let activeFilter = "all";
let searchTerm = "";

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    alert("Could not save data in this browser. Storage may be full or disabled.");
    console.error(error);
    return false;
  }
}

function logActivity(message) {
  state.history.unshift({
    id: "h" + Date.now() + Math.random().toString(36).slice(2, 6),
    message,
    time: new Date().toISOString()
  });

  state.history = state.history.slice(0, 100);
}

function groupBySKU() {
  const groups = new Map();

  for (const batch of state.batches) {
    if (!groups.has(batch.sku)) {
      groups.set(batch.sku, []);
    }
    groups.get(batch.sku).push(batch);
  }

  return groups;
}

function usableQuantity(batches) {
  return batches.reduce((sum, batch) => {
    // Expired batches are excluded from usable stock.
    return sum + (daysUntil(batch.expiry) < 0 ? 0 : batch.qty);
  }, 0);
}

function analyzeInventory() {
  const proposed = [];
  const groups = groupBySKU();

  for (const batch of state.batches) {
    const days = daysUntil(batch.expiry);

    if (days < 0) {
      proposed.push({
        id: "expiry-" + batch.id,
        type: "expiry",
        severity: "high",
        sku: batch.sku,
        batchId: batch.id,
        title: "Expired batch requires quarantine review",
        reason: batch.name + " · Batch " + batch.batch +
          " expired " + Math.abs(days) + " day(s) ago.",
        quantity: batch.qty,
        estimatedCost: batch.qty * batch.cost
      });
    } else if (days <= EXPIRY_WARNING_DAYS) {
      proposed.push({
        id: "expiry-" + batch.id,
        type: "expiry",
        severity: days <= 14 ? "high" : "medium",
        sku: batch.sku,
        batchId: batch.id,
        title: "Near-expiry batch detected",
        reason: batch.name + " · Batch " + batch.batch +
          " expires in " + days + " day(s). Review FEFO use and local policy.",
        quantity: batch.qty,
        estimatedCost: batch.qty * batch.cost
      });
    }
  }

  for (const [sku, batches] of groups) {
    const sample = batches[0];

    // These fields are SKU-level inputs. Use the first matching batch's
    // usage and reorder settings to avoid counting demand multiple times.
    const daily = Math.max(0, Number(sample.daily) || 0);
    const lead = Math.max(0, Number(sample.lead) || 0);
    const reorder = Math.max(0, Number(sample.reorder) || 0);
    const usable = usableQuantity(batches);

    // Reorder point = lead-time demand + 3 days of safety stock.
    const reorderPoint = daily * (lead + 3);

    if (usable <= reorderPoint) {
      const targetStock = daily * TARGET_COVER_DAYS;
      const quantity = Math.max(
        0,
        Math.ceil(Math.max(reorder, targetStock) - usable)
      );

      proposed.push({
        id: "reorder-" + sku,
        type: "reorder",
        severity: usable <= daily * lead ? "high" : "medium",
        sku,
        batchId: null,
        title: "Stockout risk: " + sample.name,
        reason:
          "Usable stock: " + usable +
          " units. Reorder threshold: " + Math.ceil(reorderPoint) +
          " units. Estimated lead time: " + lead + " days.",
        quantity,
        estimatedCost: quantity * Number(sample.cost || 0)
      });
    }
  }

  // Keep the review status of previously generated recommendations.
  const previous = new Map(state.actions.map(action => [action.id, action]));

  state.actions = proposed.map(action => {
    const old = previous.get(action.id);
    return {
      ...action,
      status: old ? old.status : "pending",
      reviewer: old ? old.reviewer : "",
      reviewedAt: old ? old.reviewedAt : null
    };
  });

  state.lastRun = new Date().toISOString();
  logActivity("Inventory analysis completed. " + proposed.length +
    " recommendation(s) generated.");
  saveState();
  render();
}

function badgeClass(severity) {
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function renderMetrics() {
  const total = state.batches.reduce((sum, batch) => sum + batch.qty, 0);

  const expiryRisk = state.batches.filter(batch =>
    daysUntil(batch.expiry) <= EXPIRY_WARNING_DAYS
  ).length;

  const stockoutSKUs = new Set(
    state.actions
      .filter(action => action.type === "reorder")
      .map(action => action.sku)
  );

  const pending = state.actions.filter(
    action => action.status === "pending"
  ).length;

  $("totalUnits").textContent = total.toLocaleString("en-IN");
  $("expiryCount").textContent = expiryRisk;
  $("stockoutCount").textContent = stockoutSKUs.size;
  $("draftCount").textContent = pending;
  $("lastRun").textContent = state.lastRun
    ? "Last run: " + new Date(state.lastRun).toLocaleString()
    : "Analysis not run yet";
}

function renderActions() {
  const root = $("actions");

  if (!state.actions.length) {
    root.innerHTML = '<div class="empty">No risks detected in the current inventory.</div>';
    return;
  }

  root.innerHTML = state.actions.map(action => {
    const isPending = action.status === "pending";
    const statusText = isPending
      ? "PENDING REVIEW"
      : action.status === "approved" ? "APPROVED" : "REJECTED";

    return `
      <article class="action-card">
        <div class="action-top">
          <div>
            <h3>${escapeHTML(action.title)}</h3>
            <p>${escapeHTML(action.reason)}</p>
          </div>
          <span class="tag ${isPending ? badgeClass(action.severity) : "done"}">
            ${statusText}
          </span>
        </div>
        <div class="batch-meta">
          <div>
            <span>Proposed quantity</span>
            <strong>${Number(action.quantity).toLocaleString("en-IN")} units</strong>
          </div>
          <div>
            <span>Estimated value</span>
            <strong>${money(action.estimatedCost)}</strong>
          </div>
          <div>
            <span>Action type</span>
            <strong>${action.type === "expiry" ? "Expiry review" : "Reorder draft"}</strong>
          </div>
        </div>
        ${action.reviewer ? `<p>Reviewed by ${escapeHTML(action.reviewer)} · ${escapeHTML(new Date(action.reviewedAt).toLocaleString())}</p>` : ""}
        ${isPending ? `
          <div class="action-buttons">
            <button class="action-button approve" data-action="approve" data-id="${escapeHTML(action.id)}">Approve draft</button>
            <button class="action-button reject" data-action="reject" data-id="${escapeHTML(action.id)}">Reject draft</button>
          </div>
        ` : ""}
      </article>
    `;
  }).join("");
}

function matchesFilter(batch) {
  const days = daysUntil(batch.expiry);
  const expiryRisk = days <= EXPIRY_WARNING_DAYS;

  const skuActions = state.actions.filter(
    action => action.sku === batch.sku
  );
  const stockoutRisk = skuActions.some(action => action.type === "reorder");

  if (activeFilter === "expiry" && !expiryRisk) return false;
  if (activeFilter === "stockout" && !stockoutRisk) return false;

  const searchable = (
    batch.name + " " + batch.sku + " " + batch.batch
  ).toLowerCase();

  return searchable.includes(searchTerm.toLowerCase());
}

function renderInventory() {
  const root = $("inventory");
  const batches = [...state.batches]
    .filter(matchesFilter)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  if (!batches.length) {
    root.innerHTML = '<div class="empty">No matching batches found.</div>';
    return;
  }

  root.innerHTML = batches.map(batch => {
    const days = daysUntil(batch.expiry);
    const expired = days < 0;
    const near = !expired && days <= EXPIRY_WARNING_DAYS;

    const expiryLabel = expired
      ? "EXPIRED"
      : near ? "NEAR EXPIRY" : "OK";

    const expiryClass = expired || days <= 14
      ? "high"
      : near ? "medium" : "low";

    const group = groupBySKU().get(batch.sku) || [batch];
    const stock = usableQuantity(group);
    const daily = Number(group[0].daily) || 0;
    const coverDays = daily > 0 ? Math.floor(stock / daily) : null;

    return `
      <article class="batch-card">
        <div class="batch-top">
          <div>
            <h3>${escapeHTML(batch.name)}</h3>
            <p>SKU: ${escapeHTML(batch.sku)} · Batch: ${escapeHTML(batch.batch)}</p>
          </div>
          <span class="tag ${expiryClass}">${expiryLabel}</span>
        </div>
        <div class="batch-meta">
          <div>
            <span>Batch quantity</span>
            <strong>${Number(batch.qty).toLocaleString("en-IN")} units</strong>
          </div>
          <div>
            <span>Expiry date</span>
            <strong>${escapeHTML(batch.expiry)}</strong>
          </div>
          <div>
            <span>Days to expiry</span>
            <strong>${expired ? Math.abs(days) + " days ago" : days + " days"}</strong>
          </div>
          <div>
            <span>SKU usable stock</span>
            <strong>${stock.toLocaleString("en-IN")} units</strong>
          </div>
          <div>
            <span>Estimated stock cover</span>
            <strong>${coverDays === null ? "Unknown" : coverDays + " days"}</strong>
          </div>
          <div>
            <span>Batch value</span>
            <strong>${money(batch.qty * batch.cost)}</strong>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderHistory() {
  const root = $("history");

  if (!state.history.length) {
    root.innerHTML = '<div class="empty">No activity recorded yet.</div>';
    return;
  }

  root.innerHTML = state.history.slice(0, 20).map(item => `
    <div class="history-item">
      <p>${escapeHTML(item.message)}</p>
      <time>${escapeHTML(new Date(item.time).toLocaleString())}</time>
    </div>
  `).join("");
}

function render() {
  renderMetrics();
  renderActions();
  renderInventory();
  renderHistory();
}

function reviewAction(id, decision) {
  const action = state.actions.find(item => item.id === id);

  if (!action || action.status !== "pending") {
    alert("This draft has already been reviewed or no longer exists.");
    return;
  }

  const reviewer = prompt("Enter your name for the review record:");
  if (!reviewer || !reviewer.trim()) {
    alert("Reviewer name is required.");
    return;
  }

  const confirmed = confirm(
    (decision === "approve" ? "Approve" : "Reject") +
    " this recommendation draft?\n\n" +
    "This records a review only. It will not place an order or change stock."
  );

  if (!confirmed) return;

  action.status = decision === "approve" ? "approved" : "rejected";
  action.reviewer = reviewer.trim().slice(0, 100);
  action.reviewedAt = new Date().toISOString();

  logActivity(
    action.status.toUpperCase() + " draft: " + action.title +
    " · Reviewer: " + action.reviewer
  );

  if (saveState()) render();
}

$("actions").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  reviewAction(button.dataset.id, button.dataset.action);
});

$("refreshBtn").addEventListener("click", analyzeInventory);

$("searchInput").addEventListener("input", event => {
  searchTerm = event.target.value.trim();
  renderInventory();
});

document.querySelectorAll("[data-filter]").forEach(button => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;

    document.querySelectorAll("[data-filter]").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    renderInventory();
  });
});

$("batchForm").addEventListener("submit", event => {
  event.preventDefault();

  const form = new FormData(event.currentTarget);
  const batch = {
    id: "b" + Date.now(),
    name: String(form.get("name")).trim(),
    sku: String(form.get("sku")).trim().toUpperCase(),
    batch: String(form.get("batch")).trim().toUpperCase(),
    expiry: String(form.get("expiry")),
    qty: Number(form.get("qty")),
    daily: Number(form.get("daily")),
    reorder: Number(form.get("reorder")),
    lead: Number(form.get("lead")),
    cost: Number(form.get("cost"))
  };

  if (
    !batch.name || !batch.sku || !batch.batch ||
    !batch.expiry ||
    !Number.isFinite(batch.qty) || batch.qty < 0 ||
    !Number.isFinite(batch.daily) || batch.daily < 0 ||
    !Number.isFinite(batch.reorder) || batch.reorder < 0 ||
    !Number.isInteger(batch.lead) || batch.lead < 0 ||
    !Number.isFinite(batch.cost) || batch.cost < 0
  ) {
    alert("Please check all fields and enter valid non-negative values.");
    return;
  }

  const duplicate = state.batches.some(item =>
    item.sku.toUpperCase() === batch.sku &&
    item.batch.toUpperCase() === batch.batch
  );

  if (duplicate) {
    alert("That SKU and batch number already exist.");
    return;
  }

  state.batches.push(batch);
  logActivity("Added batch " + batch.batch + " for " + batch.name + ".");

  if (!saveState()) return;

  event.currentTarget.reset();
  analyzeInventory();
});

$("exportBtn").addEventListener("click", () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    mode: "local-demo",
    disclaimer: "Sample/local data. Not a production medical inventory record.",
    ...state
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "medistock-inventory-export.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  logActivity("Inventory data exported as JSON.");
  saveState();
  renderHistory();
});

$("resetBtn").addEventListener("click", () => {
  const confirmed = confirm(
    "Reset this browser's MediStock demo data?\n" +
    "Your current local batches, actions and history will be replaced."
  );

  if (!confirmed) return;

  state = makeDemoData();
  activeFilter = "all";
  searchTerm = "";
  $("searchInput").value = "";

  document.querySelectorAll("[data-filter]").forEach(button => {
    button.classList.toggle("active", button.dataset.filter === "all");
  });

  saveState();
  analyzeInventory();
});

// Initial startup: preserve saved data and calculate current recommendations.
if (!state.lastRun) {
  analyzeInventory();
} else {
  render();
  }
    
