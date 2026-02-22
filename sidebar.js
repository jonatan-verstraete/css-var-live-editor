const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));

const STYLE_ID = "doubledash-editor-overrides";
const ROOT_MARKER_ATTR = "data-doubledash-editor";
const SESSION_KEY = `doubledash:state:${tabId}`;

const FILTER_ORDER = ["local", "external", "extension", "unused"];
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
    local: "off",
    external: "off",
    extension: "off",
    unused: "off"
  },
  showSelectedOnly: false,
  refreshQueued: false,
  refreshTimer: null,
  loading: false
};

const els = {
  searchInput: document.getElementById("searchInput"),
  copyBtn: document.getElementById("copyBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  resetBtn: document.getElementById("resetBtn"),
  selectedOnlyToggle: document.getElementById("selectedOnlyToggle"),
  filterButtons: Array.from(document.querySelectorAll(".filter-btn")),
  meta: document.getElementById("meta"),
  varList: document.getElementById("varList"),
  rowTemplate: document.getElementById("rowTemplate")
};

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
      pageKey: ""
    };
  }

  return {
    variables: Array.isArray(result.variables) ? result.variables : [],
    selectionLabel: typeof result.selectionLabel === "string" ? result.selectionLabel : "No element selected",
    pageKey: typeof result.pageKey === "string" ? result.pageKey : ""
  };
}

function normalizeSelectionSnapshot(result) {
  if (!result || typeof result !== "object") {
    return {
      selectionLabel: "No element selected",
      selectedValues: {}
    };
  }

  return {
    selectionLabel: typeof result.selectionLabel === "string" ? result.selectionLabel : "No element selected",
    selectedValues:
      result.selectedValues && typeof result.selectedValues === "object" ? result.selectedValues : {}
  };
}

function readSessionState() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
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
  } catch (_error) {
    // Ignore malformed session values.
  }
}

function writeSessionState() {
  const payload = {
    overrides: state.overrides,
    search: els.searchInput.value,
    showSelectedOnly: state.showSelectedOnly,
    filterStates: state.filterStates,
    variables: state.variables,
    pageKey: state.pageKey || ""
  };

  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch (_error) {
    // Ignore quota/availability issues.
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

function effectiveValue(item) {
  if (Object.prototype.hasOwnProperty.call(state.overrides, item.name)) {
    return state.overrides[item.name];
  }
  return state.showSelectedOnly ? item.selectedValue || "" : item.value || "";
}

function itemHasCategory(item, category) {
  if (category === "unused") {
    return Boolean(item.unused);
  }
  return Boolean(item.categories?.[category]);
}

function matchesDomainFilters(item) {
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
    if (state.showSelectedOnly && !item.selectedValue) {
      continue;
    }

    if (!matchesDomainFilters(item)) {
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
        originalValue: item.value,
        selectedValue: item.selectedValue,
        categories: item.categories,
        unused: item.unused
      });
    }
  }

  return rows;
}

