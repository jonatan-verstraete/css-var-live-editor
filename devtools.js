const tabId = chrome.devtools.inspectedWindow.tabId;

chrome.devtools.panels.elements.createSidebarPane("DoubleDash Editor", (sidebar) => {
  sidebar.setPage(`sidebar.html?tabId=${tabId}`);

  // no chrome support. But I'm hopeful!
  chrome.devtools?.panels?.onThemeChanged?.addListener((theme) => {
    chrome.runtime.sendMessage({ type: "THEME_CHANGED", theme, tabId });
  });
});

chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  chrome.runtime
    .sendMessage({
      type: "SIDEBAR_SELECTION_CHANGED",
      tabId
    })
    .catch(() => {
      // Sidebar page may not be loaded yet.
    });
});
