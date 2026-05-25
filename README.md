# Equipment Property Generator

A desktop tool for Ragnarok Online private-server developers. It converts
**rAthena `item_db` YAML** (or **Hercules `item_db` CONF**) bonus scripts into the
FreyjaRO / ROenglishRE **`EquipmentProperties.lub`** format, and writes them straight
into your source `.lub` so equipment bonuses render in the in-game item tooltip.

It also ships with in-app editors for custom bonus translations and for the tooltip
labels themselves.

- **Developed by** Gerzzie
- **Platform** Windows (built on [Neutralino.js](https://neutralino.js.org/) 6.7.0)

---

## What it does

For every item in your `item_db`, the generator translates the bonus `Script` into the
text the client shows on the equipment tooltip, then applies it to your
`EquipmentProperties.lub`:

- **Brand-new item IDs** are inserted as a full entry.
- **Existing item IDs** keep their `Stat` / `Type` / `Combiitem` blocks untouched — only
  the `OnStartEquip` description is regenerated.

A `.bak` backup of the source `.lub` is created automatically before anything is written.

---

## Getting started

1. **Launch** `Equipment Property Generator.exe`.
2. **Pick your format** with the toggle next to the big button:
   - **rAthena** → expects `item_db` **YAML** files
   - **Hercules** → expects `item_db` **CONF** files
3. **Set the Source `.lub`** — browse to your
   `…\luafiles514\lua files\EquipmentProperties\EquipmentProperties.lub`.
   (If you accidentally pick a sibling preset/order `.lub` with no Item table, the app
   detects it and switches to the correct sibling automatically.)
4. **Add your Input DB(s)** — click **+ Add DB** and browse to each `item_db` file.
5. *(Optional)* **Add Item Combos** — click **+ Add Combo** for set-bonus files.
6. Click **Apply to Source**, confirm the write prompt, and watch the **Log** for results.
7. **Restart your game client** to see the updated tooltips.

---

## The form

### Source `.lub`
The `EquipmentProperties.lub` that gets written to. This is the only file the tool
modifies (plus a `.bak` backup, and `EquipmentPropertiesOrder.lub` next to it when custom
bonuses require it).

### Input YAMLs / CONFs (priority list)
One or more `item_db` files, stacked **top = highest priority**. When the same item ID
appears in more than one DB, the **higher entry wins** and lower ones are ignored for that
ID. Use the list controls to add, remove, and reorder files.

### Item Combos (optional)
Set-bonus files. Unlike the DB list, **all combo files are merged** — order doesn't
matter, and an item appearing in several sets receives all of its set IDs.

### Apply to Source
Runs the conversion and writes to the source `.lub`. The button is disabled while a run is
in progress; progress and per-DB merge counts are reported in the Log.

---

## Menus

### File
| Item | Description |
|------|-------------|
| **New Session** | Clear all inputs and start fresh. |
| **Save Session…** | Save the current source/DBs/combos/format to a `.json` file. |
| **Load Session…** | Restore inputs from a saved session file. |
| **Open Source Folder** | Open the folder containing the source `.lub` in Explorer. |
| **Clear Log** | Empty the log panel. |
| **About** | Version and credits. |

> Inputs are also **autosaved** to the app between launches, so you rarely need to re-pick
> paths.

### Edit
| Item | Description |
|------|-------------|
| **Custom Bonuses** | Define translation rules for bonuses not in the built-in table. |
| **Edit Labels** | Edit the tooltip labels stored in `EquipmentPropertiesOrder.lub`. |

---

## Custom Bonuses

Use this when an `item_db` script uses a bonus the built-in table doesn't recognize.
Define a rule with placeholders `{arg1}`, `{arg2}`, …:

| Field | Example |
|-------|---------|
| **Name** | `bIncreasePogi` |
| **Args** | `1` |
| **Lua** | `IncreasePogi({arg1})` |
| **Description** | `Increase Pogi {arg1}%` |

On **Apply**, any rule whose Lua is a single call carrying `{arg1}` also gets a matching
entry written to `EquipmentPropertiesOrder.lub` (with a no-op stub), so the registered
value actually renders in the tooltip. The **Description** becomes the label —
`{arg1}` displays as the signed value and keeps a trailing `%`.

---

## Edit Labels

Opens the labels stored in `EquipmentPropertiesOrder.lub` (located next to your source
`.lub`). Filter/search the list, edit the text, and **Save** to write the changes back.
**Restart the client** to see them in-game.

---

## Bonus templates

How each standard bonus is phrased lives in **`bonus_templates.yml`**. Edit the right-hand
strings to change the wording shown in tooltips. Placeholders (case-sensitive):

| Token | Meaning |
|-------|---------|
| `V`   | flat numeric value (e.g. `5`, `-3`) |
| `PCT` | value as a percent (e.g. `10%`) |
| `ARG` | resolved argument (race, element, class, size, skill name…) |
| `EFF` | status-effect name (auto-colored brown) |
| `DUR` | duration in seconds (autobonus only) |

Lines starting with `#` are comments. The app reloads the file automatically after a save.

---

## Building from source (developers)

The `.exe` is the Neutralino runtime; the app's HTML/CSS/JS lives in `resources.neu`. Two
Node.js scripts (no dependencies, Node 14+) round-trip that bundle:

```sh
# Unpack resources.neu  →  extracted/
node extract_neu.js

# ...edit files under extracted/resources/ (index.html, styles.css, js/app.js, …)

# Repack extracted/  →  resources.neu
node pack_neu.js
```

Then relaunch `Equipment Property Generator.exe` to load the rebuilt bundle.

### Source layout (inside `extracted/`)

```
extracted/
  neutralino.config.json
  resources/
    index.html          UI markup
    styles.css          styling
    js/app.js           all app logic (parsing, translation, writing)
    js/js-yaml.min.js   YAML parser
    js/neutralino.js    Neutralino client library
    resources/          bundled templates (bonus_templates.yml, *.template.lub)
    icons/              app icons
```

> `resources_original.neu` is the untouched stock bundle kept as a reference; `resources.neu`
> is the one the app actually loads.

---

## Notes

- Always **restart the game client** after applying — the `.lub` is read at client startup.
- A `.bak` of the source `.lub` is created on every Apply; restore from it if needed.
- This tool edits client-side tooltips only. **Actual gameplay effects come from the server
  reading `item_db`**, not from the `.lub`.
