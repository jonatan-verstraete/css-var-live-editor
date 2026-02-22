const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));

const STYLE_ID = "doubledash-editor-overrides";
const ROOT_MARKER_ATTR = "data-doubledash-editor";
const SESSION_KEY = `doubledash:state:${tabId}`;
const STORAGE_AREA = chrome.storage.session;


// TODO. Fix features set to false due to inaccuracy.
const FEATURES = {
  // Show the "Multi-Declared" filter chip (counts repeated declarations, not cascade winners).
  filterMultiDeclared: false,
  filterColors: false,
  // Show the "Apply to element only" toggle for local inline style edits on $0.
  selectedOnly: false,
  // Show the "Selected only" toggle to focus vars visible/declared on current selection.
  localEditMode: false,
  // Show per-row "Trace" action that walks inheritance boundaries to guess source.
  traceSource: false,
};


const FILTER_ORDER = [
  ...(FEATURES.filterMultiDeclared ? ["multiDeclared"] : []),
  ...(FEATURES.filterColors ? ["colors"] : [])
];
const FILTER_CYCLE = {
  off: "include",
  include: "exclude",
  exclude: "off"
};

const state = {
  variables: [],
  selectionLabel: "",
  overrides: {},
  filterStates: {
    multiDeclared: "off",
    colors: "off"
  },
  showSelectedOnly: false,
  localEditMode: false,
  refreshQueued: false,
  refreshTimer: null,
  loading: false,
  pageKey: "",
  corsSkippedSheets: 0
};

const els = {
  searchInput: document.getElementById("searchInput"),
  copyBtn: document.getElementById("copyBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  resetBtn: document.getElementById("resetBtn"),
  selectedOnlyToggle: document.getElementById("selectedOnlyToggle"),
  localModeToggle: document.getElementById("localModeToggle"),
  filterButtons: Array.from(document.querySelectorAll(".filter-btn")),
  meta: document.getElementById("meta"),
  varList: document.getElementById("varList"),
  rowTemplate: document.getElementById("rowTemplate")
};

let syncDebounceTimer = null;
let syncWaiters = [];

function fuzzyMatch(haystack, query) {
  if (!query) {
    return true;
  }

  let qi = 0;
  for (let i = 0; i < haystack.length && qi < query.length; i += 1) {
    if (haystack[i] === query[qi]) {
      qi += 1;
    }
  }

  return qi === query.length;
}

function applyTheme(theme) {
  const themeName = String(theme || chrome.devtools?.panels?.themeName || "default");
  document.documentElement.dataset.theme = themeName.includes("dark") ? "dark" : "light";
}

function evalOnInspectedPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo?.isException) {
        reject(new Error(exceptionInfo.value || "Execution failed"));
        return;
      }
      resolve(result);
    });
  });
}

function normalizeDeepScan(result) {
  if (!result || typeof result !== "object") {
    return {
      variables: [],
      selectionLabel: "No element selected",
      pageKey: "",
      corsSkippedSheets: 0
    };
  }

  return {
    variables: Array.isArray(result.variables) ? result.variables : [],
    selectionLabel: typeof result.selectionLabel === "string" ? result.selectionLabel : "No element selected",
    pageKey: typeof result.pageKey === "string" ? result.pageKey : "",
    corsSkippedSheets: Number.isFinite(result.corsSkippedSheets) ? result.corsSkippedSheets : 0
  };
}

function normalizeSelectionSnapshot(result) {
  if (!result || typeof result !== "object") {
    return {
      selectionLabel: "No element selected",
      selectedValues: {},
      selectedDeclaredValues: {}
    };
  }

  return {
    selectionLabel: typeof result.selectionLabel === "string" ? result.selectionLabel : "No element selected",
    selectedValues:
      result.selectedValues && typeof result.selectedValues === "object" ? result.selectedValues : {},
    selectedDeclaredValues:
      result.selectedDeclaredValues && typeof result.selectedDeclaredValues === "object"
        ? result.selectedDeclaredValues
        : {}
  };
}

