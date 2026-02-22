# DoubleDash Editor

DoubleDash Editor is a DevTools Elements sidebar for fast CSS variable inspection and editing.

## Core Workflow
- Open **Elements** in Chrome DevTools.
- Open the **DoubleDash Editor** sidebar pane.
- Search variables by name (fuzzy) or value (substring).
- Edit values inline or with the color picker.
- Choose edit scope:
  - **Global** (default): override on `:root`.
  - **Apply to element only**: writes directly to selected element inline style.
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
- `Multi-Declared`: variables declared in multiple places.
- `Colors`: variables with color-like values.

## Declared vs Inherited
For the selected element, DoubleDash checks:
- inline declarations (`element.style`)
- computed values (`getComputedStyle($0)`) for discovered variables

Deep refreshes also inspect matched rules for richer declaration context.

## Trace Source
- Click `📍` (`Trace`) on a variable row to walk inheritance from the selected node upward.
- The tool highlights the element where the computed value boundary changes.

## Notes
- Overrides are applied via an injected high-priority style block.
- Sidebar state is cached in `chrome.storage.session` per tab for responsiveness.
- Selection-change refresh uses a lightweight computed-value pass.