const optionStyle = new Option().style;
function getColor(value) {
  if (typeof value !== "string") return false;
  optionStyle.color = "";
  optionStyle.color = value;
  // needs to be hex for input to accept it as valid color?
  return optionStyle.color || null
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
      return { selectionLabel: "No element selected", selectedValues: {} };
    }

    const computed = getComputedStyle(target);
    const selectedValues = {};
    for (const name of names) {
      const value = computed.getPropertyValue(name).trim();
      if (value) {
        selectedValues[name] = value;
      }
    }

    const tag = target.tagName.toLowerCase();
    const id = target.id ? "#" + target.id : "";
    const cls = target.classList.length ? "." + Array.from(target.classList).slice(0, 2).join(".") : "";

    return {
      selectionLabel: tag + id + cls,
      selectedValues
    };
  })()`);

  const normalized = normalizeSelectionSnapshot(result);
  state.selectionLabel = normalized.selectionLabel;

  const selectedValues = normalized.selectedValues;
  state.variables = state.variables.map((item) => ({
    ...item,
    selectedValue: selectedValues[item.name] || ""
  }));

  writeSessionState();
}

async function runDeepScan() {
  const result = await evalOnInspectedPage(`(() => {
    const hostname = location.hostname;
    const pageKey = location.origin + location.pathname;

    const bodyComputed = getComputedStyle(document.body || document.documentElement);
    const bodyNames = new Set();
    for (let i = 0; i < bodyComputed.length; i += 1) {
      const prop = bodyComputed[i];
      if (prop && prop.startsWith("--")) {
        bodyNames.add(prop);
      }
    }

    const target = $0;
    const selectedComputed = target instanceof Element ? getComputedStyle(target) : null;

    const map = new Map();

    const classifySheet = (sheet) => {
      const href = sheet.href || "";
      const ownerId = sheet.ownerNode && sheet.ownerNode.id ? sheet.ownerNode.id : "";
      const isExtension = Boolean(ownerId) || href.startsWith("chrome-extension://");

      let isLocal = false;
      let isExternal = false;

      if (!isExtension) {
        if (!href) {
          isLocal = true;
        } else {
          try {
            const host = new URL(href).hostname;
            isLocal = host === hostname;
            isExternal = host !== hostname;
          } catch (_error) {
            isExternal = true;
          }
        }
      }

      return { isLocal, isExternal, isExtension };
    };

    const touchVar = (name, rawValue, categories) => {
      const current = map.get(name) || {
        name,
        declaredValue: "",
        categories: { local: false, external: false, extension: false }
      };

      if (!current.declaredValue && rawValue) {
        current.declaredValue = rawValue;
      }

      current.categories.local = current.categories.local || categories.isLocal;
      current.categories.external = current.categories.external || categories.isExternal;
      current.categories.extension = current.categories.extension || categories.isExtension;
      map.set(name, current);
    };

    const visitRules = (rules, categories) => {
      for (const rule of Array.from(rules || [])) {
        if (rule.style) {
          for (let i = 0; i < rule.style.length; i += 1) {
            const prop = rule.style[i];
            if (!prop || !prop.startsWith("--")) {
              continue;
            }
            const rawValue = rule.style.getPropertyValue(prop).trim();
            touchVar(prop, rawValue, categories);
          }
        }

        if (rule.cssRules) {
          visitRules(rule.cssRules, categories);
        }
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_error) {
        continue;
      }

      const categories = classifySheet(sheet);
      visitRules(rules, categories);
    }

    const variables = Array.from(map.values()).map((item) => {
      const bodyValue = bodyComputed.getPropertyValue(item.name).trim();
      const selectedValue = selectedComputed ? selectedComputed.getPropertyValue(item.name).trim() : "";
      return {
        name: item.name,
        value: bodyValue || item.declaredValue || "",
        selectedValue,
        categories: item.categories,
        unused: !bodyNames.has(item.name)
      };
    });

    variables.sort((a, b) => a.name.localeCompare(b.name));

    const selectionLabel = target instanceof Element
      ? (() => {
          const tag = target.tagName.toLowerCase();
          const id = target.id ? "#" + target.id : "";
          const cls = target.classList.length ? "." + Array.from(target.classList).slice(0, 2).join(".") : "";
          return tag + id + cls;
        })()
      : "No element selected";

    return {
      pageKey,
      selectionLabel,
      variables
    };
  })()`);

  const normalized = normalizeDeepScan(result);
  state.variables = normalized.variables;
  state.selectionLabel = normalized.selectionLabel;
  state.pageKey = normalized.pageKey;
  writeSessionState();
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

  for (const row of rows) {
    const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
    const nameEl = node.querySelector(".name");
    const colorInput = node.querySelector(".color");
    const textInput = node.querySelector(".text");
    const revertBtn = node.querySelector(".revert");

    nameEl.textContent = row.name;
    textInput.value = row.value;

    const color = getColor(row.value)

    if (color) {
      colorInput.classList.remove("hidden");
      colorInput.value = color;
      colorInput.addEventListener("input", async (event) => {
        const next = event.target.value;
        textInput.value = next;
        state.overrides[row.name] = next;
        writeSessionState();
        try {
          await syncOverridesToInspectedPage();
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
      if (!next) {
        delete state.overrides[row.name];
      } else {
        state.overrides[row.name] = next;
      }

      writeSessionState();

      try {
        await syncOverridesToInspectedPage();
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

    revertBtn.addEventListener("click", async () => {
      delete state.overrides[row.name];
      writeSessionState();
      try {
        await syncOverridesToInspectedPage();
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
  els.meta.textContent = `${state.selectionLabel} • ${visibleCount}/${total} vars`;
}

function cycleFilterState(key) {
  const current = state.filterStates[key] || "off";
  state.filterStates[key] = FILTER_CYCLE[current];
  writeSessionState();
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

function bindEvents() {
  els.searchInput.addEventListener("input", () => {
    writeSessionState();
    renderVarList();
  });

  els.refreshBtn.addEventListener("click", async () => {
    await refreshScan({ deep: true, showLoading: true });
  });

  els.resetBtn.addEventListener("click", async () => {
    state.overrides = {};
    writeSessionState();
    try {
      await syncOverridesToInspectedPage();
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
    writeSessionState();
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
  const currentPageKey = await evalOnInspectedPage("location.origin + location.pathname");
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

  readSessionState();
  renderFilterButtons();
  await syncOverridesToInspectedPage();
  await ensureFreshData();
}

init();