async function readSessionState() {
  try {
    const stored = await STORAGE_AREA.get(SESSION_KEY);
    const raw = stored?.[SESSION_KEY];
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return;
    }

    state.overrides = parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {};
    if (typeof parsed.search === "string") {
      els.searchInput.value = parsed.search;
    }
    if (typeof parsed.showSelectedOnly === "boolean") {
      state.showSelectedOnly = parsed.showSelectedOnly;
      els.selectedOnlyToggle.checked = parsed.showSelectedOnly;
    }
    if (typeof parsed.localEditMode === "boolean") {
      state.localEditMode = parsed.localEditMode;
      els.localModeToggle.checked = parsed.localEditMode;
    }

    if (parsed.filterStates && typeof parsed.filterStates === "object") {
      for (const key of FILTER_ORDER) {
        const value = parsed.filterStates[key];
        if (value === "off" || value === "include" || value === "exclude") {
          state.filterStates[key] = value;
        }
      }
    }

    if (Array.isArray(parsed.variables)) {
      state.variables = parsed.variables;
    }

    if (typeof parsed.pageKey === "string") {
      state.pageKey = parsed.pageKey;
    }
    if (Number.isFinite(parsed.corsSkippedSheets)) {
      state.corsSkippedSheets = parsed.corsSkippedSheets;
    }
  } catch (_error) {
    // Ignore malformed session values.
  }
}

async function writeSessionState() {
  const payload = {
    overrides: state.overrides,
    search: els.searchInput.value,
    showSelectedOnly: state.showSelectedOnly,
    localEditMode: state.localEditMode,
    filterStates: state.filterStates,
    variables: state.variables,
    pageKey: state.pageKey || "",
    corsSkippedSheets: state.corsSkippedSheets
  };

  try {
    await STORAGE_AREA.set({ [SESSION_KEY]: JSON.stringify(payload) });
  } catch (_error) {
    // Ignore quota/availability issues.
  }
}

function persistState() {
  void writeSessionState();
}

function applyFeatureFlagsToUI() {
  for (const button of els.filterButtons) {
    const key = button.dataset.filter;
    const enabled = FILTER_ORDER.includes(key);
    button.hidden = !enabled;
    button.style.display = enabled ? 'block' : 'none';

  }

  if (!FEATURES.selectedOnly) {
    els.selectedOnlyToggle.parentElement.style.display = 'none'
  }
  if (!FEATURES.localEditMode) {
    els.localModeToggle.parentElement.style.display = 'none'
  }

  if (els.selectedOnlyWrap) {
    els.localModeToggle.parentElement.style.display = 'none'
  }

}

function setError(message) {
  els.meta.textContent = message;
  els.varList.innerHTML = "";
}

function setLoading(loading) {
  state.loading = loading;
  els.refreshBtn.disabled = loading;
  els.refreshBtn.textContent = loading ? "Refreshing..." : "Refresh";
}

async function syncOverridesToInspectedPage() {
  const payload = JSON.stringify(state.overrides || {});

  await evalOnInspectedPage(`(() => {
    const STYLE_ID = ${JSON.stringify(STYLE_ID)};
    const ROOT_MARKER_ATTR = ${JSON.stringify(ROOT_MARKER_ATTR)};
    const overrides = ${payload};

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    } else if (style.parentElement && style.parentElement.lastElementChild !== style) {
      style.parentElement.appendChild(style);
    }

    const entries = Object.entries(overrides).filter(([name, value]) => {
      return name.startsWith("--") && typeof value === "string" && value.trim() !== "";
    });

    if (!entries.length) {
      document.documentElement.removeAttribute(ROOT_MARKER_ATTR);
      style.textContent = "";
      return true;
    }

    document.documentElement.setAttribute(ROOT_MARKER_ATTR, "1");
    const lines = entries.map(([name, value]) => "  " + name + ": " + value + " !important;").join("\\n");
    style.textContent = "html:root[" + ROOT_MARKER_ATTR + "=\\"1\\"] {\\n" + lines + "\\n}";
    return true;
  })()`);
}

