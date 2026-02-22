# DoubleDash Editor

DoubleDash Editor is a DevTools Elements sidebar for fast CSS variable inspection and editing.

## Core Workflow
- Open **Elements** in Chrome DevTools.
- Open the **DoubleDash Editor** sidebar pane.
- Search variables by name (fuzzy) or value (substring).
- Edit values inline or with the color picker.
- Use `Copy` to export the currently visible variable set as JSON.

## Variable Modes
- Default list shows all variables discovered from stylesheets (stable across element selection).
- `Selected only` limits the list to variables resolved on the currently selected element.

## Filters (3-State)
Each filter cycles through:
- `off`: no effect
- `include`: only show items in this category
- `exclude`: hide items in this category

Available filters:
- `Overridden`: variables declared in multiple places.
- `Colors`: variables with color-like values.
- `Unused`: variables declared in stylesheets but not present in `getComputedStyle(document.body)`.

## Declared vs Inherited
For the selected element, DoubleDash checks:
- inline declarations (`element.style`)
- matched CSS rules (`window.getMatchedCSSRules($0)` when available, with fallback matching)

This is used to distinguish variables declared on/matched to the selected element from inherited/computed values.

## Locate Source
- Click `📍` on a variable row to jump DevTools selection to a likely declaration source.
- The tool tries selected-element inline style first, then matched rules, then discovered stylesheet selectors.

## Notes
- Overrides are applied via an injected high-priority style block.
- Sidebar state is cached per tab session for responsiveness.