function queueSyncOverrides(delay = 100) {
  return new Promise((resolve, reject) => {
    syncWaiters.push({ resolve, reject });
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
      const waiters = syncWaiters;
      syncWaiters = [];
      try {
        await syncOverridesToInspectedPage();
        for (const waiter of waiters) {
          waiter.resolve();
        }
      } catch (error) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
    }, delay);
  });
}

const optionStyle = new Option().style;

function getColor(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("#")) {
    if (trimmed.length === 4) {
      return (
        "#" +
        trimmed[1] +
        trimmed[1] +
        trimmed[2] +
        trimmed[2] +
        trimmed[3] +
        trimmed[3]
      ).toLowerCase();
    }
    if (trimmed.length === 7) {
      return trimmed.toLowerCase();
    }
    return null;
  }

  optionStyle.color = "";
  optionStyle.color = trimmed;
  const parsed = optionStyle.color;
  if (!parsed) {
    return null;
  }

  if (parsed.startsWith("rgb")) {
    const rgbaMatch = parsed.match(
      /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i
    );
    if (!rgbaMatch) {
      return null;
    }
    const alpha = rgbaMatch[4] === undefined ? 1 : Number(rgbaMatch[4]);
    if (!Number.isFinite(alpha) || alpha < 1) {
      return null;
    }
    const [r, g, b] = rgbaMatch.slice(1, 4).map((str) => Number(str));
    return (
      "#" +
      [r, g, b]
        .map((num) => Math.max(0, Math.min(255, num)).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  return parsed.startsWith("#") && parsed.length === 7 ? parsed.toLowerCase() : null;
}

function effectiveValue(item) {
  if (!state.localEditMode && Object.prototype.hasOwnProperty.call(state.overrides, item.name)) {
    return state.overrides[item.name];
  }
  if (state.localEditMode) {
    return item.selectedValue || item.value || "";
  }
  return state.showSelectedOnly ? item.selectedValue || "" : item.value || "";
}

function itemHasCategory(item, category) {
  if (category === "multiDeclared") {
    return Boolean(item.overridden);
  }
  if (category === "colors") {
    return Boolean(item.isColor || getColor(effectiveValue(item)));
  }
  return false;
}

function matchesFilters(item) {
  const includeCategories = FILTER_ORDER.filter((key) => state.filterStates[key] === "include");
  const excludeCategories = FILTER_ORDER.filter((key) => state.filterStates[key] === "exclude");

  if (includeCategories.length && !includeCategories.some((category) => itemHasCategory(item, category))) {
    return false;
  }

  if (excludeCategories.some((category) => itemHasCategory(item, category))) {
    return false;
  }

  return true;
}

function getFilteredRows() {
  const query = els.searchInput.value.trim().toLowerCase();
  const rows = [];

  for (const item of state.variables) {
    if (state.showSelectedOnly && !(item.selectedValue || item.selectedDeclaredValue)) {
      continue;
    }

    if (!matchesFilters(item)) {
      continue;
    }

    const value = effectiveValue(item);
    const key = item.name.toLowerCase();
    const normalizedValue = String(value || "").toLowerCase();
    const matchesSearch = !query || fuzzyMatch(key, query) || normalizedValue.includes(query);

    if (matchesSearch) {
      rows.push({
        name: item.name,
        value,
        selectedValue: item.selectedValue,
        selectedDeclaredValue: item.selectedDeclaredValue,
        overridden: item.overridden,
        isColor: item.isColor,
        sources: Array.isArray(item.sources) ? item.sources : []
      });
    }
  }

  return rows;
}

function setFilterButtonState(button, stateName) {
  button.classList.remove("state-off", "state-include", "state-exclude");
  button.classList.add(`state-${stateName}`);
}

function renderFilterButtons() {
  for (const button of els.filterButtons) {
    const key = button.dataset.filter;
    const mode = state.filterStates[key] || "off";
    setFilterButtonState(button, mode);
  }
}

async function refreshSelectionSnapshot() {
  const names = JSON.stringify(state.variables.map((item) => item.name));
  const result = await evalOnInspectedPage(`(() => {
    const names = ${names};
    const target = $0;
    if (!(target instanceof Element)) {
      return { selectionLabel: "No element selected", selectedValues: {}, selectedDeclaredValues: {} };
    }

    const selectedValues = {};
    const selectedDeclaredValues = {};
    const computed = getComputedStyle(target);

    const declaredMap = Object.create(null);
    for (let i = 0; i < target.style.length; i += 1) {
      const prop = target.style[i];
      if (prop && prop.startsWith("--")) {
        declaredMap[prop] = target.style.getPropertyValue(prop).trim();
      }
    }

    for (const name of names) {
      const computedValue = computed.getPropertyValue(name).trim();
      const declaredValue = declaredMap[name] || "";
      if (computedValue) {
        selectedValues[name] = computedValue;
      }
      if (declaredValue) {
        selectedDeclaredValues[name] = declaredValue;
      }
    }

    const tag = target.tagName.toLowerCase();
    const id = target.id ? "#" + target.id : "";
    const cls = target.classList.length ? "." + Array.from(target.classList).slice(0, 2).join(".") : "";

    return {
      selectionLabel: tag + id + cls,
      selectedValues,
      selectedDeclaredValues
    };
  })()`);

  const normalized = normalizeSelectionSnapshot(result);
  state.selectionLabel = normalized.selectionLabel;
  const selectedValues = normalized.selectedValues;
  const selectedDeclaredValues = normalized.selectedDeclaredValues;

  state.variables = state.variables.map((item) => ({
    ...item,
    selectedValue: selectedValues[item.name] || "",
    selectedDeclaredValue: selectedDeclaredValues[item.name] || ""
  }));

  persistState();
}

async function runDeepScan() {
  const result = await evalOnInspectedPage(`(() => {
    const pageKey = location.origin + location.pathname + location.search;
    const target = $0;
    let corsSkippedSheets = 0;

    const map = new Map();

    const touchVar = (name, rawValue, source) => {
      const current = map.get(name) || {
        name,
        declaredValue: "",
        declaredCount: 0,
        sources: []
      };

      current.declaredCount += 1;
      if (!current.declaredValue && rawValue) {
        current.declaredValue = rawValue;
      }

      if (source) {
        const key = (source.selector || "") + "@@" + (source.href || "") + "@@" + (source.ownerId || "");
        const exists = current.sources.some((entry) => {
          const entryKey =
            (entry.selector || "") + "@@" + (entry.href || "") + "@@" + (entry.ownerId || "");
          return entryKey === key;
        });

        if (!exists && current.sources.length < 20) {
          current.sources.push(source);
        }
      }

      map.set(name, current);
    };

    const visitRules = (sheetRules, sheet) => {
      for (const rule of Array.from(sheetRules || [])) {
        if (rule.style) {
          const selector = rule.selectorText || "";
          const source = {
            selector,
            href: sheet.href || "",
            ownerId: sheet.ownerNode && sheet.ownerNode.id ? sheet.ownerNode.id : ""
          };

          for (let i = 0; i < rule.style.length; i += 1) {
            const prop = rule.style[i];
            if (!prop || !prop.startsWith("--")) {
              continue;
            }
            const rawValue = rule.style.getPropertyValue(prop).trim();
            touchVar(prop, rawValue, source);
          }
        }

        if (rule.cssRules) {
          visitRules(rule.cssRules, sheet);
        }
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_error) {
        corsSkippedSheets += 1;
        continue;
      }
      visitRules(rules, sheet);
    }

    let selectedValues = {};
    let selectedDeclaredValues = {};
    let selectionLabel = "No element selected";

    if (target instanceof Element) {
      const names = Array.from(map.keys());
      const computed = getComputedStyle(target);
      const declaredMap = Object.create(null);

      for (let i = 0; i < target.style.length; i += 1) {
        const prop = target.style[i];
        if (prop && prop.startsWith("--")) {
          declaredMap[prop] = target.style.getPropertyValue(prop).trim();
        }
      }

      let matchedRules = [];
      if (typeof window.getMatchedCSSRules === "function") {
        try {
          matchedRules = Array.from(window.getMatchedCSSRules(target) || []);
        } catch (_error) {
          matchedRules = [];
        }
      }

      if (!matchedRules.length) {
        const fallback = [];
        const visit = (sheetRules) => {
          for (const rule of Array.from(sheetRules || [])) {
            if (rule.style && rule.selectorText) {
              try {
                if (target.matches(rule.selectorText)) {
                  fallback.push(rule);
                }
              } catch (_error) {
                // Ignore invalid selector.
              }
            }
            if (rule.cssRules) {
              visit(rule.cssRules);
            }
          }
        };

        for (const sheet of Array.from(document.styleSheets)) {
          let sheetRules;
          try {
            sheetRules = sheet.cssRules;
          } catch (_error) {
            continue;
          }
          visit(sheetRules);
        }

        matchedRules = fallback;
      }

      for (const rule of matchedRules) {
        if (!rule.style) {
          continue;
        }
        for (let i = 0; i < rule.style.length; i += 1) {
          const prop = rule.style[i];
          if (prop && prop.startsWith("--") && !declaredMap[prop]) {
            declaredMap[prop] = rule.style.getPropertyValue(prop).trim();
          }
        }
      }

      for (const name of names) {
        const computedValue = computed.getPropertyValue(name).trim();
        const declaredValue = declaredMap[name] || "";
        if (computedValue) {
          selectedValues[name] = computedValue;
        }
        if (declaredValue) {
          selectedDeclaredValues[name] = declaredValue;
        }
      }

      const tag = target.tagName.toLowerCase();
      const id = target.id ? "#" + target.id : "";
      const cls = target.classList.length ? "." + Array.from(target.classList).slice(0, 2).join(".") : "";
      selectionLabel = tag + id + cls;
    }

    const variables = Array.from(map.values()).map((item) => {
      const selectedValue = selectedValues[item.name] || "";
      const selectedDeclaredValue = selectedDeclaredValues[item.name] || "";
      const value = selectedValue || item.declaredValue || "";

      return {
        name: item.name,
        value,
        selectedValue,
        selectedDeclaredValue,
        declaredCount: item.declaredCount,
        overridden: item.declaredCount > 1,
        isColor: Boolean(value && CSS.supports("color", value)),
        sources: item.sources
      };
    });

    variables.sort((a, b) => a.name.localeCompare(b.name));

    return {
      pageKey,
      selectionLabel,
      variables,
      corsSkippedSheets
    };
  })()`);

  const normalized = normalizeDeepScan(result);
  state.variables = normalized.variables;
  state.selectionLabel = normalized.selectionLabel;
  state.pageKey = normalized.pageKey;
  state.corsSkippedSheets = normalized.corsSkippedSheets;
  persistState();
}

async function traceVarSource(varName) {
  const result = await evalOnInspectedPage(`(() => {
    const varName = ${JSON.stringify(varName)};

    const inspectEl = (el) => {
      if (!(el instanceof Element)) {
        return false;
      }
      try {
        inspect(el);
        el.scrollIntoView({ block: "center", inline: "nearest" });
        return true;
      } catch (_error) {
        return false;
      }
    };

    const target = $0;
    if (!(target instanceof Element)) {
      return "Trace unavailable: no element selected";
    }

    let child = target;
    let childValue = getComputedStyle(child).getPropertyValue(varName).trim();

    while (child.parentElement) {
      const parent = child.parentElement;
      const parentValue = getComputedStyle(parent).getPropertyValue(varName).trim();
      if (childValue !== parentValue) {
        if (inspectEl(child)) {
          return "Traced to inheritance boundary";
        }
        break;
      }
      child = parent;
      childValue = parentValue;
    }

    if (inspectEl(target)) {
      return "Trace stayed on selected element";
    }
    return "Trace source not found";
  })()`);

  return typeof result === "string" ? result : "Trace source not found";
}

async function applyLocalEdit(name, value) {
  const result = await evalOnInspectedPage(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const target = $0;
    if (!(target instanceof Element)) {
      return "Local edit unavailable: no element selected";
    }
    if (value && value.trim()) {
      target.style.setProperty(name, value.trim());
    } else {
      target.style.removeProperty(name);
    }
    return "ok";
  })()`);

  if (result !== "ok") {
    throw new Error(typeof result === "string" ? result : "Local edit failed");
  }
}

async function refreshScan({ deep, showLoading }) {
  try {
    if (showLoading) {
      setLoading(true);
    }

    if (deep) {
      await runDeepScan();
    } else {
      await refreshSelectionSnapshot();
    }

    await syncOverridesToInspectedPage();
    renderVarList();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    if (showLoading) {
      setLoading(false);
    }
  }
}

function renderVarList() {
  const rows = getFilteredRows();
  els.varList.innerHTML = "";

  const templateCopy = els.rowTemplate.content.firstElementChild.cloneNode(true);

  for (const row of rows) {
    const node = templateCopy.cloneNode(true);
    const nameEl = node.querySelector(".name");
    const colorInput = node.querySelector(".color");
    const textInput = node.querySelector(".text");
    const traceBtn = node.querySelector(".trace");
    const revertBtn = node.querySelector(".revert");

    nameEl.textContent = row.name;
    textInput.value = row.value;
    textInput.title = row.selectedDeclaredValue ? "Declared on selected element" : "Inherited/Computed";

    const color = getColor(row.value);
    if (color) {
      colorInput.classList.remove("hidden");
      colorInput.value = color;
      colorInput.addEventListener("input", async (event) => {
        const next = event.target.value;
        textInput.value = next;
        try {
          if (state.localEditMode) {
            await applyLocalEdit(row.name, next);
            await refreshSelectionSnapshot();
            renderVarList();
          } else {
            state.overrides[row.name] = next;
            persistState();
            await queueSyncOverrides(90);
          }
        } catch (error) {
          setError(error?.message || String(error));
        }
      });
    } else {
      colorInput.classList.add("hidden");
    }

    let applyTimer = null;
    const applyCurrentInput = async (rerender) => {
      const next = textInput.value.trim();
      try {
        if (state.localEditMode) {
          await applyLocalEdit(row.name, next);
          if (rerender) {
            await refreshSelectionSnapshot();
          }
        } else {
          if (!next) {
            delete state.overrides[row.name];
          } else {
            state.overrides[row.name] = next;
          }
          persistState();
          await queueSyncOverrides(90);
        }
        if (rerender) {
          renderVarList();
        }
      } catch (error) {
        setError(error?.message || String(error));
      }
    };

    textInput.addEventListener("input", () => {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(() => {
        applyCurrentInput(false);
      }, 120);
    });

    textInput.addEventListener("change", () => applyCurrentInput(true));

    if (!FEATURES.traceSource) {
      traceBtn.style.display = 'none';
    } else {
      traceBtn.addEventListener("click", async () => {
        try {
          const message = await traceVarSource(row.name);
          els.meta.textContent = message;
        } catch (error) {
          setError(error?.message || String(error));
        }
      });
    }

    revertBtn.addEventListener("click", async () => {
      try {
        if (state.localEditMode) {
          await applyLocalEdit(row.name, "");
          await refreshSelectionSnapshot();
        } else {
          delete state.overrides[row.name];
          persistState();
          await syncOverridesToInspectedPage();
        }
        renderVarList();
      } catch (error) {
        setError(error?.message || String(error));
      }
    });

    els.varList.appendChild(node);
  }

  updateMeta(rows.length);
}

function updateMeta(visibleCount) {
  const total = state.variables.length;
  let message = `${state.selectionLabel} • ${visibleCount}/${total} vars`;
  if (state.corsSkippedSheets > 0) {
    message += ` • ⚠ Partial coverage (CORS restricted sheets skipped: ${state.corsSkippedSheets})`;
  }
  els.meta.textContent = message;
}

function cycleFilterState(key) {
  const current = state.filterStates[key] || "off";
  state.filterStates[key] = FILTER_CYCLE[current];
  persistState();
  renderFilterButtons();
  renderVarList();
}

function copyWithExecCommand(payload) {
  const area = document.createElement("textarea");
  area.value = payload;
  area.setAttribute("readonly", "readonly");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

async function copyVisibleVars() {
  const rows = getFilteredRows();
  const object = {};
  for (const row of rows) {
    object[row.name] = row.value;
  }

  const payload = JSON.stringify(object, null, 2);
  const ok = copyWithExecCommand(payload);
  els.meta.textContent = ok ? `Copied ${rows.length} vars` : "Copy failed";
}

function scheduleSelectionRefresh() {
  state.refreshQueued = true;
  if (state.refreshTimer) {
    return;
  }

  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    if (!state.refreshQueued) {
      return;
    }

    state.refreshQueued = false;
    await refreshScan({ deep: false, showLoading: false });
  }, 120);
}

async function resetLocalEdits() {
  const names = JSON.stringify(state.variables.map((item) => item.name));
  const result = await evalOnInspectedPage(`(() => {
    const names = ${names};
    const target = $0;
    if (!(target instanceof Element)) {
      return "Local reset unavailable: no element selected";
    }
    for (const name of names) {
      target.style.removeProperty(name);
    }
    return "ok";
  })()`);
  if (result !== "ok") {
    throw new Error(typeof result === "string" ? result : "Local reset failed");
  }
}

function bindEvents() {
  els.searchInput.addEventListener("input", () => {
    persistState();
    renderVarList();
  });

  els.refreshBtn.addEventListener("click", async () => {
    await refreshScan({ deep: true, showLoading: true });
  });

  els.resetBtn.addEventListener("click", async () => {
    try {
      if (state.localEditMode) {
        await resetLocalEdits();
        await refreshSelectionSnapshot();
      } else {
        state.overrides = {};
        persistState();
        await syncOverridesToInspectedPage();
      }
      renderVarList();
    } catch (error) {
      setError(error?.message || String(error));
    }
  });

  els.copyBtn.addEventListener("click", async () => {
    await copyVisibleVars();
  });

  els.selectedOnlyToggle.addEventListener("change", () => {
    state.showSelectedOnly = els.selectedOnlyToggle.checked;
    persistState();
    renderVarList();
  });

  els.localModeToggle.addEventListener("change", () => {
    state.localEditMode = els.localModeToggle.checked;
    persistState();
    renderVarList();
  });

  for (const button of els.filterButtons) {
    button.addEventListener("click", () => {
      const key = button.dataset.filter;
      cycleFilterState(key);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.tabId !== tabId) {
      return;
    }

    switch (message.type) {
      case "SIDEBAR_SELECTION_CHANGED":
        scheduleSelectionRefresh();
        break;
      case "THEME_CHANGED":
        applyTheme(message.theme);
        break;
      default:
        break;
    }
  });
}

async function ensureFreshData() {
  const currentPageKey = await evalOnInspectedPage("location.origin + location.pathname + location.search");
  if (!state.variables.length || !state.pageKey || state.pageKey !== currentPageKey) {
    await refreshScan({ deep: true, showLoading: true });
    return;
  }

  await refreshScan({ deep: false, showLoading: false });
}

async function init() {
  applyTheme();
  bindEvents();

  if (!Number.isInteger(tabId)) {
    setError("Missing tab id");
    return;
  }

  await readSessionState();
  applyFeatureFlagsToUI();
  persistState();
  renderFilterButtons();
  await syncOverridesToInspectedPage();
  await ensureFreshData();
}

init();
