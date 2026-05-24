// ItemEquipGen - main app logic
// Converts rAthena item_db YAML entries into EquipmentProperties.lub
// format and applies them directly to the source .lub:
//   * Brand-new item IDs are inserted as a full entry.
//   * Existing item IDs keep their Stat/Type/Combiitem; only the
//     OnStartEquip "description" block is updated.

Neutralino.init();

// ----- Defaults -----
const DEFAULT_SOURCE_LUB =
  "C:\\Users\\gerzz\\Downloads\\1\\FreyjaRO\\data\\luafiles514\\lua files\\EquipmentProperties\\EquipmentProperties.lub";

// ----- DOM handles -----
const $src = document.getElementById("src");
const $combo = document.getElementById("combo");
const $log = document.getElementById("log");
const $status = document.getElementById("status");
const $statusbar = document.querySelector(".statusbar");
const $runBtn = document.getElementById("run");

$src.value = DEFAULT_SOURCE_LUB;

// ----- Item DB priority list state -----
// `ITEM_DBS` is an array of file path strings, top-to-bottom = highest
// priority first. Persisted to localStorage under "item_dbs". When two
// DBs contain the same item ID, only the higher-priority entry's bonuses
// are written to the .lub.
let ITEM_DBS = [""];
try {
  const saved = JSON.parse(localStorage.getItem("item_dbs") || "null");
  if (Array.isArray(saved) && saved.length) {
    ITEM_DBS = saved.map(x => typeof x === "string" ? x : "");
  }
} catch {}

function saveItemDbs() {
  try { localStorage.setItem("item_dbs", JSON.stringify(ITEM_DBS)); } catch {}
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  $log.textContent += `[${ts}] ${msg}\n`;
  $log.scrollTop = $log.scrollHeight;
}
function setStatus(text, working = false) {
  $status.textContent = text;
  $statusbar.classList.toggle("working", working);
}

// ----- Toast notifications -----
function toast(message, type = "info", durationMs = 2600) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.textContent = message;
  container.appendChild(el);
  // trigger enter transition on next frame
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
  }, durationMs);
}

// ----- Format mode (rAthena / Hercules) -----
let FORMAT_MODE = "rathena"; // "rathena" | "hercules"
try {
  const saved = localStorage.getItem("format_mode");
  if (saved === "rathena" || saved === "hercules") FORMAT_MODE = saved;
} catch {}

function setFormatMode(mode, notify = true) {
  if (mode !== "rathena" && mode !== "hercules") return;
  FORMAT_MODE = mode;
  try { localStorage.setItem("format_mode", mode); } catch {}
  // Swap the button color theme — blue for rAthena, amber for Hercules.
  // The CSS variables under body[data-format="hercules"] override the defaults.
  if (document.body) document.body.setAttribute("data-format", mode);
  const toggle = document.getElementById("format-toggle");
  if (toggle) toggle.setAttribute("data-mode", mode);
  const lbl = document.getElementById("yml-label");
  if (lbl) lbl.textContent = mode === "hercules" ? "Input CONFs" : "Input YAMLs";
  const comboLbl = document.getElementById("combo-label");
  if (comboLbl) comboLbl.textContent = mode === "hercules" ? "Item Combo CONF" : "Item Combo YAML";
  if (notify) {
    toast(mode === "hercules"
      ? "Successfully switched to Hercules"
      : "Successfully switched to rAthena",
      "success");
  }
}

// ----- Session (src + combo + DB list + format mode) -----
// A "session" snapshots every input on the form so paths don't need to be
// re-picked on each launch. The current session is autosaved to
// localStorage on every relevant change; users can also explicitly Save /
// Load named sessions to JSON files via the File menu.
const SESSION_KEY = "last_session";

function getSession() {
  return {
    src: $src.value,
    combo: $combo.value,
    item_dbs: ITEM_DBS.slice(),
    format_mode: FORMAT_MODE,
  };
}

function autosaveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(getSession())); } catch {}
}

function applySession(s) {
  if (!s || typeof s !== "object") return;
  if (typeof s.src === "string")   $src.value   = s.src;
  if (typeof s.combo === "string") $combo.value = s.combo;
  if (Array.isArray(s.item_dbs)) {
    ITEM_DBS = s.item_dbs.map(x => typeof x === "string" ? x : "");
    if (!ITEM_DBS.length) ITEM_DBS = [""];
    saveItemDbs();
    renderDbList();
  }
  if (s.format_mode === "rathena" || s.format_mode === "hercules") {
    setFormatMode(s.format_mode, false);
  }
  autosaveSession();
}

// Restore src/combo from the last session on launch. ITEM_DBS / FORMAT_MODE
// are already restored above from their own localStorage keys, so we only
// override the two text inputs that don't otherwise persist.
try {
  const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  if (saved && typeof saved === "object") {
    if (typeof saved.src === "string"   && saved.src)   $src.value   = saved.src;
    if (typeof saved.combo === "string" && saved.combo) $combo.value = saved.combo;
  }
} catch {}

// Bump autosave whenever src / combo are edited so the next launch reflects
// the latest paths even if the user never explicitly saves.
$src.addEventListener("input",   autosaveSession);
$combo.addEventListener("input", autosaveSession);

// ============================================================================
// Bonus translation
// ============================================================================

const TYPE_MAP = {
  Armor: "armor",
  // Weapon → Mweapon by default; the bare "weapon" string is not a valid kRO
  // tooltip Type and triggers "Item[N] has invalid 'Stat' table(count: 0)".
  // For items where a SubType indicates a ranged class (Bow / Musical /
  // Whip / Revolver / etc.) `resolveLubType()` upgrades this to "Rweapon".
  Weapon: "Mweapon",
  Ammo: "ammo",
  Card: "card",
};

// rAthena SubTypes that mean "ranged" → emit Rweapon (15-entry Stat).
const RANGED_SUBTYPES = new Set([
  "W_BOW", "W_MUSICAL", "W_WHIP", "W_REVOLVER", "W_RIFLE", "W_GATLING",
  "W_SHOTGUN", "W_GRENADE",
  // Lowercased forms commonly seen in YAML:
  "bow", "musical", "whip", "revolver", "rifle", "gatling", "shotgun", "grenade",
]);

// Resolve a rAthena/Hercules item's effective lub Type. For Weapon items,
// classify melee vs ranged using SubType when available, falling back to
// numeric Aegis-ID ranges so legacy items without SubType still land in the
// right bucket. Anything else uses TYPE_MAP straight.
function resolveLubType(item) {
  const rtype = item.Type || "Armor";
  const base = TYPE_MAP[rtype] || "armor";
  if (rtype !== "Weapon") return base;
  const sub = String(item.Subtype || item.SubType || "").trim();
  if (RANGED_SUBTYPES.has(sub)) return "Rweapon";
  // Fall back to Aegis-ID range classification when SubType is missing.
  const id = parseInt(item.Id, 10);
  if (Number.isFinite(id)) {
    if ((id >= 1700 && id <= 1799) ||   // Bow
        (id >= 1900 && id <= 2099) ||   // Musical / Whip
        (id >= 2300 && id <= 2399) ||   // Revolver
        (id >= 13400 && id <= 13999) || // Revolver extended
        (id >= 18000 && id <= 18999)) { // Bow extended
      return "Rweapon";
    }
  }
  return "Mweapon";
}

// -----------------------------------------------------------------------------
// rAthena bonus name -> literal ExtParam integer ID.
//
// The client's equipment tooltip scanner only recognises LITERAL integer
// arguments to AddExtParam(0, <int>, <int>). It does NOT evaluate runtime
// lookups like EnumVAR.VAR_STRAMOUNT[2], so those bonuses load cleanly but
// do not appear in the item tooltip.
//
// This table was built by cross-referencing the existing 5.9 MB
// EquipmentProperties.lub with rAthena item_db yamls: for each item whose
// yaml has a `bonus bX,<n>;` and whose compiled entry has a matching
// `AddExtParam(0, <id>, <n>)`, we vote for (bX -> id). Entries with >5
// votes are authoritative.
// -----------------------------------------------------------------------------
const EXTPARAM_LITERAL = {
  // Main stats (103-108)
  bstr: 103, bagi: 104, bvit: 105, bint: 106, bdex: 107, bluk: 108,
  // HP / SP
  bmaxhp: 109, bmaxsp: 110, bmaxhprate: 111, bmaxsprate: 112,
  bhprecovrate: 113, bsprecovrate: 114,
  // Physical / defensive flats
  bbaseatk: 41, batk: 41, batk2: 41,
  bdef: 45, bdef2: 45, bdefrate: 45, bdef2rate: 45,
  bmdef: 47, bmdef2: 47, bmdefrate: 47, bmdef2rate: 47,
  bhit: 49, bhitrate: 49,
  bflee: 50, bfleerate: 50,
  // ExtParam 51 = Perfect Dodge (bFlee2). kRO scales by 10: each script-unit
  // of Perfect Dodge corresponds to 10 client-units, so emit V*10 elsewhere.
  bflee2: 51, bflee2rate: 51,
  // ExtParam 52 = Critical chance (bcritical). Not 51 — that's Perfect Dodge.
  bcritical: 52, bcriticalrate: 52,
  baspd: 54,
  // Attack / matk rate / flat matk / aspd rate
  bmatkrate: 140,
  baspdrate: 167,
  bmatk: 200,
  batkrate: 207,
  // Trait stats (234-239: Pow, Sta, Wis, Spl, Con, Crt)
  bpow: 234, bsta: 235, bwis: 236, bspl: 237, bcon: 238, bcrt: 239,
  // 4th-job stats (242-245)
  bpatk: 242, bpatkrate: 242,
  bsmatk: 243, bsmatkrate: 243,
  bres:  244, bresrate: 244,
  bmres: 245, bmresrate: 245,
  // New critical-damage-% stat and Heal Plus
  bcrate: 253, bcraterate: 253, bcritatkrate: 253,
  bhplus: 254, bhplusrate: 254, bhealpower: 254, bhealpower2: 254,
};

// -----------------------------------------------------------------------------
// Fallback: rAthena bonus name -> EnumVAR field (for bonuses without a known
// literal ID). These still load cleanly because EnumVAR is a runtime global,
// but the tooltip scanner won't pick them up — they won't display in-game.
// Add real integer IDs to EXTPARAM_LITERAL above as you verify them for your
// client build.
// -----------------------------------------------------------------------------
const SIMPLE_EXT_PARAM = {
  // Main stats
  bstr:          "VAR_STRAMOUNT",
  bagi:          "VAR_AGIAMOUNT",
  bvit:          "VAR_VITAMOUNT",
  bint:          "VAR_INTAMOUNT",
  bdex:          "VAR_DEXAMOUNT",
  bluk:          "VAR_LUKAMOUNT",
  // Trait stats
  bpow:          "VAR_POWAMOUNT",
  bsta:          "VAR_STAAMOUNT",
  bwis:          "VAR_WISAMOUNT",
  bspl:          "VAR_SPLAMOUNT",
  bcon:          "VAR_CONAMOUNT",
  bcrt:          "VAR_CRTAMOUNT",
  // HP/SP
  bmaxhp:        "VAR_MAXHPAMOUNT",
  bmaxsp:        "VAR_MAXSPAMOUNT",
  bmaxhprate:    "VAR_MAXHPPERCENT",
  bmaxsprate:    "VAR_MAXSPPERCENT",
  // Hit / flee / critical chance
  bhit:          "VAR_HITSUCCESSVALUE",
  bhitrate:      "VAR_HITSUCCESSVALUE",
  bflee:         "VAR_AVOIDSUCCESSVALUE",
  bfleerate:     "VAR_AVOIDSUCCESSVALUE",
  bflee2:        "VAR_PLUSAVOIDSUCCESSVALUE",
  bflee2rate:    "VAR_PLUSAVOIDSUCCESSVALUE",
  bcritical:     "VAR_CRITICALSUCCESSVALUE",
  bcriticalrate: "VAR_CRITICALSUCCESSVALUE",
  // Attack / Defense
  bbaseatk:      "VAR_ATTPOWER",
  batk:          "VAR_ATTPOWER",
  batk2:         "VAR_ATTPOWER",
  batkrate:      "VAR_ATKPERCENT",
  bmatk:         "VAR_ATTMPOWER",
  bmatkrate:     "VAR_MAGICATKPERCENT",
  bdef:          "VAR_ITEMDEFPOWER",
  bdef2:         "VAR_ITEMDEFPOWER",
  bdefrate:      "VAR_ITEMDEFPOWER",
  bdef2rate:     "VAR_ITEMDEFPOWER",
  bmdef:         "VAR_MDEFPOWER",
  bmdef2:        "VAR_MDEFPOWER",
  bmdefrate:     "VAR_MDEFPOWER",
  bmdef2rate:    "VAR_MDEFPOWER",
  // ASPD
  baspd:         "VAR_PLUSASPD",
  baspdrate:     "VAR_PLUSASPDPERCENT",
  // 4th-job / new stats
  bpatk:         "VAR_PATKAMOUNT",
  bpatkrate:     "VAR_PATKAMOUNT",
  bsmatk:        "VAR_SMATKAMOUNT",
  bsmatkrate:    "VAR_SMATKAMOUNT",
  bres:          "VAR_RESAMOUNT",
  bresrate:      "VAR_RESAMOUNT",
  bmres:         "VAR_MRESAMOUNT",
  bmresrate:     "VAR_MRESAMOUNT",
  bhplus:        "VAR_HEAL_PLUS",
  bhplusrate:    "VAR_HEAL_PLUS",
  bhealpower:    "VAR_HEAL_PLUS",
  bhealpower2:   "VAR_HEAL_PLUS",
  bcrate:        "VAR_CRITICAL_RATE",   // Critical Damage % (new stat), not crit chance
  bcraterate:    "VAR_CRITICAL_RATE",
  bcritatkrate:  "VAR_CRITICAL_RATE",
  // Regen acceleration
  bhpregenrate:  "VAR_HPACCELERATION",
  bhprecovrate:  "VAR_HPACCELERATION",
  bspregenrate:  "VAR_SPACCELERATION",
  bsprecovrate:  "VAR_SPACCELERATION",
  // NOTE: bUseSPrate, bDelayrate, bVariableCastrate, bFixedCast etc. are
  // NOT mapped to AddExtParam — kRO renders them through dedicated Sub*/Add*
  // helpers (SubSPconsumption, SubSpellDelay, SubSpellCastTime, ...) listed
  // in EquipmentPropertiesOrder.lub. Real translators are wired below
  // (search for SIGNED_TOOLTIP_CALLS).
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// ----- Enum -> literal integer ID helpers ---------------------------------
// The client tooltip scanner requires literal integer arguments in native
// function calls like AddRaceTolerace(7, 12). Runtime lookups (`Race.Human`)
// load fine but do not render in the tooltip. These maps match the IDs the
// existing EquipmentProperties.lub uses and the kRO client expects.

const RACE_IDS = {
  RC_FORMLESS:     0,
  RC_UNDEAD:       1,
  RC_BRUTE:        2,
  RC_PLANT:        3,
  RC_INSECT:       4,
  RC_FISH:         5,
  RC_DEMON:        6,
  RC_DEMIHUMAN:    7,
  RC_ANGEL:        8,
  RC_DRAGON:       9,
  RC_PLAYER_HUMAN: 10,
  RC_PLAYER_DORAM: 11,
  RC_ALL:          9999,
  // Non-standard aliases sometimes seen in custom item_db entries.
  // RC_Boss isn't a race; rAthena treats `bonus2 bAddRace,RC_Boss,X` as
  // "all races" for tooltip purposes. RC_DemiPlayer is a custom alias used
  // by some forks to mean "DemiHuman". Mapping both here so the translator
  // emits real integer IDs instead of broken Lua identifiers.
  RC_BOSS:         9999,
  RC_DEMIPLAYER:   7,
  RC_NONPLAYER:    9999,
  // rAthena pre-renewal alias for "any player race" — covers both the
  // Human (10) and Doram (11) race IDs. We pick 10 as the literal so the
  // translator emits a single call; the description still reads "Player"
  // via BONUS_TRANSLATIONS.race below.
  RC_PLAYER:       10,
  // Aliases for "everything except X" — the client tooltip can't express
  // these as a single race ID, so we route them to RC_ALL (9999) and let
  // the description carry the "non-X" qualifier from BONUS_TRANSLATIONS.
  RC_NONDEMIHUMAN: 9999,
  RC_NONBOSS:      9999,
};
const ELE_IDS = {
  ELE_NEUTRAL: 0, ELE_WATER: 1, ELE_EARTH: 2, ELE_FIRE: 3,
  ELE_WIND:    4, ELE_POISON: 5, ELE_HOLY: 6, ELE_DARK: 7,
  ELE_GHOST:   8, ELE_UNDEAD: 9, ELE_ALL: 10,
};
const SIZE_IDS = {
  SIZE_SMALL: 0, SIZE_MEDIUM: 1, SIZE_LARGE: 2,
};
const CLASS_IDS = {
  CLASS_NORMAL: 0, CLASS_BOSS: 1, CLASS_GUARDIAN: 2,
};

// Sentinel returned when an enum name doesn't map to a known integer. Callers
// MUST check `isUnknownEnum(value)` and fall back to a description-only line
// rather than emitting a function call like `RaceAddDamage(RC_Foo, 5)` —
// referencing an undefined Lua global would crash the client at equip time.
const UNKNOWN_ENUM = Symbol("UNKNOWN_ENUM");
function isUnknownEnum(v) { return v === UNKNOWN_ENUM; }

function raceEnum(name) {
  const n = String(name || "").trim().toUpperCase();
  if (n in RACE_IDS) return RACE_IDS[n];
  if (("RC_" + n) in RACE_IDS) return RACE_IDS["RC_" + n];
  return UNKNOWN_ENUM;
}
function eleEnum(name) {
  const n = String(name || "").trim().toUpperCase();
  if (n in ELE_IDS) return ELE_IDS[n];
  if (("ELE_" + n) in ELE_IDS) return ELE_IDS["ELE_" + n];
  return UNKNOWN_ENUM;
}
function sizeEnum(name) {
  const n = String(name || "").trim().toUpperCase();
  if (n in SIZE_IDS) return SIZE_IDS[n];
  if (("SIZE_" + n) in SIZE_IDS) return SIZE_IDS["SIZE_" + n];
  return UNKNOWN_ENUM;
}
function classEnum(name) {
  const n = String(name || "").trim().toUpperCase();
  if (n in CLASS_IDS) return CLASS_IDS[n];
  if (("CLASS_" + n) in CLASS_IDS) return CLASS_IDS["CLASS_" + n];
  return UNKNOWN_ENUM;
}

// Helper for translators whose Lua call depends on a single enum lookup.
// If the enum resolved to UNKNOWN_ENUM (i.e. the .conf used an alias we
// don't recognise), return null so translateScript() will fall back to a
// description-only comment instead of emitting `RaceAddDamage(null, …)` or
// referencing a non-existent Lua global like `RC_C_Tower`.
function emitE(value, fn) {
  return isUnknownEnum(value) ? null : fn(value);
}

// Emit a single AddExtParam call, preferring a known literal integer ID
// (which the client's tooltip scanner can read) and falling back to the
// EnumVAR form for unmapped bonuses.
function emitExtParam(bname, enumName, value) {
  const literal = EXTPARAM_LITERAL[bname];
  if (literal !== undefined) {
    return `AddExtParam(0, ${literal}, ${value})`;
  }
  return `AddExtParam(0, EnumVAR.${enumName}[2], ${value})`;
}

// Helper: multi-stat shortcut (e.g. bAllStats, bAllTraitStats, bAgiDexStr, bAgiVit).
// Takes an array of [bonusName, enumName] pairs so each slot can pick its
// own literal ID if known.
function multiStat(pairs, value) {
  return pairs.map(([b, e]) => emitExtParam(b, e, value));
}

const BONUS_TRANSLATORS = {
  // Multi-stat shortcuts
  ballstats: (_n, a) => a.length === 1 ? multiStat([
    ["bstr","VAR_STRAMOUNT"], ["bagi","VAR_AGIAMOUNT"], ["bvit","VAR_VITAMOUNT"],
    ["bint","VAR_INTAMOUNT"], ["bdex","VAR_DEXAMOUNT"], ["bluk","VAR_LUKAMOUNT"],
  ], a[0]) : null,
  balltraitstats: (_n, a) => a.length === 1 ? multiStat([
    ["bpow","VAR_POWAMOUNT"], ["bsta","VAR_STAAMOUNT"], ["bwis","VAR_WISAMOUNT"],
    ["bspl","VAR_SPLAMOUNT"], ["bcon","VAR_CONAMOUNT"], ["bcrt","VAR_CRTAMOUNT"],
  ], a[0]) : null,
  bagidexstr: (_n, a) => a.length === 1 ? multiStat([
    ["bagi","VAR_AGIAMOUNT"], ["bdex","VAR_DEXAMOUNT"], ["bstr","VAR_STRAMOUNT"],
  ], a[0]) : null,
  bagivit: (_n, a) => a.length === 1 ? multiStat([
    ["bagi","VAR_AGIAMOUNT"], ["bvit","VAR_VITAMOUNT"],
  ], a[0]) : null,

  // --- Race-based bonus2 ---
  baddrace:         (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `RaceAddDamage(${r}, ${a[1]})`) : null,
  // bAddRace2/bSubRace2/bMagicAddRace2 take an RC2_* monster sub-race (e.g.
  // RC2_Kobold) that has no kRO client function equivalent. Emit as
  // description-only so the player still sees the effect text rendered via
  // the bonus2 template (which uses ARG → friendlyArg → RC2_ branch).
  baddrace2:        (_n, a) => a.length === 2 ? [] : null,
  // 3-arg form (bonus3 bSubRace, RC_X, V, BF_X) drops the BF trigger flag,
  // same rationale as bAddEle/bSubEle above.
  bsubrace:         (_n, a) => (a.length === 2 || a.length === 3)
                                ? emitE(raceEnum(a[0]), r => `AddRaceTolerace(${r}, ${a[1]})`) : null,
  bsubrace2:        (_n, a) => a.length === 2 ? [] : null,
  // Hercules alias for rAthena bSubRace — same semantics, same client call.
  baddracetolerance: (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddRaceTolerace(${r}, ${a[1]})`) : null,
  // Hercules alias bRaceTolerance (no Add prefix) — same as bSubRace.
  bracetolerance:   (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddRaceTolerace(${r}, ${a[1]})`) : null,
  bmagicaddrace:    (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddMdamage_Race(${r}, ${a[1]})`) : null,
  bmagicaddrace2:   (_n, a) => a.length === 2 ? [] : null,
  bcriticaladdrace: (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddCRIPercent_Race(${r}, ${a[1]})`) : null,
  bexpaddrace:      (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddEXPPercent_KillRace(${r}, ${a[1]})`) : null,
  bignoredefrace:        (_n, a) => a.length === 1 ? emitE(raceEnum(a[0]), r => `SetIgnoreDEFRace(${r})`) : null,
  bignoredefracerate:    (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `SetIgnoreDefRace_Percent(${r}, ${a[1]})`) : null,
  bignoremdefrace:       (_n, a) => a.length === 1 ? emitE(raceEnum(a[0]), r => `SetIgnoreMdefRace(${r}, 100)`) : null,
  bignoremdefracerate:   (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `SetIgnoreMdefRace(${r}, ${a[1]})`) : null,
  bignoreresraceratePERCENT: null, // filler; lower-case below
  bignoreresracerate:    (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddIgnore_RES_RacePercent(${r}, ${a[1]})`) : null,
  bignoremresracerate:   (_n, a) => a.length === 2 ? emitE(raceEnum(a[0]), r => `AddIgnore_MRES_RacePercent(${r}, ${a[1]})`) : null,

  // --- Element-based bonus2 ---
  // 3-arg forms (bonus3 bAddEle, Ele_X, V, BF_X / bonus3 bSubEle, Ele_X, V, BF_X)
  // — the BF_* trigger flag has no client-tooltip equivalent, so we emit the
  // base 2-arg call (the player still gets the actual damage/resist effect
  // bound to the equipment) and rely on the bonus3 template to render the
  // trigger note in the description comment.
  baddele:        (_n, a) => (a.length === 2 || a.length === 3)
                              ? emitE(eleEnum(a[0]), e => `AddDamage_Property(${e}, ${a[1]})`) : null,
  bsubele:        (_n, a) => (a.length === 2 || a.length === 3)
                              ? emitE(eleEnum(a[0]), e => `AddAttrTolerace(${e}, ${a[1]})`) : null,
  bmagicaddele:   (_n, a) => a.length === 2 ? emitE(eleEnum(a[0]), e => `AddMDamage_Property(${e}, ${a[1]})`) : null,
  // bMagicAtkEle 1-arg form sets the player's magic damage element; the
  // 2-arg form (bonus2 bMagicAtkEle, Ele_X, V) buffs magic damage of element
  // X by V% and has no client function — description-only.
  bmagicatkele:   (_n, a) => {
    if (a.length === 1) return emitE(eleEnum(a[0]), e => `AddAttackElement(${e})`);
    if (a.length === 2) return [];
    return null;
  },
  bignoredefele:  (_n, a) => a.length === 1 ? emitE(eleEnum(a[0]), e => `SetIgnoreDEFElement(${e})`) : null,
  bignoremdefele: (_n, a) => a.length === 1 ? emitE(eleEnum(a[0]), e => `SetIgnoreMdefElement(${e})`) : null,

  // --- Size-based bonus2 ---
  baddsize:      (_n, a) => a.length === 2 ? emitE(sizeEnum(a[0]), s => `AddDamage_Size(${s}, ${a[1]})`) : null,
  bsubsize:      (_n, a) => a.length === 2 ? emitE(sizeEnum(a[0]), s => `SubDamage_Size(${s}, ${a[1]})`) : null,
  bmagicaddsize: (_n, a) => a.length === 2 ? emitE(sizeEnum(a[0]), s => `AddMDamage_Size(${s}, ${a[1]})`) : null,
  bmagicsubsize: (_n, a) => a.length === 2 ? emitE(sizeEnum(a[0]), s => `SubMDamage_Size(${s}, ${a[1]})`) : null,

  // --- Reflect (server-applied; client emits a literal call so the
  //     tooltip scanner picks up the value the player will see) ---
  bshortweapondamagereturn: (_n, a) => a.length === 1 ? `AddMeleeAttackReflect(${a[0]})` : null,
  // No standalone "AddRangedAttackReflect"; long-weapon return has no
  // client-visible call → leave as description-only.

  // --- Class-based bonus2 (Normal/Boss/Guardian) ---
  baddclass:               (_n, a) => a.length === 2 ? emitE(classEnum(a[0]), c => `ClassAddDamage(${c}, ${a[1]})`) : null,
  bsubclass:               (_n, a) => a.length === 2 ? emitE(classEnum(a[0]), c => `ClassSubDamage(${c}, ${a[1]})`) : null,
  bmagicaddclass:          (_n, a) => a.length === 2 ? emitE(classEnum(a[0]), c => `AddMdamage_Class(${c}, ${a[1]})`) : null,
  bignoredefclass:         (_n, a) => a.length === 1 ? emitE(classEnum(a[0]), c => `SetIgnoreDEFClass(${c})`) : null,
  bignoredefclassrate:     (_n, a) => a.length === 2 ? emitE(classEnum(a[0]), c => `SetIgnoreDefClass_Percent(${c}, ${a[1]})`) : null,
  bignoremdefclassrate:    (_n, a) => a.length === 2 ? emitE(classEnum(a[0]), c => `SetIgnoreMdefClass(${c}, ${a[1]})`) : null,
};

// Marker translator: bonus is recognised but emits no Lua call. The pipeline
// will still emit its description comment (and a raw-line fallback if the
// template is missing). Use this for the dozens of bonuses that have no
// known client-side function and exist purely as tooltip text.
const descOnly = () => [];

// Wire simple stat bonuses in from SIMPLE_EXT_PARAM. Each translator picks
// either the literal integer ID (if known) or falls back to the EnumVAR form.
// For arg counts that don't match the 1-arg form (e.g. `bonus2 bHPRegenRate,n,t`),
// fall through to description-only emit instead of dropping the bonus on the
// floor.
for (const k of Object.keys(SIMPLE_EXT_PARAM)) {
  BONUS_TRANSLATORS[k] = (n, args) => {
    if (args.length === 1) return emitExtParam(n, SIMPLE_EXT_PARAM[n], args[0]);
    return [];
  };
}

// ---------------------------------------------------------------------------
// Description-only bonuses (full rAthena item_bonus.txt coverage)
//
// These bonuses are *recognised* by the translator but have no known
// client-side Lua function — they exist purely as tooltip text. We emit the
// description comment from bonus_templates.yml and skip the Lua emit. The
// actual gameplay effect comes from the server reading item_db, not from
// the .lub.
//
// Bonuses that DO have a Lua-emitting translator above keep their behaviour;
// names listed here that are already registered (e.g. via SIMPLE_EXT_PARAM)
// are NOT overwritten.
// ---------------------------------------------------------------------------
const DESC_ONLY_BONUSES = [
  // ----- Section 1: Basic Bonuses (extras beyond SIMPLE_EXT_PARAM) -----
  "bMaxAP", "bMaxAPrate",
  "bWeaponAtkRate", "bMatk2", "bWeaponMatkRate",
  "bCriticalLong",
  "bPerfectHitRate", "bPerfectHitAddRate",
  "bSpeedRate", "bSpeedAddRate",
  "bAtkRange", "bAddMaxWeight",

  // ----- Section 2: Extended Bonuses -----
  // HP/SP regen and loss
  "bHPLossRate", "bSPLossRate",
  "bRegenPercentHP", "bRegenPercentSP",
  "bNoRegen",
  "bUseSPrate",
  "bSkillUseSP", "bSkillUseSPrate",
  // Skill / damage modifiers
  "bSkillAtk",
  "bSkillRatio",
  "bShortAtkRate", "bLongAtkRate",
  "bCritAtkRate", "bNonCritAtkRate", "bCritDefRate", "bCriticalDef",
  "bWeaponAtk", "bWeaponDamageRate",
  "bNearAtkDef", "bLongAtkDef", "bMagicAtkDef", "bMiscAtkDef",
  "bNoWeaponDamage", "bNoMagicDamage", "bNoMiscDamage",
  // Healing
  "bSkillHeal", "bSkillHeal2",
  "bAddItemHealRate", "bAddItemSPHealRate",
  "bAddItemGroupHealRate", "bAddItemGroupSPHealRate",
  // Cast time / delay
  "bCastrate", "bFixedCastrate", "bVariableCastrate",
  "bFixedCast", "bSkillFixedCast",
  "bVariableCast", "bSkillVariableCast",
  "bNoCastCancel", "bNoCastCancel2",
  "bDelayrate", "bSkillDelay", "bSkillCooldown",

  // ----- Section 3: Group-specific Bonuses (extras) -----
  // NOTE: bAutoSpell, bAutoSpellWhenHit, bAddEff are handled by explicit
  // translators below — they emit AddAutoSpell / AddAutoSpellWhenHit /
  // AddEffectOnAttack calls that match custom Order entries in the user's
  // EquipmentPropertiesOrder1.lub (entries [7]..[10]). Leaving them as
  // desc-only here would skip the call emission.
  "bSubDefEle", "bMagicSubDefEle",
  "bWeaponSubSize", "bNoSizeFix",
  "bAddDamageClass", "bAddMagicDamageClass",
  "bAddDefMonster", "bAddMDefMonster",
  "bSubSkill",
  "bAbsorbDmgMaxHP", "bAbsorbDmgMaxHP2",
  "bAtkEle", "bDefEle",
  "bDefRatioAtkRace", "bDefRatioAtkEle", "bDefRatioAtkClass",
  "bSetDefRace", "bSetMDefRace",
  "bIgnoreMdefRace2Rate",
  "bExpAddClass",
  "bDropAddRace", "bDropAddClass",

  // ----- Section 4: Status-related Bonuses -----
  "bAddEff", "bAddEff2", "bAddEffWhenHit",
  "bResEff",
  "bAddEffOnSkill",
  "bComaClass", "bComaRace",
  "bWeaponComaEle", "bWeaponComaClass", "bWeaponComaRace",

  // ----- Section 5: AutoSpell Bonuses -----
  "bAutoSpell", "bAutoSpellWhenHit", "bAutoSpellOnSkill",

  // ----- Section 6: Misc Bonuses -----
  // HP/SP drain
  "bHPDrainValue", "bHPDrainValueRace", "bHpDrainValueClass",
  "bSPDrainValue", "bSPDrainValueRace", "bSpDrainValueClass",
  "bHPDrainRate", "bSPDrainRate",
  // HP/SP vanish
  "bHPVanishRate", "bHPVanishRaceRate",
  "bSPVanishRate", "bSPVanishRaceRate",
  "bStateNoRecoverRace",
  // HP/SP gain on kill
  "bHPGainValue", "bSPGainValue", "bSPGainRace",
  "bLongHPGainValue", "bLongSPGainValue",
  "bMagicHPGainValue", "bMagicSPGainValue",
  // Damage return / reflect
  "bShortWeaponDamageReturn", "bLongWeaponDamageReturn",
  "bMagicDamageReturn", "bReduceDamageReturn",
  // Strip / break protection
  "bUnstripableWeapon", "bUnstripableArmor", "bUnstripableHelm",
  "bUnstripableShield", "bUnstripable",
  "bUnbreakableGarment", "bUnbreakableWeapon", "bUnbreakableArmor",
  "bUnbreakableHelm", "bUnbreakableShield", "bUnbreakableShoes",
  "bUnbreakable",
  "bBreakWeaponRate", "bBreakArmorRate",
  // Drops
  "bAddMonsterIdDropItem",
  "bAddMonsterDropItem", "bAddClassDropItem",
  "bAddMonsterDropItemGroup", "bAddClassDropItemGroup",
  // Zeny
  "bGetZenyNum", "bAddGetZenyNum",
  // Misc effects
  "bDoubleRate", "bDoubleAddRate",
  "bSplashRange", "bSplashAddRange",
  "bAddSkillBlow",
  "bNoKnockback", "bNoGemStone",
  "bIntravision", "bPerfectHide",
  "bRestartFullRecover",
  "bClassChange",
  "bAddStealRate",
  "bNoMadoFuel", "bNoWalkDelay",

  // ----- Hercules-specific (or differently named) bonuses -----
  // bAddRaceTolerance is a real translator (above) — Hercules alias for bSubRace.
  "bAddDefClass", "bAddMdefClass",
  "bIgnoreDefRate", "bIgnoreMdefRate",
  "bHPDrainRateRace", "bSPDrainRateRace",
  "bHPGainRaceAttack", "bSPGainRaceAttack",
  "bAddMonsterDropChainItem",
];

for (const name of DESC_ONLY_BONUSES) {
  const key = name.toLowerCase();
  if (!BONUS_TRANSLATORS[key]) BONUS_TRANSLATORS[key] = descOnly;
}

// ----------------------------------------------------------------------------
// Signed-tooltip translators (SIGNED_TOOLTIP_CALLS)
//
// kRO renders some bonuses through paired Sub*/Add* helpers rather than
// AddExtParam. EquipmentPropertiesOrder.lub lists them with
// `func = { "SubX", "AddX" }` — the tooltip picks the Sub or Add side
// based on sign so the player sees e.g. "SP Consumption -20%" instead of a
// generic "-20" with no label. We emit the same: positive value → Add,
// negative value → Sub(abs). For non-literal expressions we fall back to
// Add with the raw expr so the call at least loads.
//
// Override anything DESC_ONLY_BONUSES / SIMPLE_EXT_PARAM set earlier.
// ----------------------------------------------------------------------------
function emitSignedTooltipCall(addFn, subFn, valueExpr) {
  const num = Number(String(valueExpr).trim());
  if (Number.isFinite(num) && num < 0) return `${subFn}(${Math.abs(num)})`;
  return `${addFn}(${valueExpr})`;
}
const SIGNED_TOOLTIP_CALLS = {
  // SP cost rate — generic skill SP consumption (rendered by Order file #2401).
  busesprate:        ["AddSPconsumption",      "SubSPconsumption"],
  // After-cast delay rate — "Global Cooldown".
  bdelayrate:        ["AddSpellDelay",         "SubSpellDelay"],
  // Variable cast time rate.
  bvariablecastrate: ["AddSpellCastTime",      "SubSpellCastTime"],
  bcastrate:         ["AddSpellCastTime",      "SubSpellCastTime"],
  // Fixed cast time (flat ms — Order entry [19] divides by 1000 for display).
  bfixedcast:        ["AddSFCTEquipAmount",    "SubSFCTEquipAmount"],
};
for (const [key, [addFn, subFn]] of Object.entries(SIGNED_TOOLTIP_CALLS)) {
  BONUS_TRANSLATORS[key] = (_n, a) =>
    a.length === 1 ? emitSignedTooltipCall(addFn, subFn, a[0]) : null;
}

// ----------------------------------------------------------------------------
// Skill-targeted bonus2 translators
//
// rAthena `bonus2 bX, SkillName, V` → kRO `XxxxSkid(SKID.Name, V)`. The
// EquipmentPropertiesOrder.lub entries that render these expect the SKID.X
// constant (loaded from skillid.lub) — so we emit `SKID.<AEGIS_NAME>` as
// the first argument. The aegis name matches rAthena's SkillName form.
// ----------------------------------------------------------------------------
// Emergency fallback numeric IDs for common skills, used when BOTH the
// user's local skillid.lub AND the bundled `skillid.template.lub` failed
// to load. Skill-ID resolution order:
//   1. SKILL_AEGIS_TO_ID (populated by loadSkillDb from skillid.lub —
//      either the user's local copy or the bundled template).
//   2. BUILTIN_SKILL_IDS (this table — covers the ~100 most-used skills).
//   3. Caller drops the call entirely (description-only fallback).
// In practice (1) almost always wins since the template ships with every
// build; this table only matters if the bundle itself is corrupted.
const BUILTIN_SKILL_IDS = {
  // Novice
  NV_BASIC: 1, NV_FIRSTAID: 142, NV_TRICKDEAD: 143,
  // Swordsman
  SM_SWORD: 2, SM_TWOHAND: 3, SM_RECOVERY: 4, SM_BASH: 5,
  SM_PROVOKE: 6, SM_MAGNUM: 7, SM_ENDURE: 8,
  // Mage
  MG_SRECOVERY: 9, MG_SIGHT: 10, MG_NAPALMBEAT: 11, MG_SAFETYWALL: 12,
  MG_SOULSTRIKE: 13, MG_COLDBOLT: 14, MG_FROSTDIVER: 15, MG_STONECURSE: 16,
  MG_FIREBALL: 17, MG_FIREWALL: 18, MG_FIREBOLT: 19, MG_LIGHTNINGBOLT: 20,
  MG_THUNDERSTORM: 21,
  // Acolyte
  AL_DP: 22, AL_DEMONBANE: 23, AL_RUWACH: 24, AL_PNEUMA: 25,
  AL_TELEPORT: 26, AL_WARP: 27, AL_HEAL: 28, AL_INCAGI: 29,
  AL_DECAGI: 30, AL_HOLYWATER: 31, AL_CRUCIS: 32, AL_ANGELUS: 33,
  AL_BLESSING: 34, AL_CURE: 35,
  // Merchant
  MC_INCCARRY: 36, MC_DISCOUNT: 37, MC_OVERCHARGE: 38, MC_PUSHCART: 39,
  MC_IDENTIFY: 40, MC_VENDING: 41, MC_MAMMONITE: 42,
  // Archer
  AC_OWL: 43, AC_VULTURE: 44, AC_CONCENTRATION: 45, AC_DOUBLE: 46,
  AC_SHOWER: 47,
  // Thief
  TF_DOUBLE: 48, TF_MISS: 49, TF_STEAL: 50, TF_HIDING: 51,
  TF_POISON: 52, TF_DETOXIFY: 53,
  // Knight
  KN_SPEARMASTERY: 54, KN_PIERCE: 55, KN_BRANDISHSPEAR: 56,
  KN_SPEARSTAB: 57, KN_SPEARBOOMERANG: 58, KN_TWOHANDQUICKEN: 59,
  KN_AUTOCOUNTER: 60, KN_BOWLINGBASH: 62, KN_RIDING: 63, KN_CAVALIERMASTERY: 64,
  // Wizard
  WZ_FIREPILLAR: 80, WZ_SIGHTRASHER: 81, WZ_METEOR: 83, WZ_JUPITEL: 84,
  WZ_VERMILION: 85, WZ_WATERBALL: 86, WZ_ICEWALL: 87, WZ_FROSTNOVA: 88,
  WZ_STORMGUST: 89, WZ_EARTHSPIKE: 90, WZ_HEAVENDRIVE: 91, WZ_QUAGMIRE: 92,
  WZ_ESTIMATION: 93,
  // Hunter
  HT_SKIDTRAP: 117, HT_LANDMINE: 118, HT_ANKLESNARE: 119, HT_SHOCKWAVE: 120,
  HT_SANDMAN: 121, HT_FLASHER: 122, HT_FREEZINGTRAP: 123, HT_BLASTMINE: 124,
  HT_CLAYMORETRAP: 125, HT_REMOVETRAP: 126, HT_TALKIEBOX: 127,
};

// Resolve a rAthena skill aegis name (MG_FIREBOLT) to the kRO numeric skill ID
// (19). Tries the runtime-loaded skillid.lub first, then a built-in fallback
// table of common skills. Returns null only when truly unknown — emitters
// then drop the Lua call (never emit SKID.<NAME>, which crashes at runtime
// when the client's SKID global isn't loaded yet).
function resolveSkillId(skillName) {
  const aegis = String(skillName || "").trim().replace(/^"|"$/g, "").toUpperCase();
  if (SKILL_AEGIS_TO_ID.has(aegis)) return SKILL_AEGIS_TO_ID.get(aegis);
  if (BUILTIN_SKILL_IDS[aegis] !== undefined) return BUILTIN_SKILL_IDS[aegis];
  return null;
}

// kRO skill-targeted tooltip calls have several argument shapes — verified
// against EquipmentPropertiesOrder.lub's val/sep/cond indices:
//   shape "tsv": (target, skill, value)   — AddDamage_SKID only (3 args).
//   shape "sv":  (skill,  value)          — most per-skill calls (2 args).
//   shape "vs":  (value,  skill)          — addspconsumption / subspconsumption
//                                            per-skill SP cost rate (2 args).
// `target` = 1 (Unit.Target = enemy). Sign-aware: negative value picks Sub.
// We never emit `SKID.<NAME>` — the SKID global table loads AFTER
// EquipmentProperties.lub on Project 255, so the call would crash at runtime
// ("attempt to index global 'SKID' (a nil value)"). Unknown skill → null
// (caller falls back to a description-only line; safe, just not visible).
function emitSkillTargetedCall(addFn, subFn, shape, skillName, valueExpr) {
  const raw = String(skillName || "").trim().replace(/^"|"$/g, "");
  let skillArg;
  if (/^\d+$/.test(raw)) {
    skillArg = raw;                              // already a numeric skill id
  } else {
    const skillId = resolveSkillId(raw);
    if (skillId == null) return null;            // unknown → drop call
    skillArg = String(skillId);
  }
  const num = Number(String(valueExpr).trim());
  const useSub = Number.isFinite(num) && num < 0 && subFn;
  const fn = useSub ? subFn : addFn;
  const val = useSub ? String(Math.abs(num)) : String(valueExpr);
  if (shape === "tsv") return `${fn}(1, ${skillArg}, ${val})`;
  if (shape === "vs")  return `${fn}(${val}, ${skillArg})`;
  // default "sv"
  return `${fn}(${skillArg}, ${val})`;
}
const SKILL_TARGETED_CALLS = {
  // bonus2 bSkillAtk, Skill, V%  — Order [6] cond=[1]=Unit.Target, sep=[2]=skill,
  // val=[3]=value → 3-arg `AddDamage_SKID(target, skill, value)`.
  bskillatk:              ["AddDamage_SKID",             null,                 "tsv"],
  // bonus2 bSkillCooldown, Skill, V — Order [5] sep=[1]=skill, val=[2]=value →
  // 2-arg `SubSkillDelay(skill, value)`.
  bskillcooldown:         ["AddSkillDelay",              "SubSkillDelay",      "sv"],
  // bonus2 bSkillUseSP, Skill, V — Order [4] sep=[1]=skill, val=[2]=value →
  // 2-arg `SubSkillSP(skill, value)`.
  bskillusesp:            ["AddSkillSP",                 "SubSkillSP",         "sv"],
  // bonus2 bSkillUseSPrate, Skill, V — Order [3] val=[1]=value, sep=[2]=skill →
  // 2-arg `subspconsumption(value, skill)` (lowercase function name!).
  bskillusesprate:        ["addspconsumption",           "subspconsumption",   "vs"],
};
for (const [key, [addFn, subFn, shape]] of Object.entries(SKILL_TARGETED_CALLS)) {
  BONUS_TRANSLATORS[key] = (_n, a) =>
    a.length === 2 ? emitSkillTargetedCall(addFn, subFn, shape, a[0], a[1]) : null;
}
// `bonus2 bVariableCastrate, SkillName, V%` shares its name with the 1-arg
// global form. Distinguish by arg count.
//   - 1 arg  → SubSpellCastTime / AddSpellCastTime              (global rate)
//   - 2 args → SubSpecificSpellCastTime / AddSpecificSpellCastTime (per-skill)
// Per Order section [6] entry [2]: sep=[1]=skill, val=[2]=value → 2-arg shape.
const _origVcr = BONUS_TRANSLATORS["bvariablecastrate"];
BONUS_TRANSLATORS["bvariablecastrate"] = (n, a) => {
  if (a.length === 2) {
    return emitSkillTargetedCall(
      "AddSpecificSpellCastTime", "SubSpecificSpellCastTime", "sv", a[0], a[1]
    );
  }
  return _origVcr ? _origVcr(n, a) : null;
};

// ----------------------------------------------------------------------------
// AutoSpell / on-attack effect translators
//
// These match custom Order entries [7]..[10] added to the user's
// EquipmentPropertiesOrder1.lub (RDL stub functions are defined at the top
// of that file as no-ops). The Order entries render them as:
//   EnableSkill(id, lv)             → "Enable to use Level L of <Skill>"
//   AddAutoSpell(id, lv, rate)      → "Random chance to auto-cast Level L of <Skill> on attack"
//   AddAutoSpellWhenHit(id, lv, r)  → "Random chance to auto-cast Level L of <Skill> when hit"
//   AddEffectOnAttack(id, chance%)  → "Has N% chance of inflicting <Effect> when attacking"
//
// Status-effect IDs use the rAthena Eff_* numeric mapping (Eff_Stun=1,
// Eff_Freeze=2, Eff_Stone=3, ...). Same as kRO SC_* table order for the
// common effects.
// ----------------------------------------------------------------------------
const EFF_IDS = {
  EFF_STUN: 1, EFF_FREEZE: 2, EFF_STONE: 3, EFF_SLEEP: 4,
  EFF_POISON: 5, EFF_CURSE: 6, EFF_SILENCE: 7, EFF_CONFUSION: 8,
  EFF_BLIND: 9, EFF_BLEEDING: 10, EFF_DPOISON: 11,
  EFF_BURNING: 127, EFF_FREEZING: 128,
};
function effId(name) {
  const s = String(name || "").trim().replace(/^"|"$/g, "");
  const key = (/^Eff_/i.test(s) ? s : "Eff_" + s).toUpperCase();
  if (EFF_IDS[key] !== undefined) return EFF_IDS[key];
  // Numeric input — pass through.
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

// Strict numeric-literal check — rejects rAthena ternaries `(a>=80)?30:10`,
// server-only refs (Agi, BaseLevel, getrefine), and anything else the kRO
// client can't evaluate safely at OnStartEquip time. Used by AutoSpell /
// AddEff translators so an unparseable rate or chance falls back to
// description-only instead of producing invalid Lua.
function isSafeNumericLiteral(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  // Allow plain integers and basic numeric expressions: digits, +-*/(), space.
  if (!/^[\d\s+\-*/().]+$/.test(t)) return false;
  if (!/\d/.test(t)) return false;
  return true;
}

// bonus bAddMaxWeight, V  →  AddMaxWeight(V) / SubMaxWeight(|V|)
// Tooltip rendered by RDL custom Order entry [11] (in the bundled
// EquipmentPropertiesOrder.template.lub stubs). Without this entry the
// kRO client has no native "Max Weight" tooltip slot.
BONUS_TRANSLATORS["baddmaxweight"] = (_n, a) => {
  if (a.length !== 1) return null;
  if (!isSafeNumericLiteral(a[0])) return null;
  const num = Number(a[0]);
  if (Number.isFinite(num) && num < 0) return `SubMaxWeight(${Math.abs(num)})`;
  return `AddMaxWeight(${a[0]})`;
};

// bonus2 bDropAddRace, Race, V%  →  AddReceiveItem_Equip(V)  (only for RC_All)
// kRO's only drop-rate tooltip call is the GLOBAL form (Order entry [23]
// "Item Drop Rate"); there's no per-race drop-rate render function. For
// RC_All scripts we route through that. Other races stay description-only.
BONUS_TRANSLATORS["bdropaddrace"] = (_n, a) => {
  if (a.length !== 2) return null;
  if (!isSafeNumericLiteral(a[1])) return null;
  const race = raceEnum(a[0]);
  // RC_All resolves to 9999. For race-specific drop bonuses (Dragon,
  // Demon, etc.) kRO has no client tooltip — fall back to desc-only.
  if (race !== 9999) return [];
  return `AddReceiveItem_Equip(${a[1]})`;
};

// bonus3 bAutoSpell, Skill, Lv, Rate  →  AddAutoSpell(skill_id, lv, rate)
BONUS_TRANSLATORS["bautospell"] = (_n, a) => {
  if (a.length !== 3) return null;
  const skill = /^\d+$/.test(a[0]) ? parseInt(a[0], 10) : resolveSkillId(a[0]);
  if (skill == null) return null;
  if (!isSafeNumericLiteral(a[1]) || !isSafeNumericLiteral(a[2])) return null;
  return `AddAutoSpell(${skill}, ${a[1]}, ${a[2]})`;
};
// bonus3 bAutoSpellWhenHit, Skill, Lv, Rate  →  AddAutoSpellWhenHit(...)
BONUS_TRANSLATORS["bautospellwhenhit"] = (_n, a) => {
  if (a.length !== 3) return null;
  const skill = /^\d+$/.test(a[0]) ? parseInt(a[0], 10) : resolveSkillId(a[0]);
  if (skill == null) return null;
  if (!isSafeNumericLiteral(a[1]) || !isSafeNumericLiteral(a[2])) return null;
  return `AddAutoSpellWhenHit(${skill}, ${a[1]}, ${a[2]})`;
};
// bonus2 bAddEff, EffName, Rate(1/100%)  →  AddEffectOnAttack(eff_id, chance%)
// Rate is in 1/100% units in rAthena, so divide by 100 for the call.
BONUS_TRANSLATORS["baddeff"] = (_n, a) => {
  if (a.length !== 2) return null;
  const eff = effId(a[0]);
  if (eff == null) return null;
  if (!isSafeNumericLiteral(a[1])) return null;
  const num = Number(a[1]);
  const chance = Number.isFinite(num) ? Math.round(num / 100) : a[1];
  return `AddEffectOnAttack(${eff}, ${chance})`;
};

// Accept both `bonus bName,a,b;` and the no-arg flag form `bonus bName;`.
const BONUS_LINE_RE = /^\s*(bonus[2345]?)\s+(\w+)\s*(?:,\s*(.+?))?\s*;\s*$/i;

// Hercules C-style form: `bonus3(bMagicSubDefEle, Ele_Fire, 5, 3);`
// We rewrite it to rAthena form so the rest of the pipeline doesn't care.
const HERC_PAREN_RE = /^(\s*bonus[2345]?)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*([\s\S]*?))?\s*\)\s*;?\s*$/i;
function normaliseHerculesBonusLine(raw) {
  const m = HERC_PAREN_RE.exec(raw);
  if (!m) return raw;
  const args = (m[3] || "").trim();
  return m[1] + " " + m[2] + (args ? "," + args : "") + ";";
}

function splitArgs(argstr) {
  const out = [];
  // No-arg flag bonuses (`bonus bName;`) leave the args capture group
  // undefined; coerce to a string so iteration below doesn't throw.
  if (argstr == null) return out;
  argstr = String(argstr);
  let buf = "";
  let depth = 0;
  for (const ch of argstr) {
    if (ch === "(" || ch === "[") { depth++; buf += ch; }
    else if (ch === ")" || ch === "]") { depth--; buf += ch; }
    else if (ch === "," && depth === 0) { out.push(buf.trim()); buf = ""; }
    else buf += ch;
  }
  if (buf) out.push(buf.trim());
  return out;
}

// ----- Custom bonus rules (loaded from custom_bonuses.json next to the exe) -----
// Shape of one rule:
//   { name: "bIncreasePogi", args: 1, lua: "IncreasePogi({arg1})", description: "Increase Pogi {arg1}%" }
// {arg1}, {arg2}, ... are replaced with the actual arguments from the script line.
let CUSTOM_BONUSES = [];

function applyTemplate(tpl, args) {
  return tpl.replace(/\{arg(\d+)\}/g, (_, i) => {
    const idx = parseInt(i, 10) - 1;
    return args[idx] != null ? args[idx] : `{arg${i}}`;
  });
}

function findCustomBonus(nameLc) {
  for (const r of CUSTOM_BONUSES) {
    if ((r.name || "").toLowerCase() === nameLc) return r;
  }
  return null;
}

// ============================================================================
// Bonus description templates (loaded from bonus_templates.yml).
//
// Load order (first match wins):
//   1. <exe folder>\bonus_templates.yml                        (override next to the app)
//   2. <exe folder>\Resources\bonus_templates.yml              (RDL-style subfolder)
//   3. %LOCALAPPDATA%\RDL\Resources\bonus_templates.yml        (shared with rdl.exe)
//   4. the copy bundled inside resources.neu                    (/bonus_templates.yml)
//
// Sections:
//   bonus1          — 1-arg phrasings with V / PCT placeholders
//   bonus1_special  — sign-aware (_pos/_neg), numeric-value (_1, _2), or
//                     special-case overrides for 1-arg bonuses
//   bonus2          — 2-arg phrasings with ARG / V / PCT placeholders
//   autobonus       — auto-trigger trigger strings (not used yet)
// ============================================================================

let BONUS_TEMPLATES = {
  bonus1: {}, bonus1_special: {},
  bonus2: {}, bonus3: {}, bonus4: {}, bonus5: {},
  autobonus: {},
};
let TEMPLATE_SOURCE = "(none)";

// Editable enum-to-display translation tables. Populated from the matching
// sections (race / element / size / class / status_effect) in
// bonus_templates.yml. Built-in defaults below match the original
// hard-coded mappings so the app works even without a YAML file.
// Keys are stored in UPPERCASE (the rAthena prefix RC_/ELE_/SIZE_/CLASS_/
// Eff_/SC_/EFST_ is stripped before lookup).
const BONUS_TRANSLATIONS = {
  race: {
    FORMLESS: "Formless", UNDEAD: "Undead", BRUTE: "Brute",
    PLANT: "Plant", INSECT: "Insect", FISH: "Fish",
    DEMON: "Demon", DEMIHUMAN: "Demi-Human", ANGEL: "Angel",
    DRAGON: "Dragon", ALL: "All",
    PLAYER_HUMAN: "Player (Human)", PLAYER_DORAM: "Player (Doram)",
    // DemiPlayer is a custom alias used by some forks for DemiHuman; map
    // both to the same friendly name so tooltips don't render as the raw
    // "Demiplayer" titlecase fallback.
    DEMIPLAYER: "Demi-Human",
    // rAthena legacy / Hercules aliases for "any player" and "everything
    // except X". The numeric RACE_IDS mapping picks the closest single ID
    // (10 / 9999); these strings supply the friendly description text.
    PLAYER: "Player",
    NONPLAYER: "Non-Player",
    NONDEMIHUMAN: "Non-Demi-Human",
    NONBOSS: "Non-Boss",
    BOSS: "Boss",
  },
  // Monster-race (RC2_*) aliases used by `bonus2 bAddRace2 / bSubRace2 /
  // bMagicAddRace2`. These have no client-side function call equivalent —
  // the description is the only thing the tooltip can show. Keys are the
  // bare race name (no RC2_ prefix), looked up via friendlyArg's RC2_
  // branch below.
  race2: {
    GOBLIN: "Goblin", KOBOLD: "Kobold", ORC: "Orc",
    GOLEM: "Golem", GUARDIAN: "Guardian", NINJA: "Ninja",
    SCARABA: "Scaraba", TURTLE: "Turtle",
    C_TOWER: "Clock Tower", BIO5: "Bio Lab 5",
    MANUK: "Manuk", SPLENDIDE: "Splendide", LUK: "Luk",
    GVG: "GvG Player", BATTLEFIELD: "Battleground",
  },
  element: {
    NEUTRAL: "Neutral", WATER: "Water", EARTH: "Earth", FIRE: "Fire",
    WIND: "Wind", POISON: "Poison", HOLY: "Holy", DARK: "Shadow",
    GHOST: "Ghost", UNDEAD: "Undead", ALL: "All",
  },
  size: {
    SMALL: "Small", MEDIUM: "Medium", LARGE: "Large", ALL: "All",
  },
  class_: {
    NORMAL: "Normal", BOSS: "Boss", GUARDIAN: "Guardian", ALL: "All",
  },
  // Status effects: rAthena uses Eff_*, SC_*, EFST_* prefixes. After
  // stripping the prefix the key is looked up here. Add or override
  // entries in the YAML's status_effect: section.
  status_effect: {
    STUN: "Stunned", STONE: "Petrified", FREEZE: "Frozen",
    SLEEP: "Sleeping", CURSE: "Cursed", POISON: "Poisoned",
    SILENCE: "Silenced", CONFUSION: "Confused", BLIND: "Blinded",
    BLEEDING: "Bleeding", DPOISON: "Deadly Poison",
    BURNING: "Burning", FREEZING: "Freezing", HEAT: "Heated",
    DEEPSLEEP: "Deep Sleep", CRYSTALIZE: "Crystallized",
    HALLUCINATION: "Hallucinating", FEAR: "Feared",
    WHITEIMPRISON: "White Imprison",
  },
};

// Skill DB caches built by loadSkillDb() — populated from the host
// client's skillid.lub / skillinfolist.lub (or any files dropped next to
// the exe). When empty, friendlySkill() falls through to the raw arg.
const SKILL_ID_TO_AEGIS = new Map();   // 89 → "WZ_STORMGUST"
const SKILL_AEGIS_TO_NAME = new Map(); // "WZ_STORMGUST" → "Storm Gust"
const SKILL_AEGIS_TO_ID = new Map();   // "WZ_STORMGUST" → 89  (reverse lookup
                                       // for kRO calls like AddDamage_SKID
                                       // which require numeric skill IDs).
let SKILL_DB_SOURCE = "(none)";

// Bonuses whose first arg is a skill (ID or aegis name). Used to route
// the placeholder resolution through friendlySkill() instead of the
// generic friendlyArg().
const SKILL_ARG_BONUSES = new Set([
  "bskillatk", "bskillheal", "bskillheal2",
  "bskillusesp", "bskillusesprate",
  "bcastrate", "bfixedcastrate", "bvariablecastrate",
  "bskilldelay", "bskillcooldown",
  "bskillfixedcast", "bskillvariablecast",
  "baddskillblow", "bsubskill",
  "bautospell", "bautospellwhenhit",
  "baddeffonskill", "bautospellonskill",
]);

async function tryReadFile(path) {
  try {
    const txt = await Neutralino.filesystem.readFile(path);
    return txt;
  } catch {
    return null;
  }
}

async function loadBonusTemplates() {
  let yamlText = null;
  let sourceLabel = "(bundled)";
  const exeDir = (typeof NL_PATH === "string" && NL_PATH) ? NL_PATH : "";

  // 1) next to the exe
  if (exeDir && !yamlText) {
    const path = exeDir + "\\bonus_templates.yml";
    const txt = await tryReadFile(path);
    if (txt) { yamlText = txt; sourceLabel = path; }
  }
  // 2) <exe folder>\Resources\bonus_templates.yml
  if (exeDir && !yamlText) {
    const path = exeDir + "\\Resources\\bonus_templates.yml";
    const txt = await tryReadFile(path);
    if (txt) { yamlText = txt; sourceLabel = path; }
  }
  // 3) %LOCALAPPDATA%\RDL\Resources\bonus_templates.yml
  if (!yamlText) {
    try {
      const localAppData = await Neutralino.os.getEnv("LOCALAPPDATA");
      if (localAppData) {
        const path = localAppData + "\\RDL\\Resources\\bonus_templates.yml";
        const txt = await tryReadFile(path);
        if (txt) { yamlText = txt; sourceLabel = path; }
      }
    } catch {}
  }
  // 4) bundled fallback
  if (!yamlText) {
    try {
      const res = await fetch("bonus_templates.yml", { cache: "no-store" });
      if (res.ok) yamlText = await res.text();
    } catch {}
  }
  if (!yamlText) {
    log("Bonus templates: not found (descriptions will be skipped).");
    return;
  }
  try {
    const parsed = jsyaml.load(yamlText) || {};
    const lowered = {
      bonus1: {}, bonus1_special: {},
      bonus2: {}, bonus3: {}, bonus4: {}, bonus5: {},
      autobonus: {},
    };
    for (const sec of Object.keys(lowered)) {
      const src = parsed[sec] || {};
      for (const [k, v] of Object.entries(src)) {
        lowered[sec][k.toLowerCase()] = v;
      }
    }
    BONUS_TEMPLATES = lowered;
    TEMPLATE_SOURCE = sourceLabel;

    // Merge enum translation sections (race / element / size / class /
    // status_effect) into BONUS_TRANSLATIONS, keyed UPPERCASE so lookups
    // are case-insensitive. YAML overrides the built-in defaults.
    const sectionMap = {
      race: "race", race2: "race2", element: "element", size: "size",
      class: "class_", status_effect: "status_effect",
    };
    let mergedEnums = 0;
    for (const [yamlSec, jsSec] of Object.entries(sectionMap)) {
      const src = parsed[yamlSec];
      if (!src || typeof src !== "object") continue;
      if (!BONUS_TRANSLATIONS[jsSec]) BONUS_TRANSLATIONS[jsSec] = {};
      for (const [k, v] of Object.entries(src)) {
        BONUS_TRANSLATIONS[jsSec][String(k).toUpperCase()] = String(v);
        mergedEnums++;
      }
    }

    const counts = ["bonus1", "bonus2", "bonus3", "bonus4", "bonus5"]
      .map(s => `${Object.keys(lowered[s]).length} ${s}`)
      .join(" / ");
    log(`Bonus templates: loaded ${counts} from ${sourceLabel}`);
    if (mergedEnums) log(`Bonus templates: merged ${mergedEnums} enum translation(s).`);
  } catch (e) {
    log("Bonus templates: parse error - " + (e.message || e));
  }
}

// ---------------------------------------------------------------------------
// Skill DB loader
//
// Resolves skill IDs / aegis names to display names for descriptions like
// "bSkillAtk, 'WZ_STORMGUST', 30" → "Storm Gust damage increased by 30%".
// Looks for two files:
//   skillid             — `SKID = { NV_BASIC = 1, ... }` (aegis → id)
//   skillinfolist...    — `[SKID.X] = { SkillName = "...", ... }`
// Search paths, first hit wins:
//   1) sibling of source .lub:  <srcDir>\..\skillinfoz\skillid.lub
//   2) <exe>\skillid              (with/without .lub/.lua extension)
//   3) <exe>\skill_db\skillid
// ---------------------------------------------------------------------------
async function findFirstReadable(paths) {
  for (const p of paths) {
    const t = await tryReadFile(p);
    if (t) return { path: p, text: t };
  }
  return null;
}

function parseSkillIdLub(text) {
  // Matches `<AEGIS_NAME> = <NUM>` lines inside the SKID table.
  const re = /^\s*(\w+)\s*=\s*(\d+)\s*,?\s*$/gm;
  let m, count = 0;
  while ((m = re.exec(text)) !== null) {
    const aegis = m[1].toUpperCase();
    if (aegis === "SKID") continue;
    const id = parseInt(m[2], 10);
    SKILL_ID_TO_AEGIS.set(id, aegis);
    SKILL_AEGIS_TO_ID.set(aegis, id);
    count++;
  }
  return count;
}

function parseSkillInfoListLub(text) {
  // Matches `[SKID.<AEGIS>] = { ... SkillName = "<Name>" ... }`. Tracks
  // brace depth so nested tables (SkillScale etc.) don't confuse us.
  const re = /\[\s*SKID\.(\w+)\s*\]\s*=\s*\{/g;
  let m, count = 0;
  while ((m = re.exec(text)) !== null) {
    const aegis = m[1].toUpperCase();
    // Walk forward to find the closing brace of this block.
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = text.slice(re.lastIndex, i - 1);
    const nameMatch = /SkillName\s*=\s*"([^"]+)"/.exec(body);
    if (nameMatch) {
      SKILL_AEGIS_TO_NAME.set(aegis, nameMatch[1]);
      count++;
    }
  }
  return count;
}

async function loadSkillDb(srcLubPath) {
  SKILL_ID_TO_AEGIS.clear();
  SKILL_AEGIS_TO_NAME.clear();
  SKILL_AEGIS_TO_ID.clear();
  SKILL_DB_SOURCE = "(none)";

  const exeDir = (typeof NL_PATH === "string" && NL_PATH) ? NL_PATH : "";
  const idCandidates = [];
  const listCandidates = [];

  if (srcLubPath) {
    // Walk up two directories from the .lub to reach `lua files\`, then
    // dive into `skillinfoz\`. Use whichever slash style the source uses.
    const sep = srcLubPath.includes("\\") ? "\\" : "/";
    const parts = srcLubPath.split(/[\\\/]/);
    // .../lua files/EquipmentProperties/EquipmentProperties.lub  → parent: lua files
    if (parts.length >= 2) {
      const grandparent = parts.slice(0, -2).join(sep);
      for (const fname of ["skillid.lub", "SkillId.lub", "skillid.lua", "skillid"]) {
        idCandidates.push(grandparent + sep + "skillinfoz" + sep + fname);
      }
      for (const fname of ["skillinfolist.lub", "SkillInfoList.lub", "skillinfolist.lua", "skillinfolist"]) {
        listCandidates.push(grandparent + sep + "skillinfoz" + sep + fname);
      }
    }
  }
  for (const dir of [exeDir, exeDir ? exeDir + "\\skill_db" : ""]) {
    if (!dir) continue;
    for (const fname of ["skillid.lub", "skillid.lua", "skillid"]) {
      idCandidates.push(dir + "\\" + fname);
    }
    for (const fname of ["skillinfolist.lub", "skillinfolist.lua", "skillinfolist and name", "skillinfolist"]) {
      listCandidates.push(dir + "\\" + fname);
    }
  }

  // Last-resort: bundled templates inside resources.neu. Loaded only if no
  // local file was found — the user's own `skillid.lub` / `skillinfolist.lub`
  // (whatever's installed with their client) always wins so they stay
  // in sync with their patches.
  async function fetchBundled(name) {
    try {
      const res = await fetch(name, { cache: "no-store" });
      if (res.ok) return { path: "(bundled) " + name, text: await res.text() };
    } catch {}
    return null;
  }

  let idHit = await findFirstReadable(idCandidates);
  if (!idHit) idHit = await fetchBundled("skillid.template.lub");
  if (!idHit) {
    log("Skill DB: not found (skill names won't be resolved in descriptions).");
    return;
  }
  const idCount = parseSkillIdLub(idHit.text);

  let listHit = await findFirstReadable(listCandidates);
  if (!listHit) listHit = await fetchBundled("skillinfolist.template.lub");
  const nameCount = listHit ? parseSkillInfoListLub(listHit.text) : 0;

  SKILL_DB_SOURCE = idHit.path + (listHit ? " + " + listHit.path : " (names not found)");
  log(`Skill DB: ${idCount} ID(s), ${nameCount} name(s) loaded from ${SKILL_DB_SOURCE}`);
}

function friendlySkill(raw) {
  const s = String(raw || "").trim().replace(/^"|"$/g, "");
  if (/^\d+$/.test(s)) {
    const aegis = SKILL_ID_TO_AEGIS.get(parseInt(s, 10));
    if (aegis) {
      const name = SKILL_AEGIS_TO_NAME.get(aegis);
      return name || cap(aegis.replace(/_/g, " "));
    }
    return raw;
  }
  const aegis = s.replace(/^SKID\./i, "").toUpperCase();
  const name = SKILL_AEGIS_TO_NAME.get(aegis);
  if (name) return name;
  // Known aegis without a SkillName entry → titlecase the aegis for readability.
  if (SKILL_ID_TO_AEGIS.size && [...SKILL_ID_TO_AEGIS.values()].includes(aegis)) {
    return cap(aegis.replace(/_/g, " "));
  }
  return raw;
}

// Friendly enum-to-human name (used for the ARG/EFF placeholder in
// descriptions). Looks up the stripped-prefix key in BONUS_TRANSLATIONS;
// fall back to a titlecase of the key when the user hasn't translated it.
// All sections are editable from bonus_templates.yml.
function friendlyArg(raw) {
  const s = String(raw || "").trim().replace(/^"|"$/g, "");
  const n = s.toUpperCase();
  const lookup = (table, key) => (table && table[key]) || cap(key.replace(/_/g, " "));
  // Monster-race aliases (RC2_*) — checked before RC_ since the prefix is
  // a superset. The kRO client has no function for these; descriptions only.
  if (n.startsWith("RC2_"))   return lookup(BONUS_TRANSLATIONS.race2,         n.slice(4));
  if (n.startsWith("RC_"))    return lookup(BONUS_TRANSLATIONS.race,          n.slice(3));
  if (n.startsWith("ELE_"))   return lookup(BONUS_TRANSLATIONS.element,       n.slice(4));
  if (n.startsWith("SIZE_"))  return lookup(BONUS_TRANSLATIONS.size,          n.slice(5));
  if (n.startsWith("CLASS_")) return lookup(BONUS_TRANSLATIONS.class_,        n.slice(6));
  const effMatch = n.match(/^(EFF_|SC_|EFST_)(.+)$/);
  if (effMatch)               return lookup(BONUS_TRANSLATIONS.status_effect, effMatch[2]);
  // Battle-flag (BF_*) friendly names — used by bonus3 trigger args like
  // `bonus3 bSubEle,Ele_Water,30,BF_SHORT;` so the description reads
  // "(when hit by melee)" instead of "BF SHORT".
  const bfMatch = n.match(/^BF_(.+)$/);
  if (bfMatch) {
    const tag = bfMatch[1];
    const bf = {
      WEAPON: "by physical attack", MAGIC: "by magic", MISC: "by misc damage",
      SHORT: "by melee attack", LONG: "by ranged attack",
      NORMAL: "by normal attack", SKILL: "by skill",
    }[tag];
    return bf || cap(tag.replace(/_/g, " "));
  }
  return raw;
}

// Format a single bonus line's description using the loaded templates.
// Returns a string or null if no template matches.
//
// Placeholders supported in templates:
//   V          first non-indexed value (last arg, raw)
//   PCT        V + "%"
//   ARG        friendly-resolved first arg (race / element / size / class /
//              status-effect / skill)
//   EFF, DUR   aliases for ARG / V respectively
//   V1..V5     raw positional args (1-indexed)
//   ARG1..ARG5 friendly-resolved positional args (skill-aware for arg1
//              when the bonus is in SKILL_ARG_BONUSES)
function formatBonusDescription(nameLc, args) {
  const isSkillBonus = SKILL_ARG_BONUSES.has(nameLc);
  const friendlyAt = (i) => {
    if (args[i] === undefined) return "";
    if (isSkillBonus && i === 0) return friendlySkill(args[0]);
    return friendlyArg(args[i]);
  };
  const rawAt = (i) => args[i] !== undefined ? String(args[i]) : "";

  const sub = (tpl, useArgs) => {
    const localArgs = useArgs || args;
    const localFriendly = (i) => {
      if (localArgs[i] === undefined) return "";
      if (isSkillBonus && i === 0) return friendlySkill(localArgs[0]);
      return friendlyArg(localArgs[i]);
    };
    const localRaw = (i) => localArgs[i] !== undefined ? String(localArgs[i]) : "";
    const lastIdx = Math.max(0, localArgs.length - 1);
    // Division placeholders: `{V/N}` and `{V<idx>/N}` divide the arg by N
    // and emit a trimmed numeric result. Useful for bonuses whose script
    // value is in 1/100% units (bAddEff = 2000 → "20%") or 1/10% units
    // (bAutoSpell = 50 → "5%"). N can be any positive integer.
    const div = (val, n) => {
      const num = Number(val);
      if (!Number.isFinite(num) || !n) return String(val);
      const out = num / n;
      return String(Number(out.toFixed(4))).replace(/\.?0+$/, "");
    };
    return tpl
      // Indexed division: `{V1/100}`, `{V2/10}`, etc. (1-indexed args)
      .replace(/\{V([1-5])\/(\d+)\}/g, (_, n, d) => div(localRaw(parseInt(n, 10) - 1), parseInt(d, 10)))
      // Last-arg division: `{V/100}`, `{V/10}`, etc.
      .replace(/\{V\/(\d+)\}/g, (_, d) => div(localRaw(lastIdx), parseInt(d, 10)))
      // Indexed placeholders first (longer match wins under \b boundaries).
      .replace(/\bARG([1-5])\b/g, (_, n) => localFriendly(parseInt(n, 10) - 1))
      .replace(/\bV([1-5])\b/g,   (_, n) => localRaw(parseInt(n, 10) - 1))
      // Aliases
      .replace(/\bPCT\b/g, localRaw(lastIdx) + "%")
      .replace(/\bARG\b/g, localFriendly(0))
      .replace(/\bEFF\b/g, localFriendly(0))
      .replace(/\bDUR\b/g, localRaw(lastIdx))
      .replace(/\bV\b/g,   localRaw(lastIdx));
  };

  // ---- 0-arg bonuses (flag-style: bUnstripable, bNoKnockback, etc.) ----
  if (args.length === 0) {
    const plain = BONUS_TEMPLATES.bonus1[nameLc] || BONUS_TEMPLATES.bonus1_special[nameLc];
    return plain || null;
  }

  // ---- 1-arg bonuses ----
  if (args.length === 1) {
    const rawV = args[0];
    const num = Number(rawV);
    if (Number.isFinite(num)) {
      // Sign-aware phrasing (_pos/_neg) — V is the absolute value.
      const signKey = nameLc + (num < 0 ? "_neg" : "_pos");
      const signSpec = BONUS_TEMPLATES.bonus1_special[signKey];
      if (signSpec) return sub(signSpec, [String(Math.abs(num))]);
      // Numeric-value suffix (e.g., bNoRegen_1 / bNoRegen_2)
      const numKey = nameLc + "_" + num;
      const numSpec = BONUS_TEMPLATES.bonus1_special[numKey];
      if (numSpec) return numSpec;
    }
    const special = BONUS_TEMPLATES.bonus1_special[nameLc];
    if (special) return sub(special);
    const plain = BONUS_TEMPLATES.bonus1[nameLc];
    if (plain) return sub(plain);
    return null;
  }

  // ---- 2-arg bonuses ----
  if (args.length === 2) {
    const num = Number(args[1]);
    if (Number.isFinite(num)) {
      // Sign-aware phrasing on bonus2 (e.g. bSubEle_pos / bSubEle_neg)
      const signKey = nameLc + (num < 0 ? "_neg" : "_pos");
      const signSpec = BONUS_TEMPLATES.bonus2[signKey];
      if (signSpec) return sub(signSpec, [args[0], String(Math.abs(num))]);
    }
    const plain = BONUS_TEMPLATES.bonus2[nameLc];
    if (plain) return sub(plain);
    return null;
  }

  // ---- 3-arg bonuses ----
  if (args.length === 3) {
    const plain = BONUS_TEMPLATES.bonus3[nameLc];
    if (plain) return sub(plain);
    // Partial fallback: degrade to bonus2 phrasing (ARG=first, V=last)
    const fallback = BONUS_TEMPLATES.bonus2[nameLc];
    if (fallback) return sub(fallback, [args[0], args[args.length - 1]]);
    return null;
  }

  // ---- 4-arg bonuses ----
  if (args.length === 4) {
    const plain = BONUS_TEMPLATES.bonus4[nameLc];
    if (plain) return sub(plain);
    const fb3 = BONUS_TEMPLATES.bonus3[nameLc];
    if (fb3) return sub(fb3, args.slice(0, 3));
    const fb2 = BONUS_TEMPLATES.bonus2[nameLc];
    if (fb2) return sub(fb2, [args[0], args[args.length - 1]]);
    return null;
  }

  // ---- 5-arg bonuses ----
  if (args.length === 5) {
    const plain = BONUS_TEMPLATES.bonus5[nameLc];
    if (plain) return sub(plain);
    const fb4 = BONUS_TEMPLATES.bonus4[nameLc];
    if (fb4) return sub(fb4, args.slice(0, 4));
    const fb3 = BONUS_TEMPLATES.bonus3[nameLc];
    if (fb3) return sub(fb3, args.slice(0, 3));
    const fb2 = BONUS_TEMPLATES.bonus2[nameLc];
    if (fb2) return sub(fb2, [args[0], args[args.length - 1]]);
    return null;
  }

  return null;
}

// Server-script idioms that have no client-side equivalent. We drop these
// silently instead of emitting `-- TODO: ...` so the resulting OnStartEquip
// block contains only meaningful description comments and emitted Lua calls.
// Examples covered:
//   `.@r = getrefine();`         — temp-var assignment
//   `if (.@r > 5) {`             — control flow opener
//   `} else {` / `} else if (..)` etc.
//   `}` / `);`                   — block closers
//   `set .@x, 1;`                — old rAthena `set` form
//   `callfunc "F", arg;`         — server-side function calls
const SCRIPT_NOISE_RE = new RegExp(
  "^\\s*(?:" +
    "\\.@\\w+\\s*=" +                                // .@var = ...
    "|set\\s+\\.@" +                                  // set .@var, ...
    "|if\\s*\\(|else\\b|while\\s*\\(|for\\s*\\(" +   // control flow
    "|callfunc\\b|callsub\\b|specialeffect\\b" +     // ignored server calls
    "|sc_start\\b|getmapxy\\b|getitemname\\b" +
    "|\\}\\s*(?:else\\b|;|,|\\)|$)" +                // closers
    "|\\)\\s*;?\\s*$" +
  ")"
);

// Substitute `.@varname` references with their assigned expressions so the
// description text reads naturally. Replaces server-only function calls
// (`getrefine()`, etc.) with friendly placeholders so the tooltip-style
// comment is readable instead of containing raw script syntax.
function prettifyServerExpr(s) {
  return String(s)
    .replace(/\bgetrefine\s*\(\s*\)/gi,                "Refine")
    .replace(/\bgetequiprefinerycnt\s*\([^)]*\)/gi,    "Refine")
    .replace(/\bgetequiprefine\s*\([^)]*\)/gi,         "Refine")
    .replace(/\breadparam\s*\(\s*bint\s*\)/gi,         "Int")
    .replace(/\breadparam\s*\(\s*bstr\s*\)/gi,         "Str")
    .replace(/\breadparam\s*\(\s*bagi\s*\)/gi,         "Agi")
    .replace(/\breadparam\s*\(\s*bvit\s*\)/gi,         "Vit")
    .replace(/\breadparam\s*\(\s*bdex\s*\)/gi,         "Dex")
    .replace(/\breadparam\s*\(\s*bluk\s*\)/gi,         "Luk");
}

function inlineScriptVariables(script) {
  const lines = script.split(/\r?\n/);
  const assigns = new Map();
  const ASSIGN_RE = /^\s*\.\@(\w+)\s*=\s*([^;]+);\s*$/;
  const subVars = (text) => text.replace(/\.\@(\w+)/g, (m, name) =>
    assigns.has(name) ? assigns.get(name) : m);
  const out = [];
  for (const line of lines) {
    const m = ASSIGN_RE.exec(line);
    if (m) {
      const name = m[1];
      let expr = prettifyServerExpr(subVars(m[2].trim()));
      assigns.set(name, expr);
      continue;
    }
    out.push(prettifyServerExpr(subVars(line)));
  }
  return out.join("\n");
}

// ===========================================================================
// Refine-aware script translation
// ===========================================================================
//
// rAthena/Hercules scripts that depend on the equipment's refine level need
// to emit refine-aware Lua at equip time (using GetRefineLevel(GetLocation())).
// `inlineScriptVariables()` above only handles pure-numeric inline expansion;
// any `.@r = getrefine();` reference would be substituted with the literal
// text "Refine" and then dropped by the dynamic-expression guard, so the
// bonus value silently fell through as the base literal (or as a TODO).
//
// `translateScriptRefineAware()` is invoked from `translateScript()` whenever
// the source script references `getrefine()`. It parses the script into a
// statement tree (assign / compound / bonus / if-block / todo), then emits a
// refine-aware Lua block prefixed with `local r = GetRefineLevel(GetLocation())`.
//
// Patterns supported:
//   1. `.@r = getrefine();` followed by `bonus bX, .@r;` / `.@r * N` / etc.
//   2. `if (getrefine()/.@r >= N) bonus bX, V;` threshold gates (one-line)
//   3. `if (.@r >= N) { bonus ...; bonus ...; }` multi-line threshold blocks
//   4. `.@a = base; if (.@r >= N) .@a += K; ... bonus bX, .@a;` accumulators
//   5. Inline `bonus bX, getrefine() * N;` / `getrefine() / N;` / mixed
//   6. Ternary `bonus bX, (getrefine() >= N) ? V1 : V2;`
//   7. Base + multiplier `bonus bX, base + (.@r * N);`
//   8. C-style `cond ? a : b` is rewritten to Lua `(cond and a or b)`.
//   9. `&&` / `||` / `!=` are rewritten to Lua `and` / `or` / `~=`.
//
// Non-refine bonus calls in the same script (e.g. `bonus bStr, 5`) keep their
// existing translation; only the refine-dependent parts are wrapped in `r`-
// aware logic.
// ===========================================================================

const REFINE_CALL_RE   = /\b(?:getrefine|getequiprefinerycnt|getequiprefine)\s*\([^)]*\)/i;
const REFINE_CALL_RE_G = /\b(?:getrefine|getequiprefinerycnt|getequiprefine)\s*\([^)]*\)/gi;
const SERVER_ONLY_RE   = /\b(BaseLevel|JobLevel|readparam|getskilllv|getbrokenid|getmercinfo|getpartymember|countitem|rand\b)/i;

// rAthena Job_X name -> kRO client job ID (used by GetPureJob / get(19)).
// IDs match the kRO numbering (PCIds.lub) — NOT the rAthena server numbering
// where Taekwon/SoulLinker/StarGladiator are 23/24/25. The kRO client uses
// 24/25 for Gunslinger/Ninja and 4046/4047/4049 for Taekwon/StarGlad/SLinker.
const JOB_NAME_TO_ID = {
  Job_Novice: 0, Job_Swordman: 1, Job_Swordsman: 1, Job_Mage: 2,
  Job_Archer: 3, Job_Acolyte: 4, Job_Merchant: 5, Job_Thief: 6,
  Job_Knight: 7, Job_Priest: 8, Job_Wizard: 9, Job_Blacksmith: 10,
  Job_Hunter: 11, Job_Assassin: 12, Job_Crusader: 14,
  Job_Monk: 15, Job_Sage: 16, Job_Rogue: 17, Job_Alchemist: 18,
  Job_Bard: 19, Job_Dancer: 20,
  Job_Gunslinger: 24, Job_Ninja: 25,
  // Taekwon line — kRO client IDs (NOT rAthena's 23/24/25).
  Job_Taekwon: 4046, Job_Star_Gladiator: 4047, Job_Soul_Linker: 4049,
  Job_StarGladiator: 4047, Job_SoulLinker: 4049,
  // Trans (4xxx) class IDs
  Job_Lord_Knight: 4008, Job_High_Priest: 4009, Job_High_Wizard: 4010,
  Job_Whitesmith: 4011, Job_Sniper: 4012, Job_Assassin_Cross: 4013,
  Job_Paladin: 4014, Job_Champion: 4015, Job_Professor: 4016,
  Job_Stalker: 4017, Job_Creator: 4018, Job_Clown: 4019, Job_Gypsy: 4020,
  // 3rd jobs (4054+)
  Job_Rune_Knight: 4054, Job_Warlock: 4055, Job_Ranger: 4056,
  Job_Arch_Bishop: 4057, Job_Mechanic: 4058, Job_Guillotine_Cross: 4059,
  Job_Royal_Guard: 4066, Job_Sorcerer: 4064, Job_Minstrel: 4071,
  Job_Wanderer: 4063, Job_Sura: 4065, Job_Genetic: 4068, Job_Shadow_Chaser: 4072,
  // 4th jobs / expanded
  Job_Star_Emperor: 4239, Job_Soul_Reaper: 4240,
  Job_Dragon_Knight: 4252,
};

// Full kRO client variant IDs for each Job_X. Used by translateClassConditional
// so `Class == Job_Soul_Linker` matches BASE Soul Linker (4049), Baby SL
// (4227), and Soul Reaper (4240) — not just the single base ID. Also used
// for `BaseJob == Job_Knight` to cover the whole Knight tree (Knight, Lord
// Knight, Rune Knight, Royal Guard, Dragon Knight, baby/mounted variants, …).
// Pulled from JobInfo/PCIds.lub on a modern Project 255-style kRO client.
const CLASS_TREE_DESCENDANTS = {
  // Knight branch (Swordman → Knight → Lord Knight → Rune Knight → Dragon Knight)
  Job_Knight:         [7, 13, 4008, 4014, 4030, 4036, 4054, 4060, 4066, 4073,
                       4080, 4081, 4082, 4083, 4088, 4089, 4090, 4091, 4092,
                       4093, 4094, 4095, 4096, 4102, 4109, 4110, 4252, 4265, 4280],
  Job_Crusader:       [14, 4014, 4066, 4073, 4082, 4083, 4102, 4110],
  Job_Lord_Knight:    [4008, 4014, 4054, 4060, 4080, 4081, 4088, 4089, 4090,
                       4091, 4092, 4093, 4094, 4095, 4096, 4109, 4252, 4265, 4280],
  Job_Rune_Knight:    [4054, 4060, 4080, 4081, 4088, 4089, 4090, 4091, 4092,
                       4093, 4094, 4095, 4096, 4109, 4252, 4265, 4280],
  // Taekwon branch (Taekwon → Star Gladiator / Soul Linker → Star Emperor / Soul Reaper)
  Job_Taekwon:        [4046, 4225],
  Job_Star_Gladiator: [4047, 4048, 4226, 4238, 4239, 4243],
  Job_StarGladiator:  [4047, 4048, 4226, 4238, 4239, 4243],
  Job_Soul_Linker:    [4049, 4227, 4240],
  Job_SoulLinker:     [4049, 4227, 4240],
  Job_Star_Emperor:   [4239, 4243],
  Job_Soul_Reaper:    [4240],
  // Gunslinger / Ninja branch
  Job_Gunslinger:     [24, 4215, 4228, 4229],         // + Rebellion, babies
  Job_Ninja:          [25, 4211, 4212, 4222, 4223, 4224], // + Kagerou, Oboro, babies
};

// Expand `BaseClass == Job_X` to the SPECIFIC class IDs of every descendant
// in that base class line — needed for the per-character `get(19)` check.
// `GetPureJob() == baseID` already covers all descendants on its own, but
// listing specific IDs makes the conditional match advanced (Trans/3rd/4th)
// classes whose base might differ across client builds.
const BASE_CLASS_DESCENDANTS = {
  1: [1, 7, 14, 4002, 4008, 4014, 4054, 4060, 4066, 4096, 4109, 4220, 4302], // Swordman line
  2: [2, 9, 16, 4003, 4010, 4016, 4055, 4064, 4078, 4071, 4097, 4110, 4221], // Mage line
  3: [3, 11, 19, 20, 4004, 4012, 4019, 4020, 4056, 4063, 4071, 4098, 4111],  // Archer line
  4: [4, 8, 15, 4005, 4009, 4015, 4057, 4065, 4099, 4112, 4223],             // Acolyte line
  5: [5, 10, 18, 4006, 4011, 4018, 4058, 4068, 4100, 4113, 4224],            // Merchant line
  6: [6, 12, 17, 4007, 4013, 4017, 4059, 4072, 4101, 4114, 4225],            // Thief line
};

// Translate an rAthena class-conditional expression into a client-Lua check
// using `get(19)` / `GetPureJob()`. Returns null if the expression isn't a
// recognised class conditional. Supports `||` chains.
function translateClassConditional(condInner) {
  const operands = condInner.split(/\s*\|\|\s*/).map(o => o.trim());
  const parts = [];
  for (let op of operands) {
    while (/^\(.+\)$/.test(op) && balanced(op.slice(1, -1))) op = op.slice(1, -1).trim();
    const m = /^(Class|BaseClass|BaseJob)\s*==\s*(Job_\w+)$/.exec(op);
    if (!m) return null;
    const kind = m[1];
    const jobName = m[2];
    const id = JOB_NAME_TO_ID[jobName];
    if (id === undefined) return null;
    const tree = CLASS_TREE_DESCENDANTS[jobName] || BASE_CLASS_DESCENDANTS[id] || [id];

    // Stock FreyjaRO pattern (verified against EquipmentProperties.lub.preforceoverride.bak):
    //   - GetPureJob() == <base id>     → matches the base class on a basic char
    //   - get(19) == <client variant>   → matches each advanced/baby/trans/4th variant
    // Combining both forms covers every character state — base chars use GetPureJob,
    // and advanced jobs (which may not have GetPureJob == base_id semantics)
    // are reached via get(19).
    const checks = new Set();
    if (kind === "BaseClass") {
      // Basic class check — primarily a GetPureJob() match. Also add get(19)
      // for each variant so the check still fires on transcendent/3rd/baby
      // characters whose GetPureJob() might not return the base id.
      checks.add(`GetPureJob() == ${id}`);
      for (const d of tree) checks.add(`get(19) == ${d}`);
    } else if (kind === "BaseJob") {
      // BaseJob branch — list every variant of this job tree explicitly via
      // get(19). Stock kRO does this same listing style (e.g. Knight tree).
      checks.add(`GetPureJob() == ${id}`);
      for (const d of tree) checks.add(`get(19) == ${d}`);
    } else {
      // Class == Job_X — exact current class. Use GetPureJob() for the base
      // id and get(19) for every variant.
      checks.add(`GetPureJob() == ${id}`);
      for (const d of tree) checks.add(`get(19) == ${d}`);
    }
    parts.push("(" + [...checks].join(" or ") + ")");
  }
  return parts.join(" or ");
}

function scriptUsesRefine(script) {
  return REFINE_CALL_RE.test(script || "");
}

function balanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") { d--; if (d < 0) return false; }
  }
  return d === 0;
}

function refineExprToLua(expr) {
  let s = String(expr || "").trim();
  while (/^\(.+\)$/.test(s) && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
  s = s.replace(REFINE_CALL_RE_G, "r");
  // Lua exponentiation is `^`, not `**` (rAthena/Hercules scripts use `**`).
  s = s.replace(/\*\*/g, "^");
  // Lua's min/max live under math.* — bare `min(...)` / `max(...)` would
  // reference a nil global at equip time and crash.
  s = s.replace(/(?<![\w.])min\s*\(/g, "math.min(");
  s = s.replace(/(?<![\w.])max\s*\(/g, "math.max(");
  return s;
}

// Find an innermost `(cond) ? a : b` and replace with `((cond) and (a) or (b))`.
function convertOneTernary(s) {
  let depth = 0, lastQuestion = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "?" && depth === 0) lastQuestion = i;
  }
  if (lastQuestion < 0) return s;
  let j = lastQuestion - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  if (s[j] !== ")") return s;
  let d = 1, k = j - 1;
  while (k >= 0 && d > 0) {
    if (s[k] === ")") d++;
    else if (s[k] === "(") d--;
    if (d === 0) break;
    k--;
  }
  if (k < 0) return s;
  const cond = s.slice(k + 1, j);
  let d2 = 0, colon = -1;
  for (let p = lastQuestion + 1; p < s.length; p++) {
    const c = s[p];
    if (c === "(") d2++;
    else if (c === ")") d2--;
    else if (c === "?" && d2 === 0) return s; // nested unparenthesised -- bail
    else if (c === ":" && d2 === 0) { colon = p; break; }
  }
  if (colon < 0) return s;
  let d3 = 0, endB = s.length;
  for (let p = colon + 1; p < s.length; p++) {
    const c = s[p];
    if (c === "(") d3++;
    else if (c === ")") { if (d3 === 0) { endB = p; break; } d3--; }
    else if (c === "," && d3 === 0) { endB = p; break; }
  }
  const a = s.slice(lastQuestion + 1, colon).trim();
  const b = s.slice(colon + 1, endB).trim();
  return s.slice(0, k) + `((${cond}) and (${a}) or (${b}))` + s.slice(endB);
}

// Convert an rAthena expression to a Lua-compatible scalar that uses `r`.
function exprToLua(expr, refineVars, numericVars) {
  let s = String(expr || "").trim();
  for (let pass = 0; pass < 5 && /\.@/.test(s); pass++) {
    s = s.replace(/\.@(\w+)/g, (m, name) => {
      if (refineVars.has(name))  return `(${refineVars.get(name)})`;
      if (numericVars && numericVars.has(name)) return numericVars.get(name);
      return m;
    });
  }
  if (/\.@/.test(s)) return { lua: null, usesR: false };
  if (SERVER_ONLY_RE.test(s)) return { lua: null, usesR: false };
  const hasRefine = REFINE_CALL_RE.test(s);
  let lua = refineExprToLua(s);
  lua = lua.replace(/&&/g, " and ").replace(/\|\|/g, " or ")
           .replace(/!=/g, "~=").replace(/;\s*$/, "");
  while (/\?/.test(lua)) {
    const conv = convertOneTernary(lua);
    if (conv === lua) break;
    lua = conv;
  }
  if (/\?/.test(lua)) return { lua: null, usesR: hasRefine };
  if (hasRefine && /\//.test(lua) && !/math\.floor/.test(lua)) {
    lua = `math.floor(${lua})`;
  }
  return { lua: lua.trim(), usesR: hasRefine };
}

function parseBonusLine(raw) {
  raw = normaliseHerculesBonusLine(raw);
  const m = BONUS_LINE_RE.exec(raw);
  if (!m) return null;
  return { bname: m[2].toLowerCase(), args: splitArgs(m[3] || ""), raw: raw.trim() };
}

function emitBonusCallWithValue(bname, args, valueExpr) {
  const a = args.slice();
  a[a.length - 1] = "__VALUE__";
  const t = BONUS_TRANSLATORS[bname];
  if (!t) return null;
  const result = t(bname, a);
  if (result == null) return null;
  const lines = Array.isArray(result) ? result : [result];
  return lines.map(l => l.replace(/__VALUE__/g, valueExpr));
}

function sanitizeIdent(name) {
  let s = String(name || "a").replace(/[^A-Za-z0-9_]/g, "_") || "a";
  if (s === "r") s = "value";
  return s;
}

const REFINE_PRIMARY_NAMES = ["a", "b", "c", "d", "e", "f"];

const ASSIGN_RE_R    = /^\s*\.@(\w+)\s*=\s*([^;]+)$/;
const COMP_ASSIGN_RE = /^\s*\.@(\w+)\s*([+\-*/])=\s*([^;]+)$/;
const IF_REFINE_COND_RE = /^\s*(?:getrefine\s*\(\s*\)|\.@(\w+))\s*(>=|>|==|<=|<)\s*(\d+)\s*$/i;
const TERN_RE = /^\(\s*(?:getrefine\s*\(\s*\)|\.@(\w+))\s*(>=|>|==|<=|<)\s*(\d+)\s*\)\s*\?\s*([^:]+):\s*(.+)$/;

// Tokenise a script into a statement tree.
// Translate an rAthena status-effect identifier (SC_X / EFST_X / Eff_X) into
// a friendly name via BONUS_TRANSLATIONS.status_effect. Returns the raw
// identifier if no translation exists.
function friendlyStatusEffect(raw) {
  const s = String(raw || "").trim().replace(/^"|"$/g, "");
  const m = s.match(/^(EFF_|SC_|EFST_)(.+)$/i);
  const key = (m ? m[2] : s).toUpperCase();
  const table = (BONUS_TRANSLATIONS && BONUS_TRANSLATIONS.status_effect) || {};
  return table[key] || cap(key.replace(/_/g, " "));
}

// Best-effort friendly descriptions for non-bonus rAthena script commands.
// The kRO equipment-tooltip Lua has no equivalent for status applications,
// hat effects, autobonus procs, heals etc., so we render them as `--` lines
// so the player still sees the effect listed instead of an opaque TODO.
//
// Return shape:
//   - string  → single `-- description` line (most commands)
//   - array   → multi-line emission; entries that don't start with `--` are
//               emitted as Lua calls, comments as-is. Used for `skill X,N`
//               which needs both an EnableSkill() call AND a description
//               line in the OnStartEquip block.
//   - null    → unrecognised; caller falls back to `-- TODO:`.
function describeNonBonusCommand(raw) {
  const text = String(raw || "").trim().replace(/;\s*$/, "");

  // skill SkillName, Lv;  → kRO `EnableSkill(<skill_id>, <lv>)` + description.
  // Matches the stock FreyjaRO format for skill-grant cards (e.g. Marine
  // Sphere → `EnableSkill(7, 3)`). If we can't resolve the aegis to a
  // numeric ID we skip the call (still emit the description so the player
  // at least sees what the card is supposed to do).
  let m = /^skill\s+([A-Za-z_]\w*)\s*,\s*(\d+)\b/i.exec(text);
  if (m) {
    const aegis = m[1];
    const lv = m[2];
    const skillId = resolveSkillId(aegis);
    const desc = `-- Enable to use Level ${lv} of ${friendlySkill(aegis)}`;
    if (skillId != null) return [`EnableSkill(${skillId}, ${lv})`, desc];
    return [desc];
  }

  // heal HP, SP;  →  "Restores N HP." / "Restores N SP." / both
  m = /^heal\s+(-?\d+)\s*,\s*(-?\d+)\b/i.exec(text);
  if (m) {
    const hp = parseInt(m[1], 10), sp = parseInt(m[2], 10);
    const parts = [];
    if (hp) parts.push(`${Math.abs(hp)} HP`);
    if (sp) parts.push(`${Math.abs(sp)} SP`);
    if (!parts.length) return null;
    const verb = (hp < 0 || sp < 0) ? "Drains" : "Restores";
    return `${verb} ${parts.join(" and ")}.`;
  }

  // hateffect(EF_X, true);  →  "Adds visual effect: <EF_X>."
  m = /^hateffect\s*\(\s*([A-Za-z_]\w*)/i.exec(text);
  if (m) return `Adds visual effect: ${cap(m[1].replace(/^(HAT_EF_|EF_|FOOTPRINT_EF_)/i, "").replace(/_/g, " "))}.`;

  // sc_start / sc_start2 / sc_start4 SC_X, duration_ms, val, ...
  m = /^sc_start(?:2|4)?\s+([A-Za-z_]\w*)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i.exec(text);
  if (m) {
    const eff = friendlyStatusEffect(m[1]);
    const durMs = parseInt(m[2], 10);
    const val = parseInt(m[3], 10);
    const dur = durMs >= 1000 ? `${Math.round(durMs / 1000)}s` : `${durMs}ms`;
    if (val && val !== 1) return `Inflicts ${eff} (lv ${val}) for ${dur}.`;
    return `Inflicts ${eff} for ${dur}.`;
  }

  // sc_end SC_X;  →  "Removes <Effect>."
  m = /^sc_end\s+([A-Za-z_]\w*)/i.exec(text);
  if (m) return `Removes ${friendlyStatusEffect(m[1])}.`;

  // autobonus / autobonus2 / autobonus3 "{ inner-script }", rate, dur, BF, ...
  //   autobonus    — chance on physical attack
  //   autobonus2   — chance when hit
  //   autobonus3   — chance when casting a specific skill
  // Translate the inner script with translateScript() so the actual effect
  // is listed, and prefix with the trigger condition + chance.
  m = /^(autobonus[23]?)\s*"((?:[^"\\]|\\.)*)"\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i.exec(text);
  if (m) {
    const kind = m[1].toLowerCase();
    const innerEsc = m[2];
    const rate = parseInt(m[3], 10);
    const durMs = parseInt(m[4], 10);
    const dur = durMs >= 1000 ? `${Math.round(durMs / 1000)}s` : `${durMs}ms`;
    const pct = (rate / 10).toFixed(rate % 10 ? 1 : 0);
    const trigger = kind === "autobonus2" ? "when hit"
                  : kind === "autobonus3" ? "on skill cast"
                  : "on attack";
    // Inner script is `{ bonus …; bonus2 …; }` — strip braces and unescape.
    const inner = innerEsc
      .replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      .replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "");
    const innerLines = (typeof translateScript === "function") ? translateScript(inner) : [];
    const effectComments = innerLines
      .filter(l => l.trim().startsWith("--") && !/^--\s*TODO/i.test(l.trim()))
      .map(l => l.trim().replace(/^--\s*/, "").replace(/\.\s*$/, ""));
    if (effectComments.length) {
      return `${pct}% chance ${trigger} for ${dur}: ${effectComments.join("; ")}.`;
    }
    return `${pct}% chance ${trigger} for ${dur} to trigger a bonus.`;
  }

  return null;
}

// Identifiers / tokens that exist only on the server-side script engine;
// emitting a Lua call that references one of these crashes the client
// tooltip parser ("unexpected symbol near '.'" for `.@var`, or an
// "attempt to perform arithmetic on global 'X' (nil)" runtime fault).
// Used by translateScript() / emitBonus() to gate the final emit.
//   \.@\w+        — rAthena temp-vars (`.@val`, `.@r`) left unresolved.
//   SKID\.\d      — `SKID.62` (digit after dot is a Lua parse error: in
//                    `SKID.62` Lua reads `.62` as the start of a number
//                    literal and then trips on the trailing context).
//   \?            — rAthena ternary `cond ? a : b`. Lua has no ternary —
//                    leaking one causes `')' expected near '?'`.
//   \b(Agi|Str|Vit|Int|Dex|Luk)\b — bare stat-name identifiers (rAthena
//                    server-only; the client doesn't expose these globals
//                    in the equipment tooltip context).
const DYNAMIC_EXPR_RE = /\b(JobLevel|BaseLevel|getrefine|getequiprefinerycnt|getequipid|getequipweaponlv|readparam|isequipped|Upper|Agi|Str|Vit|Int|Dex|Luk)\b|\.@\w+|SKID\.\d|\?/;

// Map rAthena equipment-slot constants used in getequiprefinerycnt(EQI_X)
// / getequipid(EQI_X) to human-readable names for description-only comments.
const EQI_SLOT_NAMES = {
  EQI_ACC_L:        "left accessory",
  EQI_ACC_R:        "right accessory",
  EQI_SHOES:        "shoes",
  EQI_GARMENT:      "garment",
  EQI_HEAD_LOW:     "low headgear",
  EQI_HEAD_MID:     "mid headgear",
  EQI_HEAD_TOP:     "upper headgear",
  EQI_ARMOR:        "armor",
  EQI_HAND_L:       "left hand (shield)",
  EQI_HAND_R:       "right hand (weapon)",
  EQI_COSTUME_HEAD_TOP: "costume upper headgear",
  EQI_COSTUME_HEAD_MID: "costume mid headgear",
  EQI_COSTUME_HEAD_LOW: "costume low headgear",
  EQI_COSTUME_GARMENT:  "costume garment",
};

// Param-name -> display label for `readparam(bX)` conditions.
const PARAM_NAME_FRIENDLY = {
  bstr: "STR", bagi: "AGI", bvit: "VIT",
  bint: "INT", bdex: "DEX", bluk: "LUK",
};

// Translate a common rAthena conditional expression (the part inside
// `if (...)`) into a friendly English description so emitIfStmt can render
// "Has X% chance to:" / "When STR ≥ 120:" headers instead of opaque TODOs.
// Returns null when no recognised pattern matches. Caller falls back to
// "-- TODO: ... (condition not translatable)".
function describeCondition(condInnerRaw) {
  let c = String(condInnerRaw || "").trim();
  while (/^\(.+\)$/.test(c) && balanced(c.slice(1, -1))) c = c.slice(1, -1).trim();

  // rand(N) < X  →  X/N% chance
  // rand(100) < X  →  X% chance
  let m = /^rand\s*\(\s*(\d+)\s*\)\s*([<>]=?|==)\s*(\d+)$/i.exec(c);
  if (m) {
    const denom = parseInt(m[1], 10);
    const op = m[2];
    const x = parseInt(m[3], 10);
    if (op === "<" || op === "<=") {
      const pct = denom === 100 ? `${x}` : (x * 100 / denom).toFixed(denom === 100 ? 0 : 1).replace(/\.0$/, "");
      return `Has ${pct}% chance to`;
    }
  }

  // rand(X) without comparison → single-arg shorthand, treat as 1/X chance
  m = /^rand\s*\(\s*(\d+)\s*\)$/i.exec(c);
  if (m) {
    const denom = parseInt(m[1], 10);
    const pct = (100 / denom).toFixed(denom <= 10 ? 0 : 1).replace(/\.0$/, "");
    return `Has ${pct}% chance to`;
  }

  // readparam(bSTR) >= N (and friends)
  m = /^readparam\s*\(\s*(b[a-z]+)\s*\)\s*(>=|>|<=|<|==)\s*(\d+)$/i.exec(c);
  if (m) {
    const stat = PARAM_NAME_FRIENDLY[m[1].toLowerCase()];
    if (stat) {
      const sym = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=" }[m[2]];
      return `When ${stat} ${sym} ${m[3]}`;
    }
  }

  // isequipped(itemId, ...) — list each item ID. We don't have item names
  // readily available, so the player at least sees which ID(s) are checked.
  m = /^isequipped\s*\(\s*([\d,\s]+)\s*\)$/i.exec(c);
  if (m) {
    const ids = m[1].split(/[,\s]+/).filter(Boolean);
    if (ids.length === 1) return `When equipped with item #${ids[0]}`;
    if (ids.length > 1)  return `When equipped with items ${ids.map(i => "#" + i).join(", ")}`;
  }

  // BaseLevel / JobLevel comparison
  m = /^(BaseLevel|JobLevel)\s*(>=|>|<=|<|==)\s*(\d+)$/i.exec(c);
  if (m) {
    const lvl = m[1].toLowerCase() === "baselevel" ? "Base Level" : "Job Level";
    const sym = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=" }[m[2]];
    return `When ${lvl} ${sym} ${m[3]}`;
  }

  // getequiprefinerycnt(EQI_X) op N — slot-specific refine check
  m = /^getequiprefinerycnt\s*\(\s*([A-Za-z_]\w*)\s*\)\s*(>=|>|<=|<|==)\s*(\d+)$/i.exec(c);
  if (m) {
    const slot = EQI_SLOT_NAMES[m[1].toUpperCase()] || m[1];
    const sym = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=" }[m[2]];
    return `When ${slot} refine ${sym} ${m[3]}`;
  }

  // getequipweaponlv(EQI_X) op N — weapon level check (lv1=dagger ... lv4=2H)
  m = /^getequipweaponlv\s*\(\s*([A-Za-z_]\w*)\s*\)\s*(>=|>|<=|<|==)\s*(\d+)$/i.exec(c);
  if (m) {
    const sym = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=" }[m[2]];
    return `When equipped weapon level ${sym} ${m[3]}`;
  }

  // Upper == 0 / 1 / 2 (0=normal, 1=trans, 2=baby)
  m = /^Upper\s*(==|!=)\s*(\d+)$/i.exec(c);
  if (m) {
    const kind = { 0: "Normal", 1: "Transcendent", 2: "Baby" }[parseInt(m[2], 10)] || `class group ${m[2]}`;
    return m[1] === "==" ? `When character is ${kind}` : `When character is not ${kind}`;
  }

  // Class==Job_X (or BaseJob/BaseClass) chained with ||. Even when one or
  // more job names aren't in JOB_NAME_TO_ID (so translateClassConditional
  // can't produce a runtime guard), produce a friendly "When class is X/Y"
  // header so the description block still reads meaningfully.
  const classChain = c.split(/\s*\|\|\s*/).map(o => {
    let s = o.trim();
    while (/^\(.+\)$/.test(s) && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
    const mm = /^(?:Class|BaseClass|BaseJob)\s*(==|!=)\s*Job_(\w+)$/i.exec(s);
    return mm ? { op: mm[1], name: mm[2] } : null;
  });
  if (classChain.length && classChain.every(Boolean)) {
    const friendly = classChain.map(p => p.name.replace(/_T$/i, " (Trans)").replace(/_/g, " "));
    const op = classChain[0].op;
    const verb = op === "==" ? "When class is" : "When class is not";
    return `${verb} ${friendly.join(" / ")}`;
  }

  // BaseJob==Job_X && Upper!=2 — combined check often used to exclude babies.
  m = /^BaseJob\s*==\s*Job_(\w+)\s*&&\s*Upper\s*!=\s*(\d+)$/i.exec(c);
  if (m) {
    const name = m[1].replace(/_/g, " ");
    const excl = { 1: "non-Trans", 2: "non-Baby" }[parseInt(m[2], 10)] || `Upper!=${m[2]}`;
    return `When class is ${name} (${excl})`;
  }

  // .@val/.@x comparison — a leftover server-side scalar comparison. We
  // can't render the value meaningfully but a placeholder is still better
  // than `(condition not translatable)`.
  m = /^\.@(\w+)\s*(>=|>|<=|<|==)\s*(-?\d+)$/i.exec(c);
  if (m) {
    const sym = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=" }[m[2]];
    return `When ${m[1]} ${sym} ${m[3]}`;
  }

  return null;
}

function tokenizeRefineScript(script) {
  script = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const n = script.length;
  let i = 0;

  function classify(text) {
    if (!text) return null;
    let m = COMP_ASSIGN_RE.exec(text);
    if (m) return { kind: "compound", name: m[1], op: m[2], expr: m[3].trim(), raw: text };
    m = ASSIGN_RE_R.exec(text);
    if (m) return { kind: "assign", name: m[1], expr: m[2].trim(), raw: text };
    const b = parseBonusLine(text + ";");
    if (b) return { kind: "bonus", bname: b.bname, args: b.args, raw: b.raw.replace(/;\s*$/, "") + ";" };
    if (/^\s*(?:skill\s|autobonus\b|specialeffect\b|sc_start\b|sc_end\b|heal\b|callfunc\b|callsub\b|hateffect\b|set\s+\.@)/i.test(text)) {
      const desc = describeNonBonusCommand(text);
      if (Array.isArray(desc)) return { kind: "multidesc", lines: desc, raw: text };
      if (desc) return { kind: "desc", desc, raw: text };
      return { kind: "todo", raw: text };
    }
    return { kind: "raw", raw: text };
  }

  function readStatement(stopOnOpenBrace) {
    let buf = "";
    let depth = 0;
    while (i < n) {
      const c = script[i];
      if (c === '"') {
        buf += c; i++;
        while (i < n && script[i] !== '"') {
          if (script[i] === "\\" && i + 1 < n) { buf += script[i] + script[i + 1]; i += 2; }
          else { buf += script[i]; i++; }
        }
        if (i < n) { buf += '"'; i++; }
        continue;
      }
      if (c === "(" || c === "[") { depth++; buf += c; i++; continue; }
      if (c === ")" || c === "]") { depth--; buf += c; i++; continue; }
      if (depth === 0 && c === ";") { i++; return buf.trim(); }
      if (depth === 0 && c === "{" && stopOnOpenBrace) return buf.trim();
      if (depth === 0 && c === "}") return buf.trim();
      buf += c; i++;
    }
    return buf.trim();
  }

  function parseIfHere() {
    // Caller has already verified script[i..] starts with `if (`.
    const head = script.slice(i, i + 6).match(/^if\s*\(/i)[0];
    i += head.length;
    let d = 1, cond = "";
    while (i < n && d > 0) {
      const c = script[i];
      if (c === "(") d++;
      else if (c === ")") { d--; if (d === 0) { i++; break; } }
      cond += c; i++;
    }
    while (i < n && /\s/.test(script[i])) i++;
    let ifBody = [];
    if (script[i] === "{") { i++; ifBody = parseBlock(true); }
    else if (/^if\s*\(/i.test(script.slice(i, i + 6))) {
      ifBody.push(parseIfHere());
    } else {
      const single = readStatement(false);
      const s = classify(single);
      if (s) ifBody.push(s);
    }
    while (i < n && /\s/.test(script[i])) i++;
    let elseBody = null;
    if (/^else\b/i.test(script.slice(i))) {
      i += 4;
      while (i < n && /\s/.test(script[i])) i++;
      if (script[i] === "{") { i++; elseBody = parseBlock(true); }
      else if (/^if\s*\(/i.test(script.slice(i, i + 6))) {
        // `else if (...)` — parse as a nested if so the body is structured,
        // not a raw multi-line blob that would emit untranslated script.
        elseBody = [parseIfHere()];
      } else {
        const single = readStatement(false);
        const s = classify(single);
        elseBody = s ? [s] : [];
      }
    }
    return { kind: "if", cond: cond.trim(), body: ifBody, elseBody, raw: `if (${cond.trim()})` };
  }

  function parseBlock(insideBlock) {
    const body = [];
    while (i < n) {
      while (i < n && /\s/.test(script[i])) i++;
      if (i >= n) break;
      if (script[i] === "}") { if (insideBlock) { i++; return body; } i++; continue; }
      if (script[i] === ";") { i++; continue; }
      if (/^if\s*\(/i.test(script.slice(i, i + 6))) {
        body.push(parseIfHere());
        continue;
      }
      const stmt = readStatement(false);
      const cls = classify(stmt);
      if (cls) body.push(cls);
    }
    return body;
  }

  return parseBlock(false);
}

function translateScriptRefineAware(script) {
  let stmts;
  try { stmts = tokenizeRefineScript(script); }
  catch (e) { return [`-- TODO: tokenise error: ${e.message}`]; }

  const refineVars = new Map();
  const numericVars = new Map();
  const accCandidates = new Map();

  function walkSweep(list) {
    for (const s of list) {
      if (s.kind === "assign") {
        if (REFINE_CALL_RE.test(s.expr) || /\.@\w+/.test(s.expr)) {
          let resolved = s.expr.replace(/\.@(\w+)/g, (mm, n) =>
            refineVars.has(n) ? `(${refineVars.get(n)})` : mm);
          refineVars.set(s.name, resolved);
        } else if (/^-?\d+$/.test(s.expr)) {
          numericVars.set(s.name, s.expr);
          accCandidates.set(s.name, { base: s.expr });
        }
      } else if (s.kind === "compound") {
        if (!accCandidates.has(s.name)) accCandidates.set(s.name, { base: "0" });
      } else if (s.kind === "if") {
        walkSweep(s.body || []);
        if (s.elseBody) walkSweep(s.elseBody);
      }
    }
  }
  walkSweep(stmts);

  const accUsed = new Set();
  function walkUse(list) {
    for (const s of list) {
      if (s.kind === "bonus") {
        const v = (s.args[s.args.length - 1] || "").trim();
        const accRef = /^\.@(\w+)$/.exec(v);
        if (accRef && accCandidates.has(accRef[1])) accUsed.add(accRef[1]);
      } else if (s.kind === "if") {
        walkUse(s.body || []);
        if (s.elseBody) walkUse(s.elseBody);
      }
    }
  }
  walkUse(stmts);

  const identForAcc = new Map();
  let counter = 0;
  const usedIdents = new Set(["r"]);
  for (const name of accUsed) {
    let ident = sanitizeIdent(name);
    while (usedIdents.has(ident)) {
      ident = REFINE_PRIMARY_NAMES[counter] || `v${counter}`;
      counter++;
    }
    usedIdents.add(ident);
    identForAcc.set(name, ident);
  }

  const accHasExplicitAssign = new Set();
  function walkExplicit(list) {
    for (const s of list) {
      if (s.kind === "assign" && accUsed.has(s.name)) accHasExplicitAssign.add(s.name);
      else if (s.kind === "if") {
        walkExplicit(s.body || []);
        if (s.elseBody) walkExplicit(s.elseBody);
      }
    }
  }
  walkExplicit(stmts);

  const out = [];
  const emittedAccBase = new Set();
  let usesR = false;

  for (const name of accUsed) {
    if (!accHasExplicitAssign.has(name)) {
      const ident = identForAcc.get(name);
      out.push(`local ${ident} = 0`);
      emittedAccBase.add(name);
    }
  }

  function emitBonus(s, indent) {
    indent = indent || "";
    // Translator gave up entirely (unknown bname / unsupported arg count) —
    // fall through to a description-only line so the bonus shows up in the
    // tooltip even if we can't emit a real call.
    const descFallback = () => {
      const desc = formatBonusDescription(s.bname, s.args);
      if (desc) out.push(indent + `-- ${desc}`);
      else      out.push(indent + `-- TODO: ${s.raw}`);
    };
    const valArg = (s.args[s.args.length - 1] || "").trim();
    const accRef = /^\.@(\w+)$/.exec(valArg);
    if (accRef && accUsed.has(accRef[1])) {
      const ident = identForAcc.get(accRef[1]);
      const calls = emitBonusCallWithValue(s.bname, s.args, ident);
      if (calls == null) { descFallback(); return; }
      const desc = formatBonusDescription(s.bname, s.args);
      if (desc) out.push(indent + `-- ${desc} (scales with refine)`);
      for (const c of calls) out.push(indent + c);
      return;
    }
    const tern = TERN_RE.exec(valArg);
    if (tern) {
      const refVarName = tern[1];
      const isRefineGuard = !refVarName || refineVars.has(refVarName);
      if (isRefineGuard) {
        const cmp = tern[2], threshold = tern[3];
        const s1 = exprToLua(tern[4].trim(), refineVars, numericVars);
        const s2 = exprToLua(tern[5].trim(), refineVars, numericVars);
        if (s1.lua != null && s2.lua != null) {
          const c1 = emitBonusCallWithValue(s.bname, s.args, s1.lua);
          const c2 = emitBonusCallWithValue(s.bname, s.args, s2.lua);
          if (c1 && c2) {
            const desc = formatBonusDescription(s.bname, s.args);
            if (desc) out.push(indent + `-- ${desc} (varies with refine)`);
            usesR = true;
            out.push(indent + `if r ${cmp} ${threshold} then`);
            for (const c of c1) out.push(indent + "  " + c);
            out.push(indent + `else`);
            for (const c of c2) out.push(indent + "  " + c);
            out.push(indent + `end`);
            return;
          }
        }
      }
    }
    const scalar = exprToLua(valArg, refineVars, numericVars);
    if (scalar.lua == null) {
      // Last arg isn't a numeric expression — could be a BF_* trigger flag
      // (bonus3 bSubEle, Ele_X, V, BF_X) or a server-only expression. Try
      // letting the translator run with the raw args (some translators
      // intentionally don't use the last arg, e.g. our bonus3 bSubEle
      // form that drops BF_X). If that also fails, emit description-only.
      const directResult = BONUS_TRANSLATORS[s.bname]
        ? BONUS_TRANSLATORS[s.bname](s.bname, s.args)
        : null;
      if (Array.isArray(directResult) || typeof directResult === "string") {
        const calls = Array.isArray(directResult) ? directResult : [directResult];
        const desc = formatBonusDescription(s.bname, s.args);
        if (desc) out.push(indent + `-- ${desc}`);
        else if (calls.length === 0) out.push(indent + `-- ${s.raw}`);
        // Drop the call if it embeds a dynamic expression we can't safely emit.
        const emittedJoined = calls.join(" ");
        if (DYNAMIC_EXPR_RE.test(emittedJoined)) return;
        for (const c of calls) out.push(indent + c);
        return;
      }
      descFallback();
      return;
    }
    const calls = emitBonusCallWithValue(s.bname, s.args, scalar.lua);
    if (calls == null) { descFallback(); return; }
    const desc = formatBonusDescription(s.bname, s.args);
    if (desc) out.push(indent + `-- ${desc}${scalar.usesR ? " (scales with refine)" : ""}`);
    if (scalar.usesR) usesR = true;
    for (const c of calls) out.push(indent + c);
  }

  function emitAccumulatorMutation(s, indent) {
    indent = indent || "";
    const ident = identForAcc.get(s.name);
    if (!ident) return;
    const dScalar = exprToLua(s.expr, refineVars, numericVars);
    if (dScalar.lua == null) { out.push(indent + `-- TODO: ${s.raw}`); return; }
    let mutator;
    if (s.op === "+")      mutator = `${ident} = ${ident} + ${dScalar.lua}`;
    else if (s.op === "-") mutator = `${ident} = ${ident} - ${dScalar.lua}`;
    else if (s.op === "*") mutator = `${ident} = ${ident} * ${dScalar.lua}`;
    else if (s.op === "/") mutator = `${ident} = math.floor(${ident} / ${dScalar.lua})`;
    else                   mutator = `${ident} = ${ident} + ${dScalar.lua}`;
    out.push(indent + mutator);
  }

  function emitAssignStmt(s, indent) {
    indent = indent || "";
    if (REFINE_CALL_RE.test(s.expr) || /\.@\w+/.test(s.expr)) return;
    if (accUsed.has(s.name) && !emittedAccBase.has(s.name)) {
      const ident = identForAcc.get(s.name);
      out.push(indent + `local ${ident} = ${s.expr}`);
      emittedAccBase.add(s.name);
    } else if (accUsed.has(s.name)) {
      const ident = identForAcc.get(s.name);
      out.push(indent + `${ident} = ${s.expr}`);
    }
  }

  function invertCmp(cmp) {
    return { ">=": "<", ">": "<=", "<": ">=", "<=": ">", "==": "~=", "~=": "==" }[cmp] || cmp;
  }

  function emitIfStmt(s, indent) {
    indent = indent || "";
    const cond = s.cond.trim();
    let condInner = cond;
    while (/^\(.+\)$/.test(condInner) && balanced(condInner.slice(1, -1))) {
      condInner = condInner.slice(1, -1).trim();
    }
    const refineCondM = IF_REFINE_COND_RE.exec(condInner);
    const isRefineGuard = refineCondM && (!refineCondM[1] || refineVars.has(refineCondM[1]));
    if (!isRefineGuard) {
      // Try to translate `Class==Job_X`, `BaseClass==Job_X`, `BaseJob==Job_X`
      // (and OR chains thereof) into client-Lua `get(19)` / `GetPureJob()`
      // checks so the bonus is conditional in the tooltip, not unconditional.
      const classCond = translateClassConditional(condInner);
      if (classCond) {
        const start = out.length;
        for (const inner of s.body) emitStatement(inner, indent + "\t");
        const captured = out.splice(start);
        if (captured.length === 0 && !s.elseBody) return;
        if (captured.length) {
          out.push(indent + `if ${classCond} then`);
          for (const c of captured) out.push(c);
          out.push(indent + `end`);
        }
        if (s.elseBody && s.elseBody.length) {
          const elseStart = out.length;
          for (const inner of s.elseBody) emitStatement(inner, indent + "\t");
          const elseCaptured = out.splice(elseStart);
          if (elseCaptured.length) {
            out.push(indent + `if not (${classCond}) then`);
            for (const c of elseCaptured) out.push(c);
            out.push(indent + `end`);
          }
        }
        return;
      }
      // Recognise common rAthena conditional shapes so we render a friendly
      // "When X:" comment header instead of an opaque `-- TODO:` blob. The
      // body still emits unconditionally — the client-side tooltip can't
      // actually gate the bonus on these runtime conditions, so the comment
      // documents the intent for the player.
      const header = describeCondition(condInner);
      if (header) {
        out.push(indent + `-- ${header}:`);
      } else {
        out.push(indent + `-- TODO: ${s.raw} (condition not translatable)`);
      }
      for (const inner of s.body) emitStatement(inner, indent);
      if (s.elseBody) {
        out.push(indent + `-- (else branch)`);
        for (const inner of s.elseBody) emitStatement(inner, indent);
      }
      return;
    }
    const cmp = refineCondM[2];
    const threshold = refineCondM[3];

    const start = out.length;
    for (const inner of s.body) emitStatement(inner, indent + "  ");
    const captured = out.splice(start);
    const realCalls = captured.filter(l => l.trim() && !l.trim().startsWith("--"));
    if (captured.length === 0) return;
    usesR = true;
    if (captured.length === 1 && realCalls.length === 1) {
      out.push(indent + `if r ${cmp} ${threshold} then ${captured[0].trim()} end`);
    } else {
      const leadingComments = [];
      while (captured.length && captured[0].trim().startsWith("--")) {
        leadingComments.push(captured.shift().trim());
      }
      if (leadingComments.length) {
        leadingComments[leadingComments.length - 1] += ` (refine ${cmp} ${threshold})`;
        for (const c of leadingComments) out.push(indent + c);
      } else {
        out.push(indent + `-- (refine ${cmp} ${threshold})`);
      }
      out.push(indent + `if r ${cmp} ${threshold} then`);
      for (const c of captured) out.push(c);
      out.push(indent + `end`);
    }
    if (s.elseBody && s.elseBody.length) {
      const elseStart = out.length;
      for (const inner of s.elseBody) emitStatement(inner, indent + "  ");
      const elseCaptured = out.splice(elseStart);
      if (elseCaptured.length) {
        const invCmp = invertCmp(cmp);
        out.push(indent + `if r ${invCmp} ${threshold} then`);
        for (const c of elseCaptured) out.push(c);
        out.push(indent + `end`);
      }
    }
  }

  function emitStatement(s, indent) {
    indent = indent || "";
    if (s.kind === "assign")        emitAssignStmt(s, indent);
    else if (s.kind === "compound") emitAccumulatorMutation(s, indent);
    else if (s.kind === "bonus")    emitBonus(s, indent);
    else if (s.kind === "if")       emitIfStmt(s, indent);
    else if (s.kind === "desc")     { out.push(indent + `-- ${String(s.desc).replace(/\s*\r?\n\s*/g, " ")}`); }
    else if (s.kind === "multidesc"){
      for (const l of s.lines) out.push(indent + l);
    }
    else if (s.kind === "todo")     { out.push(indent + `-- TODO: ${String(s.raw).replace(/\s*\r?\n\s*/g, " ")}`); }
    else if (s.kind === "raw")      { out.push(indent + `-- TODO: ${String(s.raw).replace(/\s*\r?\n\s*/g, " ")}`); }
  }

  for (const s of stmts) emitStatement(s, "");

  const hasNativeCall = out.some(l => {
    const t = l.trim();
    if (!t || t.startsWith("--")) return false;
    if (/^local\s/.test(t) || /^[a-zA-Z_]\w*\s*=/.test(t)) return false;
    return /\b(AddExtParam|Add[A-Z]|RaceAddDamage|ClassAddDamage|ClassSubDamage|SetIgnore|Sub[A-Z]|SetEquipTempValue)/.test(t);
  });
  const referencesR = out.some(l => {
    if (l.trim().startsWith("--")) return false;
    return /(^|[^A-Za-z0-9_])r([^A-Za-z0-9_]|$)/.test(l);
  });
  if (hasNativeCall && (usesR || referencesR)) {
    out.unshift("local r = GetRefineLevel(GetLocation())");
  }
  if (!hasNativeCall) {
    for (let i = out.length - 1; i >= 0; i--) {
      const t = out[i].trim();
      if (/^local\s/.test(t)) out.splice(i, 1);
      else if (/^[a-zA-Z_]\w*\s*=/.test(t) && !t.startsWith("--")) out.splice(i, 1);
      else if (/^if\s.*\bend\s*$/.test(t)) out.splice(i, 1);
      else if (t === "end") out.splice(i, 1);
      else if (/^if\s.*\bthen\s*$/.test(t)) out.splice(i, 1);
    }
  }
  return sanitizeEmittedLines(out);
}

// Final defensive pass: any non-comment line that still contains an
// unsubstituted rAthena temp-var (`.@val`) or a server-only token would
// crash the kRO Lua loader ("unexpected symbol near '.'"). Comment those
// lines out so the .lub stays loadable, no matter which translator path
// produced them.
function sanitizeEmittedLines(lines) {
  return lines.map(l => {
    const t = l.trimStart();
    if (!t || t.startsWith("--")) return l;
    if (DYNAMIC_EXPR_RE.test(l)) {
      const leading = l.slice(0, l.length - t.length);
      return `${leading}-- TODO unsafe expression (not emitted): ${t}`;
    }
    return l;
  });
}

function translateScript(script) {
  // If the script references getrefine()/getequiprefinerycnt(), route it
  // through the refine-aware translator so the resulting Lua actually scales
  // with refine level at equip time. Otherwise fall through to the legacy
  // literal-inlining path.
  if (scriptUsesRefine(script)) {
    return translateScriptRefineAware(script);
  }
  // Resolve `.@var = expr;` assignments into inline substitutions before
  // line-by-line translation. Also strips the assignment lines so they
  // don't show up as `-- TODO:` noise in the OnStartEquip block.
  script = inlineScriptVariables(script);
  const lines = [];
  for (let raw of script.split(/\r?\n/)) {
    raw = raw.replace(/\s+$/, "");
    if (!raw.trim()) continue;
    // Silently drop server-script idioms (control flow, leftover closers)
    // that aren't bonus lines and have no useful client-side equivalent.
    if (SCRIPT_NOISE_RE.test(raw)) continue;
    // Normalise Hercules `bonusN(name, args…);` → rAthena `bonusN name,args…;`.
    raw = normaliseHerculesBonusLine(raw);
    const m = BONUS_LINE_RE.exec(raw);
    if (!m) {
      // Non-bonus rAthena commands (skill / sc_start / heal / hateffect /
      // autobonus / ...): try to render a friendly description so the
      // tooltip can show *some* useful text instead of an opaque TODO.
      const desc = describeNonBonusCommand(raw);
      if (Array.isArray(desc)) {
        for (const l of desc) lines.push(l);
      } else if (desc) {
        lines.push(`-- ${desc}`);
      } else {
        lines.push(`-- TODO: ${raw.trim()}`);
      }
      continue;
    }
    const bname = m[2].toLowerCase();
    const args = splitArgs(m[3]);

    // 1) Custom bonus rules take priority — users can override built-ins.
    const custom = findCustomBonus(bname);
    if (custom) {
      if (custom.description) {
        lines.push(`-- ${applyTemplate(custom.description, args)}`);
      }
      if (custom.lua) {
        for (const ln of applyTemplate(custom.lua, args).split(/\r?\n/)) {
          if (ln.trim()) lines.push(ln);
        }
      }
      continue;
    }

    // 2) Built-in translators
    const t = BONUS_TRANSLATORS[bname];
    const result = t ? t(bname, args) : null;

    // 3) Prepend a description comment from bonus_templates.yml. The
    //    template lookup is now done up-front so that bonuses whose
    //    translator returns null (unsupported arg count, unknown enum,
    //    or no kRO function) still get a tooltip-friendly description
    //    line instead of a `-- TODO:` blob.
    const desc = formatBonusDescription(bname, args);

    // 3a) No translator at all, or translator gave up: try description.
    //     Fall back to `-- raw` if no template is registered either, so
    //     the bonus is at least visible in the .lub.
    if (!t || result == null) {
      if (desc)      lines.push(`-- ${desc}`);
      else           lines.push(`-- TODO: ${raw.trim()}`);
      continue;
    }

    // 3b) Translator returned a value. Emit the description if we have one,
    //     otherwise show the raw bonus line as a comment so description-only
    //     translators (return []) still produce some tooltip text.
    if (desc) {
      lines.push(`-- ${desc}`);
    } else if (Array.isArray(result) && result.length === 0) {
      lines.push(`-- ${raw.trim()}`);
    }

    // 4) Dynamic-expression guard: if the value the translator interpolated
    //    into the emitted Lua call isn't a pure numeric literal, drop the
    //    call (a reference to a server-only global like JobLevel/BaseLevel
    //    would crash the client at equip time). We check the produced Lua
    //    text rather than the raw arg position because some translators
    //    (e.g. bonus3 bSubEle, drop BF) interpolate args[1] instead of the
    //    final BF_* arg.
    if (Array.isArray(result) && result.length === 0) continue;
    const emitted = Array.isArray(result) ? result.join(" ") : String(result);
    if (DYNAMIC_EXPR_RE.test(emitted)) {
      lines.push(`-- TODO dynamic expression (not emitted): ${raw.trim()}`);
      continue;
    }

    if (Array.isArray(result)) lines.push(...result);
    else lines.push(result);
  }
  return sanitizeEmittedLines(lines);
}


// Return true if an arg string is a safe numeric expression that the
// client-side Lua interpreter can evaluate. rAthena script expressions
// referencing server-only globals (JobLevel, BaseLevel, getrefine(), ...)
// are rejected — they crash the client as "attempt to perform arithmetic
// on global 'X' (a nil value)".
function isPureNumeric(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  return /^[\d\s+\-*/().]+$/.test(t) && /\d/.test(t);
}

function collectScriptText(item) {
  let text = "";
  for (const key of ["Script", "EquipScript"]) {
    if (item[key]) {
      text += item[key];
      if (!text.endsWith("\n")) text += "\n";
    }
  }
  return text;
}

// True if the item has at least one bonus that translates to a real Lua call
// (not just a `-- TODO` / description comment). Used to surface a warning so
// the user knows which item IDs have empty/unrecognised script blocks.
function itemHasTranslatableBonuses(item) {
  const script = collectScriptText(item);
  if (!script.trim()) return false;
  const lines = translateScript(script);
  return lines.some(l => !l.trim().startsWith("--"));
}

// ============================================================================
// Hercules item_db.conf parser
//
// Parses the libconfig-ish format used by Hercules' item_db.conf. Only the
// fields we care about (Id, Type, Def, Refine, Script, OnEquipScript,
// OnUnequipScript) are actually extracted. Multi-line `Script: <" ... ">`
// blocks and nested objects/arrays are handled. Comments (// and /* */) are
// stripped before parsing.
// ============================================================================

function parseHerculesConf(text) {
  // Strip comments
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  text = text.replace(/\/\/[^\n]*/g, "");

  const items = [];
  const n = text.length;

  // Find the item_db: ( ... ) list opener
  const dbMatch = /\bitem_db\s*:\s*\(/.exec(text);
  if (!dbMatch) return items;
  let i = dbMatch.index + dbMatch[0].length;

  while (i < n) {
    // skip whitespace and commas between items
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n) break;
    if (text[i] === ")") break;       // end of item_db list
    if (text[i] !== "{") { i++; continue; }
    i++;
    const parsed = parseHerculesItem(text, i);
    if (!parsed) break;
    items.push(parsed.data);
    i = parsed.endIdx + 1;
  }
  return items;
}

function parseHerculesItem(text, startIdx) {
  const data = {};
  const n = text.length;
  let i = startIdx;
  let depth = 1;

  while (i < n && depth > 0) {
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n) break;

    if (text[i] === "}") {
      depth--;
      if (depth === 0) return { data, endIdx: i };
      i++;
      continue;
    }
    if (text[i] === "{") {
      // nested object - skip
      depth++;
      i++;
      // skip to matching close at this depth
      while (i < n && depth > 1) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      continue;
    }

    // Try to parse `Key: value`
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(text.slice(i));
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1];
    i += keyMatch[0].length;

    // Parse value based on the next character
    if (text[i] === "<" && text[i + 1] === '"') {
      // Multi-line script string: <" ... ">
      i += 2;
      const end = text.indexOf('">', i);
      if (end < 0) break;
      data[key] = text.slice(i, end);
      i = end + 2;
    } else if (text[i] === '"') {
      // Regular quoted string
      i++;
      let buf = "";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) { buf += text[i + 1]; i += 2; }
        else { buf += text[i]; i++; }
      }
      if (i < n) i++;
      data[key] = buf;
    } else if (text[i] === "{") {
      // Nested object - track and skip
      let d = 1; i++;
      while (i < n && d > 0) {
        if (text[i] === "{") d++;
        else if (text[i] === "}") d--;
        if (d > 0) i++;
      }
      if (i < n) i++;
    } else if (text[i] === "[") {
      let d = 1; i++;
      while (i < n && d > 0) {
        if (text[i] === "[") d++;
        else if (text[i] === "]") d--;
        if (d > 0) i++;
      }
      if (i < n) i++;
    } else {
      // bareword / number / bool / identifier: read until whitespace, comma, or }
      const start = i;
      while (i < n && !/[\s,}]/.test(text[i])) i++;
      const raw = text.slice(start, i).trim();
      if (raw === "true")       data[key] = true;
      else if (raw === "false") data[key] = false;
      else if (/^-?\d+(\.\d+)?$/.test(raw)) data[key] = Number(raw);
      else data[key] = raw;
    }
  }
  return null;
}

// Map a Hercules item to the rAthena-ish shape the rest of the pipeline uses.
function normalizeHerculesItem(h) {
  const typeMap = {
    IT_WEAPON: "Weapon",
    IT_ARMOR:  "Armor",
    IT_CARD:   "Card",
    IT_AMMO:   "Ammo",
    IT_PETARMOR: "Armor",
    IT_SHADOWGEAR: "Armor",
  };
  return {
    Id:         h.Id,
    AegisName:  h.AegisName || "",
    Name:       h.Name || "",
    Type:       typeMap[h.Type] || h.Type || "Armor",
    // Preserve Subtype so resolveLubType() can pick Rweapon vs Mweapon based
    // on the weapon class (W_SHOTGUN, W_BOW, etc.) instead of falling back
    // to an Aegis-ID range guess that misclassifies non-standard IDs and
    // produces a Stat table whose count mismatches the emitted Type.
    Subtype:    h.Subtype || h.SubType || "",
    // Equip location string (`EQP_HEAD_TOP`, `EQP_COSTUME_HEAD_TOP`, etc.).
    // Hercules `Loc:` is sometimes a string and sometimes a quoted list of
    // strings — normalize to a single space-joined string for downstream
    // matching (we only care about the prefix anyway).
    Loc: Array.isArray(h.Loc) ? h.Loc.join(" ") : String(h.Loc || ""),
    Defense:    h.Def || 0,
    Refineable: h.Refine === true,
    Script:       h.Script       || "",
    EquipScript:  h.OnEquipScript || "",
  };
}

// True if this item is a "costume" slot (EQP_COSTUME_* / Costume_*). On
// Project 255's kRO client costume armors get rejected with "Item[N] has
// invalid 'Stat' table(count: 17)" when emitted with a 17-entry zero
// Stat — the validator treats them like cards and expects no Stat field
// at all. Detects both Hercules string form (`Loc: "EQP_COSTUME_HEAD_TOP"`)
// and rAthena YAML map form (`Locations: { Costume_Head_Top: true }`).
function isCostumeItem(item) {
  if (!item) return false;
  const loc = String(item.Loc || "");
  if (/\bEQP_COSTUME_/i.test(loc) || /\bCostume_/i.test(loc)) return true;
  // rAthena YAML uses a `Locations` map of slot-name → true.
  const yamlLoc = item.Locations || item.Location;
  if (yamlLoc && typeof yamlLoc === "object") {
    for (const key of Object.keys(yamlLoc)) {
      if (yamlLoc[key] && /^Costume_/i.test(key)) return true;
    }
  }
  return false;
}

// Format an OnStartEquip block (lines, unindented items) for an item.
// Returns null if the YAML item has no translatable bonuses at all.
//
// NOTE on combo bonuses: kRO renders combo set effects from the global
// Combiitem table's per-set OnStartEquip, NOT from the individual member
// items' OnStartEquip. We deliberately do NOT inline combo bonuses here —
// duplicating them in the per-item function would make the tooltip show
// every set bonus the item *could* gain unconditionally, plus the client
// would double-apply the effect when the set is actually completed.
// Drop consecutive identical comment lines from a translated body. Items
// with multiple combo entries that all expand to the same description (or
// other duplicated emitter paths) would otherwise produce visually noisy
// `-- X` `-- X` `-- X` runs in the .lub.
function dedupeConsecutiveComments(body) {
  const out = [];
  let prev = null;
  for (const l of body) {
    const t = l.trim();
    const isComment = t.startsWith("--");
    if (isComment && prev !== null && t.replace(/,\s*$/, "") === prev) {
      continue;
    }
    out.push(l);
    prev = isComment ? t.replace(/,\s*$/, "") : null;
  }
  return out;
}

function buildOnStartEquipBlock(item) {
  const ownScript = collectScriptText(item);
  const ownBody = ownScript ? dedupeConsecutiveComments(translateScript(ownScript)) : [];

  if (!ownBody.length) return null;

  const body = ownBody.slice();

  // If every translated line is a `-- comment` (no AddExtParam/Add* call),
  // skip the OnStartEquip wrapper. The kRO client's bonus scanner counts the
  // calls inside the function and rejects items whose count is 0 with
  // "Item[N] invalid 'Stat' table (count: 0)". Returning the comments as
  // sibling -- lines preserves the description as documentation in the
  // entry body without producing a function the scanner will reject.
  const hasRealCall = body.some(l => !l.trim().startsWith("--"));
  if (!hasRealCall) {
    return body.map(l => "    " + l);
  }
  const out = ["    OnStartEquip = function()"];
  for (const b of body) out.push(`      ${b}`);
  out.push("    end,");
  return out;
}


// ============================================================================
// Item combo DB parsers
// ============================================================================

// Hercules: combo_db: ( { Items: ["a","b"], Script: <"..."> }, ... )
// Returns { names: string[], script: string }[] — script is included so
// each member item's OnStartEquip can show the combo bonuses in-tooltip.
function parseHerculesComboDb(text) {
  const sets = [];
  const dbMatch = /\bcombo_db\s*:\s*\(/.exec(text);
  if (!dbMatch) return sets;
  let i = dbMatch.index + dbMatch[0].length;
  const n = text.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n || text[i] === ")") break;
    if (text[i] !== "{") { i++; continue; }
    let d = 1, j = i + 1;
    while (j < n && d > 0) {
      if (text[j] === "{") d++;
      else if (text[j] === "}") d--;
      j++;
    }
    const block = text.slice(i, j);
    const itemsMatch = /\bItems\s*:\s*\[([^\]]*)\]/.exec(block);
    if (itemsMatch) {
      const names = [...itemsMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      if (names.length >= 2) {
        // Script value is wrapped as `<"...">` — pull out the body verbatim.
        const scriptMatch = /\bScript\s*:\s*<"([\s\S]*?)">/.exec(block);
        const script = scriptMatch ? scriptMatch[1] : "";
        sets.push({ names, script });
      }
    }
    i = j;
  }
  return sets;
}

// rAthena: YAML already parsed -- { Body: [ { Combos: [ { Combo: ["a","b"] } ], Script } ] }
function parseRathenaComboDb(data) {
  const sets = [];
  for (const entry of ((data && data.Body) || [])) {
    const script = entry.Script || "";
    for (const c of (entry.Combos || [])) {
      const items = c.Combo || [];
      if (items.length >= 2) sets.push({ names: items.map(String), script });
    }
  }
  return sets;
}

// Build a per-aegis-name view of combo data:
//   Map<aegisName, {
//     partnerIds: number[],            // all unique partner IDs (sorted)
//     combos: [{                       // one entry per combo this item is in
//       partnerNames: string[],        // partner aegis names
//       partnerIds: number[],          // partner IDs
//       script: string,                // combo bonus script
//     }, ...]
//   }>
function buildComboMap(comboSets, aegisToId) {
  const map = new Map();
  for (const set of comboSets) {
    const names = set.names || [];
    const script = set.script || "";
    const ids = names.map(name => aegisToId.get(name)).filter(id => id != null);
    if (ids.length < 2) continue;
    for (const name of names) {
      const selfId = aegisToId.get(name);
      if (selfId == null) continue;
      if (!map.has(name)) map.set(name, { partnerIds: new Set(), combos: [] });
      const slot = map.get(name);
      const partnerNames = names.filter(n => n !== name);
      const partnerIds = partnerNames.map(n => aegisToId.get(n)).filter(id => id != null);
      for (const id of partnerIds) slot.partnerIds.add(id);
      slot.combos.push({ partnerNames, partnerIds, script });
    }
  }
  const result = new Map();
  for (const [name, slot] of map) {
    result.set(name, {
      partnerIds: [...slot.partnerIds].sort((a, b) => a - b),
      combos: slot.combos,
    });
  }
  return result;
}

// ----------------------------------------------------------------------------
// Global Combiitem table — the kRO/FreyjaRO convention for combo sets
//
// EquipmentProperties.lub has TWO levels of combo data:
//
//   1. Per-item `Combiitem = { <combo_set_id>, ... }` — each entry lists the
//      combo *set* IDs the item belongs to (NOT partner item IDs). The client
//      shows the "(C)" suffix on the item name when every partner in that
//      combo set is also equipped.
//
//   2. Global `Combiitem = { [<combo_set_id>] = { Item = { <ids> },
//                                                  OnStartEquip = ... }, ... }`
//      table at the bottom — the actual combo definition. The client runs
//      that OnStartEquip when the matching set is complete.
//
// We parse this global table once so we can:
//   - reuse the existing combo_set_id when the user's combo_db lists the
//     same partner items as a stock combo (Valkyrie set → 2000000052),
//   - generate fresh IDs for genuinely-new combos starting safely above
//     the highest ID we already see in the source.
// ----------------------------------------------------------------------------
// Match ONLY the top-level `Combiitem = {` (column 0). The permissive
// `^\s*` form also matches per-item indented `Combiitem = {` fields, which
// would make parseExistingCombiTable return the first per-item field instead
// of the actual global combo table — corrupting set-id allocation and
// causing new combo entries to be spliced inside an item entry.
const COMBI_TABLE_OPEN_RE = /^Combiitem\s*=\s*\{\s*$/;

function combiPartnerKey(ids) {
  return [...ids].map(n => parseInt(n, 10)).filter(Number.isFinite)
    .sort((a, b) => a - b).join(",");
}

// Parse the existing global Combiitem table. Returns:
//   {
//     openLine, closeLine,   // span of the table (or null if not present)
//     partnersToId,          // Map<combiPartnerKey, setId>
//     usedIds,               // Set<setId>
//     maxId,                 // highest existing set id (for new id allocation)
//   }
function parseExistingCombiTable(lines) {
  let openLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (COMBI_TABLE_OPEN_RE.test(lines[i])) { openLine = i; break; }
  }
  const partnersToId = new Map();
  const usedIds = new Set();
  let maxId = 0;
  if (openLine < 0) return { openLine: null, closeLine: null, partnersToId, usedIds, maxId };

  const closeLine = findMatchingBrace(lines, openLine);

  // Walk entries: [<id>] = { ... Item = { ... } ... }
  const ENTRY_HEAD = /^\s*\[\s*(\d+)\s*\]\s*=\s*\{/;
  const ITEM_LINE  = /\bItem\s*=\s*\{([^}]*)\}/;
  let i = openLine + 1;
  while (i < closeLine) {
    const m = ENTRY_HEAD.exec(lines[i]);
    if (!m) { i++; continue; }
    const setId = parseInt(m[1], 10);
    const entryEnd = findMatchingBrace(lines, i);
    usedIds.add(setId);
    if (setId > maxId) maxId = setId;

    // Look for the Item = { ... } line inside this entry's span.
    let itemIds = null;
    for (let j = i; j <= entryEnd; j++) {
      const im = ITEM_LINE.exec(lines[j]);
      if (im) {
        itemIds = (im[1].match(/-?\d+/g) || []).map(s => parseInt(s, 10));
        break;
      }
    }
    if (itemIds && itemIds.length >= 2) {
      partnersToId.set(combiPartnerKey(itemIds), setId);
    }
    i = entryEnd + 1;
  }
  return { openLine, closeLine, partnersToId, usedIds, maxId };
}

// Generate a fresh combo set id that doesn't collide with any existing id.
// We pick a starting base above the stock range (2.x billion) so the new ids
// are visually distinct from stock content in diffs / logs.
function makeIdAllocator(usedIds, maxId) {
  let next = Math.max(maxId + 1, 3000000000);
  return () => {
    while (usedIds.has(next)) next++;
    const id = next++;
    usedIds.add(id);
    return id;
  };
}

// Format a global Combiitem table entry. `script` is rAthena/Hercules text;
// we run it through translateScript() so the kRO client gets real Lua calls
// instead of comments. Returns an array of indented lines, no trailing comma
// — caller adds the comma when splicing into the table.
function formatCombiTableEntry(setId, partnerIds, script, indent) {
  indent = indent || "\t";
  const inner = indent + "\t";
  const out = [];
  out.push(`${indent}[${setId}] = {`);
  out.push(`${inner}Item = { ${partnerIds.join(", ")} },`);

  const luaLines = (script && script.trim())
    ? translateScript(script).filter(l => l.trim()).map(l => inner + "\t" + l)
    : [];
  const realCallLines = luaLines.filter(l => {
    const t = l.trim();
    return t && !t.startsWith("--");
  });
  if (realCallLines.length) {
    out.push(`${inner}OnStartEquip = function()`);
    for (const l of luaLines) out.push(l);
    out.push(`${inner}end`);
  } else {
    // No translatable bonuses — surface as inline comments so the user can
    // still see what the combo is supposed to do, even with no Lua body.
    for (const l of luaLines) out.push(l);
  }
  out.push(`${indent}}`);
  return out;
}

// ============================================================================
// Build a FULL entry (for brand-new item IDs)
// ============================================================================

// Stat-table length per Type. kRO uses:
//   - 17 entries for armor, Mweapon (melee weapon), generic weapon
//   - 15 entries for Rweapon (ranged weapon)
//   -  2 entries for ammo
//   - card / special omit the Stat field entirely when all-zero
// Supplying the wrong count triggers the client warning
// "Item[N] has invalid 'Stat' table(count: X)" at load.
function statArraySize(lubType) {
  if (lubType === "Rweapon") return 15;
  if (lubType === "ammo")    return 2;
  return 17;
}

function buildStatArray(item, lubType) {
  const type = lubType || "armor";
  const size = statArraySize(type);
  const stat = new Array(size).fill(0);
  stat[0] = parseInt(item.Defense || 0, 10) || 0;
  // kRO format quirk: the "is equippable" flag slot must always be 1 for
  // armor / weapons — even on items the YAML marks `Refine: false` (like
  // costumes). Setting it to 0 makes the client reject the entry with
  // "Item[N] has invalid 'Stat' table(count: 17)". Confirmed against stock
  // FreyjaRO output where 100% of armor + weapon entries have the flag set.
  //   - armor / Mweapon (17 entries) → slot[10] = 1
  //   - Rweapon         (15 entries) → slot[8]  = 1
  //   - ammo            ( 2 entries) → no flag slot
  if (type === "Rweapon") {
    stat[8] = 1;
  } else if (type !== "ammo") {
    stat[10] = 1;
  }
  return stat;
}

function formatStatArray(stat) {
  return "{\n      " + stat.join(",\n      ") + "\n    }";
}

function formatCombiitem(ids) {
  const s = ids.map(String);
  if (s.length === 1) return "{" + s[0] + "}";
  return "{\n      " + s.join(",\n      ") + "\n    }";
}

function buildFullEntry(item) {
  const itemId = parseInt(item.Id, 10);
  const lubType = resolveLubType(item);

  const lines = [`  [${itemId}] = {`];
  lines.push(`    Type = "${lubType}",`);
  // Cards with no defensive stats omit the Stat field entirely — emitting
  // `Stat = {0,0,...,0}` trips "Item[N] has invalid 'Stat' table(count: 0)".
  // Everything else (including costumes) needs the full Stat per
  // statArraySize(lubType) with the "is equippable" flag set — see
  // buildStatArray() for the per-type slot conventions.
  const statArr = buildStatArray(item, lubType);
  const skipStat = lubType === "card" && statArr.every(v => v === 0);
  if (!skipStat) {
    lines.push(`    Stat = ${formatStatArray(statArr)},`);
  }

  const osBlock = buildOnStartEquipBlock(item);
  if (osBlock) lines.push(...osBlock);

  const combo = item.Combo || item.Combos;
  if (combo && Array.isArray(combo)) {
    const ids = [];
    for (const c of combo) {
      if (c && typeof c === "object" && "Id" in c) ids.push(c.Id);
      else ids.push(c);
    }
    if (ids.length) lines.push(`    Combiitem = ${formatCombiitem(ids)},`);
  }

  // Strip trailing comma on the last field
  if (lines[lines.length - 1].endsWith(",")) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
  }
  lines.push("  },");
  return [itemId, lines];
}

// ============================================================================
// Lua parsing helpers (string-aware brace counting)
// ============================================================================

function stripLuaStrings(line) {
  let out = "";
  let i = 0;
  let inS = null;
  while (i < line.length) {
    const ch = line[i];
    if (inS) {
      if (ch === "\\" && i + 1 < line.length) { i += 2; continue; }
      if (ch === inS) inS = null;
      i++;
      continue;
    }
    // A `--` outside a string starts a Lua single-line comment — everything
    // after it is ignored. Critical for brace counting: TODO comments may
    // contain raw rAthena script like `W_STAFF) {` whose `{` would otherwise
    // be miscounted as a real open brace, drifting findMatchingBrace() off
    // the end of the Item table and causing new entries to be appended
    // after every other top-level table (Combiitem / RefiningBonus / …).
    if (ch === "-" && line[i + 1] === "-") break;
    if (ch === '"' || ch === "'") { inS = ch; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

function stripLuaComment(line) {
  // stripLuaStrings() already truncates at the first `--` outside a string
  // literal (and drops string bodies), so its return value is exactly the
  // code portion of the line — which is what the keyword/brace counters that
  // call this want. The previous implementation looked for "--" in that
  // already-stripped text, never found it, and so returned the ORIGINAL line
  // unchanged — leaving comment text (e.g. `-- TODO: if (...)`) in place and
  // causing findOnStartEquipRange to miscount `if`/`end` keywords inside
  // comments. That made it fail to find an existing OnStartEquip and append a
  // duplicate instead of replacing it.
  return stripLuaStrings(line);
}

function findMatchingBrace(lines, openLine) {
  let depth = 0;
  let started = false;
  for (let j = openLine; j < lines.length; j++) {
    for (const ch of stripLuaStrings(lines[j])) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") {
        depth--;
        if (started && depth === 0) return j;
      }
    }
  }
  return lines.length - 1;
}

// Match both inline `[18738] = { Type = "armor", Stat = {...} },` and
// multi-line `[18752] = {\n  ...\n  },` openers. Earlier versions required
// the `{` to be at end-of-line, which silently missed every inline entry
// and appended a brand-new duplicate at the bottom of Item = { ... } —
// see the 101 duplicated IDs that result. The relaxed regex picks up both
// forms; downstream code (parseItemSpans, findMatchingBrace) already
// handles the single-line case correctly because brace counting balances
// inside one line.
const ITEM_HEADER_RE = /^\s*\[(\d+)\]\s*=\s*\{/;
// Must be at column 0 — top-level table only, never matches an indented
// per-item `Item = { ... }` (which exists inside global Combiitem entries).
const ITEM_TABLE_OPEN_RE = /^Item\s*=\s*\{\s*$/;

// Expand an inline `[NN] = { Key = val, ... },` line into multi-line form
// so the existing modifier logic (which assumes one field per line and a
// closing `}` on its own line) can safely insert OnStartEquip, repair
// Stat, or add Combiitem. Mutates `lines` in place; returns the new end
// line index of the expanded entry, or null if the line is already
// multi-line (i.e. starts with `[NN] = {` and nothing else on it).
function expandInlineItemEntry(lines, lineIdx) {
  const raw = lines[lineIdx];
  // Only handle the case where the entry opens AND closes on this line.
  // We require: optional indent, `[id] = {`, body, `}`, optional trailing comma.
  const m = /^(\s*)\[(\d+)\]\s*=\s*\{(.*)\}(\s*,?\s*)$/.exec(raw);
  if (!m) return null;
  const indent = m[1];
  const id = m[2];
  const body = m[3];
  // Always end the expanded entry with a trailing comma — even if the
  // original had none — so subsequent insertions (OnStartEquip, Combiitem)
  // don't have to fix up commas separately.
  const trailing = ",";

  // Split body at depth-0 commas so each field becomes its own line.
  const parts = [];
  let buf = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{" || ch === "[") { depth++; buf += ch; }
    else if (ch === "}" || ch === "]") { depth--; buf += ch; }
    else if (ch === "," && depth === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());

  // Use one extra indent level for fields. Default to two spaces if the
  // outer indent is empty, otherwise repeat the outer indent's last unit
  // (tab or two spaces) once more.
  const unit = /\t/.test(indent) ? "\t" : "  ";
  const innerIndent = indent + unit;

  const expanded = [
    indent + "[" + id + "] = {",
    ...parts.map((p, i) => innerIndent + p + (i < parts.length - 1 ? "," : "")),
    indent + "}" + trailing,
  ];
  lines.splice(lineIdx, 1, ...expanded);
  return lineIdx + expanded.length - 1;
}

function findItemTableRange(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (ITEM_TABLE_OPEN_RE.test(lines[i])) {
      return [i, findMatchingBrace(lines, i)];
    }
  }
  return [null, null];
}

function parseItemSpans(lines) {
  const spans = new Map();
  const [open, close] = findItemTableRange(lines);
  if (open == null) return spans;
  let i = open + 1;
  while (i < close) {
    const m = ITEM_HEADER_RE.exec(lines[i]);
    if (m) {
      const id = parseInt(m[1], 10);
      const end = findMatchingBrace(lines, i);
      spans.set(id, [i, end]);
      i = end + 1;
    } else {
      i++;
    }
  }
  return spans;
}

// Find the [start, end] line range of an existing `OnStartEquip = function()`
// block within the line range [spanS, spanE] of an item entry. Tracks Lua
// block nesting (function/if/for/while) so nested `end`s aren't miscounted.
// Returns null if no OnStartEquip block is present.
function findOnStartEquipRange(lines, spanS, spanE) {
  const HEAD_RE = /^\s*OnStartEquip\s*=\s*function\s*\(\s*\)/;
  let head = -1;
  for (let i = spanS; i <= spanE; i++) {
    if (HEAD_RE.test(lines[i])) { head = i; break; }
  }
  if (head < 0) return null;

  // Nesting: the function itself is depth 1 at the head line.
  // Walk forward counting block keywords until depth returns to 0.
  let depth = 1;
  for (let j = head + 1; j <= spanE; j++) {
    const cleaned = stripLuaComment(lines[j]);
    const tokens = cleaned.match(/\b(function|if|for|while|end)\b/g);
    if (!tokens) continue;
    for (const tok of tokens) {
      if (tok === "end") {
        depth--;
        if (depth === 0) return [head, j];
      } else {
        depth++;
      }
    }
  }
  return null;
}


function findCombiitemRange(lines, spanS, spanE) {
  const HEAD_RE = /^\s*Combiitem\s*=/;
  for (let i = spanS; i <= spanE; i++) {
    if (HEAD_RE.test(lines[i])) {
      const stripped = stripLuaStrings(lines[i]);
      const opens  = (stripped.match(/\{/g) || []).length;
      const closes = (stripped.match(/\}/g) || []).length;
      if (opens > 0 && opens === closes) return [i, i];
      return [i, findMatchingBrace(lines, i)];
    }
  }
  return null;
}

// Locate the `Stat = { ... }` range inside an item entry. Returns null if
// the field doesn't exist. Handles both inline (`Stat = {0,0,...}`) and
// multi-line forms.
function findStatRange(lines, spanS, spanE) {
  const HEAD_RE = /^\s*Stat\s*=/;
  for (let i = spanS; i <= spanE; i++) {
    if (HEAD_RE.test(lines[i])) {
      const stripped = stripLuaStrings(lines[i]);
      const opens  = (stripped.match(/\{/g) || []).length;
      const closes = (stripped.match(/\}/g) || []).length;
      if (opens > 0 && opens === closes) return [i, i];
      return [i, findMatchingBrace(lines, i)];
    }
  }
  return null;
}

// Read the `Type = "..."` field from an existing entry's lines (between
// spanS..spanE). Returns the lub Type string or null if not present.
// Used by the Stat-repair path so the rebuilt Stat count matches the
// Type the .lub will actually emit, even if the YAML's resolveLubType()
// disagrees (e.g. Subtype was lost upstream).
function readExistingType(lines, spanS, spanE) {
  const TYPE_RE = /\bType\s*=\s*"([^"]+)"/;
  for (let i = spanS; i <= spanE; i++) {
    const m = TYPE_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

// kRO's equipment scanner expects exactly 17 entries in Stat (slot 0 = DEF,
// slot 10 = Refineable flag, rest = 0). Returns the actual count of numeric
// values in the table, or 0 if the field is empty / unparseable.
function countStatEntries(lines, statRange) {
  if (!statRange) return -1;          // missing field entirely
  const [s, e] = statRange;
  // Concatenate the table body (strip the `Stat = {` opener and `}` closer)
  let body = lines.slice(s, e + 1).join("\n");
  body = body.replace(/^[\s\S]*?\{/, "").replace(/\}[\s\S]*$/, "");
  // Strip Lua line and block comments before counting
  body = body.replace(/--\[\[[\s\S]*?\]\]/g, "");
  body = body.replace(/--[^\n]*/g, "");
  // Numeric literals separated by commas, possibly with surrounding whitespace
  const matches = body.match(/-?\d+(?:\.\d+)?/g);
  return matches ? matches.length : 0;
}

// Parse the numeric values inside an existing Stat = { … } block.
// Returns an array of integers (one per slot) or null on parse failure.
function parseStatValues(lines, statRange) {
  if (!statRange) return null;
  const [s, e] = statRange;
  let body = lines.slice(s, e + 1).join("\n");
  body = body.replace(/^[\s\S]*?\{/, "").replace(/\}[\s\S]*$/, "");
  body = body.replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--[^\n]*/g, "");
  const matches = body.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return null;
  return matches.map(v => parseInt(v, 10) || 0);
}

// kRO armor Stat-slot index (1-based) → ExtParam ID for the stat that slot
// represents. Empirically deduced by comparing item_db scripts against the
// kRO source-of-truth EquipmentProperties.lub. Used by `dedupAgainstStatBlock`
// to skip emitting `AddExtParam(0, EID, V)` calls when the existing Stat slot
// already carries that exact value (otherwise the tooltip double-displays).
const KRO_STAT_SLOT_TO_EXTPARAM = {
   1: 45,   // DEF
   2: 103,  // STR
   3: 106,  // INT
   4: 105,  // VIT
   5: 107,  // DEX
   6: 104,  // AGI
   7: 108,  // LUK
  10: 47,   // MDEF
  // Slots 8 / 9 are weapon-specific (ATK / MATK overflow); leave them alone.
  // Slot 11 is the refineable / weapon-level flag, not a stat bonus.
};

// Walk an OnStartEquip block and drop top-level `AddExtParam(0, EID, V)` calls
// whose stat is already covered by the existing Stat block (same EID, same V).
// Only acts on truly unconditional, literal-arg calls — anything inside an
// `if … then` block, anything with refine math like `(r * 2)`, anything with
// a `local` reference is left untouched.
function dedupAgainstStatBlock(osLines, statValues) {
  if (!osLines || !osLines.length || !statValues) return osLines;
  const covered = new Map();
  for (const [slot, eid] of Object.entries(KRO_STAT_SLOT_TO_EXTPARAM)) {
    const v = statValues[Number(slot) - 1];
    if (v !== undefined && v !== 0) covered.set(eid, v);
  }
  if (covered.size === 0) return osLines;
  const ADD_EXT_LITERAL = /^(\s*)AddExtParam\(\s*0\s*,\s*(\d+)\s*,\s*(-?\d+)\s*\)\s*,?\s*$/;
  // Track nesting inside the OnStartEquip BODY. Start at depth -1 so that the
  // `OnStartEquip = function()` opener (which increments depth) lands the body
  // at depth 0. Anything inside an `if … then` / `for … do` / `while … do` /
  // nested `function()` then sits at depth ≥ 1 and is NOT eligible for dedup.
  // (Conditional bonuses must be preserved — only the gated branch fires.)
  let depth = -1;
  const OPEN_BLOCK = /^\s*(?:if\b.*\bthen\s*$|do\s*$|while\b.*\bdo\s*$|for\b.*\bdo\s*$|else\s*$|elseif\b.*\bthen\s*$|function\b|.*=\s*function\s*\()/;
  const CLOSE_BLOCK = /^\s*(?:end\b|elseif\b.*\bthen\s*$|else\s*$)/;
  const out = [];
  let lastWasDescComment = false;
  for (const line of osLines) {
    // elseif / else act as both close-and-reopen at the same depth: handle by
    // closing first, then matching the open-block regex below which re-opens.
    if (/^\s*(?:elseif\b.*\bthen|else)\s*$/.test(line)) {
      depth = Math.max(0, depth - 1);
    } else if (CLOSE_BLOCK.test(line)) {
      depth = Math.max(-1, depth - 1);
    }
    const m = (depth === 0) ? ADD_EXT_LITERAL.exec(line) : null;
    if (m) {
      const eid = parseInt(m[2], 10);
      const val = parseInt(m[3], 10);
      if (covered.get(eid) === val) {
        if (lastWasDescComment) out.pop();
        lastWasDescComment = false;
        if (OPEN_BLOCK.test(line)) depth++;
        continue;
      }
    }
    if (OPEN_BLOCK.test(line)) depth++;
    lastWasDescComment = /^\s*--/.test(line);
    out.push(line);
  }
  return out;
}

// If after dedup an OnStartEquip block has no real Lua calls left (only
// comments + the function wrapper), drop the wrapper and emit the comments
// as bare `--` sibling fields at item-body indent. Returns the cleaned block.
function compactOnStartEquipBlock(osLines) {
  if (!osLines || !osLines.length) return osLines;
  const opensFn  = osLines[0] && /OnStartEquip\s*=\s*function/.test(osLines[0]);
  const closesFn = osLines[osLines.length - 1] && /^\s*end\b/.test(osLines[osLines.length - 1]);
  if (!opensFn || !closesFn) return osLines;
  const body = osLines.slice(1, -1);
  const hasRealCall = body.some(l => {
    const t = l.trim();
    if (!t || t.startsWith("--")) return false;
    return /[A-Za-z_]\w*\s*\(/.test(t);
  });
  if (hasRealCall) return osLines;
  // Convert leading `      <comment>` to item-body indent `    <comment>`.
  return body
    .map(l => l.replace(/^\s+/, "    "))
    .filter(l => l.trim());
}

// ============================================================================
// Apply new entries directly to the source .lub
// ============================================================================

// True if `text` looks like the sibling preset/order file (FunctionPreset,
// Operation, Element, Race definitions) rather than the actual item table.
// The two files have nearly identical filenames in some clients
// (EquipmentProperties.lub vs equipmentpropertiesorder.lub) and getting them
// swapped is the #1 cause of the "Could not locate Item = {" error.
function looksLikePresetLub(text) {
  if (!text) return false;
  const sigs = [
    /^\s*FunctionPreset\s*=\s*\{/m,
    /^\s*Operation\s*=\s*\{/m,
    /^\s*ValuePreset\s*=\s*\{/m,
    /^\s*SymbolPreset\s*=\s*\{/m,
  ];
  return sigs.filter(re => re.test(text)).length >= 2;
}

// Given the user's selected path, return the most likely sibling that
// actually holds the Item table. Strips an `_order` / `order` suffix from
// the filename. Returns null if no obvious candidate.
function siblingItemLubCandidates(srcPath) {
  if (!srcPath) return [];
  const sep = srcPath.includes("\\") ? "\\" : "/";
  const idx = Math.max(srcPath.lastIndexOf("\\"), srcPath.lastIndexOf("/"));
  const dir = idx >= 0 ? srcPath.slice(0, idx) : "";
  const fname = idx >= 0 ? srcPath.slice(idx + 1) : srcPath;
  const dotIdx = fname.lastIndexOf(".");
  const stem = dotIdx >= 0 ? fname.slice(0, dotIdx) : fname;
  const ext  = dotIdx >= 0 ? fname.slice(dotIdx) : ".lub";
  // Strip _order / order from the stem in both casings
  const trimmed = stem.replace(/_?order$/i, "");
  if (!trimmed || trimmed === stem) return [];
  const variants = new Set([
    trimmed + ext,
    trimmed.replace(/^./, c => c.toUpperCase()) + ext,
    "EquipmentProperties" + ext,
    "equipmentproperties" + ext,
  ]);
  return [...variants].map(n => (dir ? dir + sep + n : n));
}

// Walk the file backwards from EOF. Skip whitespace. If the next non-blank
// line is `[N] = {` or its body, we're in orphan territory — keep trimming
// until we hit a properly-closed top-level table (a `}` or `},` at column 0).
// Returns { lines, removed } — `lines` is the trimmed array, `removed` is
// the count of lines stripped (0 if the file was already clean).
function trimOrphanItemsAtEOF(lines) {
  // Find the last column-0 `}` or `},` (closing a top-level table).
  let lastTableClose = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trimEnd();
    if (t === "}" || t === "},") { lastTableClose = i; break; }
  }
  if (lastTableClose < 0) return { lines, removed: 0 };

  // Is there anything that LOOKS like item entries between lastTableClose
  // and EOF? If not, the file is clean — leave it alone.
  let hasOrphanItems = false;
  for (let i = lastTableClose + 1; i < lines.length; i++) {
    if (/^\s*\[\d+\]\s*=\s*\{/.test(lines[i])) { hasOrphanItems = true; break; }
  }
  if (!hasOrphanItems) return { lines, removed: 0 };

  // Strip the rogue trailing comma if present (top-level tables don't take
  // one) and truncate everything after.
  const lastT = lines[lastTableClose].trimEnd();
  if (lastT === "},") lines[lastTableClose] = lines[lastTableClose].replace(/,\s*$/, "");
  const trimmed = lines.slice(0, lastTableClose + 1);
  return { lines: trimmed, removed: lines.length - trimmed.length };
}

// Marker that lets us detect whether an Order file has already been patched
// by a previous run. Re-patching would create duplicate Order entries which
// the kRO validator rejects ("invalid 'uniq2' field").
const RDL_ORDER_MARKER = "-- RDL custom: skill grant";

// Stub Lua + Order entries injected into every sibling
// EquipmentPropertiesOrder*.lub so the tooltip renderer knows how to
// display AutoSpell / AddEffectOnAttack / EnableSkill / AddMaxWeight calls
// our generator emits. Pure no-ops at runtime — the actual gameplay
// effect is server applied; this is purely for client-side tooltip text.
const RDL_ORDER_STUB_BLOCK = `

-- ============================================================
--   RDL custom stubs for AutoSpell / AddEff / MaxWeight tooltip support
-- ------------------------------------------------------------
-- Emitted by EquipmentProperties.lub for bonuses that have no native
-- kRO tooltip handler. We stub them as no-ops and let the Order entries
-- [7]-[11] below render the descriptive text.
-- ============================================================
function AddAutoSpell(skill_id, level, chance) end
function AddAutoSpellWhenHit(skill_id, level, chance) end
function AddEffectOnAttack(effect_id, chance) end
function AddMaxWeight(amount) end
function SubMaxWeight(amount) end
if type(GetEffectName) ~= "function" then
  local EFF_NAMES = {
    [1]="Stun",[2]="Frozen",[3]="Stone",[4]="Sleep",[5]="Poisoned",
    [6]="Cursed",[7]="Silenced",[8]="Confused",[9]="Blind",[10]="Bleeding",
    [11]="Deadly Poison",[127]="Burning",[128]="Freezing",
  }
  function GetEffectName(id)
    return EFF_NAMES[tonumber(id) or 0] or ("Effect " .. tostring(id))
  end
end
`;

const RDL_ORDER_ENTRIES = `,
\t\t\t-- ${RDL_ORDER_MARKER.replace("-- ", "")} (Marine Sphere etc.). Built-in EnableSkill.
\t\t\t[7] = {
\t\t\t\tname = "Enable to use Level {val} of {sep}",
\t\t\t\tfunc = { "EnableSkill" },
\t\t\t\tval = { [2] = Operation.ADD },
\t\t\t\tsep = { [1] = "GetSkillName" }
\t\t\t},
\t\t\t-- RDL custom: auto-cast on attack (AddAutoSpell stub).
\t\t\t[8] = {
\t\t\t\tname = "Random chance to auto-cast Level {val} of {sep} on attack",
\t\t\t\tfunc = { "AddAutoSpell" },
\t\t\t\tval = { [2] = Operation.ADD },
\t\t\t\tsep = { [1] = "GetSkillName" }
\t\t\t},
\t\t\t-- RDL custom: auto-cast when hit (AddAutoSpellWhenHit stub).
\t\t\t[9] = {
\t\t\t\tname = "Random chance to auto-cast Level {val} of {sep} when hit",
\t\t\t\tfunc = { "AddAutoSpellWhenHit" },
\t\t\t\tval = { [2] = Operation.ADD },
\t\t\t\tsep = { [1] = "GetSkillName" }
\t\t\t},
\t\t\t-- RDL custom: inflict status on attack (AddEffectOnAttack stub).
\t\t\t[10] = {
\t\t\t\tname = "Has {val}% chance of inflicting {sep} when attacking",
\t\t\t\tfunc = { "AddEffectOnAttack" },
\t\t\t\tval = { [2] = Operation.ADD },
\t\t\t\tsep = { [1] = "GetEffectName" }
\t\t\t},
\t\t\t-- RDL custom: max weight bonus (AddMaxWeight stub).
\t\t\t[11] = {
\t\t\t\tname = "{sym}{val}#Max Weight",
\t\t\t\tfunc = { "AddMaxWeight", "SubMaxWeight" },
\t\t\t\tval = { [1] = Operation.ADD },
\t\t\t\tsym = SymbolPreset.IncSign
\t\t\t}`;

// Write a fresh EquipmentPropertiesOrder.lub from the bundled template
// alongside the source .lub. The template ships pre-patched with the RDL
// custom Order entries [7]-[10] + stub Lua functions, so the kRO tooltip
// renderer always has the right definitions even if the user's GRF patcher
// overwrites the file. Existing destination is backed up first.
async function writeOrderFromTemplate(srcLubPath, logFn) {
  if (!srcLubPath) return { written: false };
  const sep = srcLubPath.includes("\\") ? "\\" : "/";
  const dir = srcLubPath.split(/[\\\/]/).slice(0, -1).join(sep);
  if (!dir) return { written: false };
  const destPath = dir + sep + "EquipmentPropertiesOrder.lub";

  // Locate the bundled template. Same lookup chain loadBonusTemplates uses:
  // (1) next to the exe, (2) <exe>\Resources\, (3) bundled via fetch().
  const exeDir = (typeof NL_PATH === "string" && NL_PATH) ? NL_PATH : "";
  const candidates = [];
  if (exeDir) {
    candidates.push(exeDir + "\\EquipmentPropertiesOrder.template.lub");
    candidates.push(exeDir + "\\Resources\\EquipmentPropertiesOrder.template.lub");
  }
  let templateText = null;
  for (const p of candidates) {
    const txt = await tryReadFile(p);
    if (txt) { templateText = txt; break; }
  }
  if (!templateText) {
    try {
      const res = await fetch("EquipmentPropertiesOrder.template.lub", { cache: "no-store" });
      if (res.ok) templateText = await res.text();
    } catch {}
  }
  if (!templateText) {
    if (typeof logFn === "function") logFn("Order template: bundle missing, skipping fresh-write step.");
    return { written: false };
  }

  // Compare to existing — if identical, skip (no need to bump mtime).
  try {
    const existing = await Neutralino.filesystem.readFile(destPath);
    if (existing === templateText) {
      if (typeof logFn === "function") logFn(`Order.lub: already matches bundled template (${templateText.length} bytes).`);
      return { written: false, unchanged: true };
    }
    // Backup before overwrite.
    await Neutralino.filesystem.writeFile(destPath + ".pre-rdl-template.bak", existing);
  } catch {
    // Destination doesn't exist — that's fine, we'll create it.
  }
  await Neutralino.filesystem.writeFile(destPath, templateText);
  if (typeof logFn === "function") {
    logFn(`Order.lub: wrote bundled template (${templateText.length} bytes) to ${destPath}`);
  }
  return { written: true, destPath };
}

// Patch all sibling EquipmentPropertiesOrder*.lub files alongside the
// source .lub. Idempotent — checks for RDL_ORDER_MARKER before touching
// anything. Returns { patched: [paths], skipped: [paths], errors: [{path, msg}] }.
async function patchOrderFiles(srcLubPath, logFn) {
  const result = { patched: [], skipped: [], errors: [] };
  if (!srcLubPath) return result;
  const sep = srcLubPath.includes("\\") ? "\\" : "/";
  const dir = srcLubPath.split(/[\\\/]/).slice(0, -1).join(sep);
  if (!dir) return result;

  // Look for any file named EquipmentPropertiesOrder[N].lub in the same dir.
  let entries = [];
  try {
    entries = await Neutralino.filesystem.readDirectory(dir);
  } catch (e) {
    return result;
  }
  const candidates = entries
    .filter(e => e.type === "FILE" && /^EquipmentPropertiesOrder\d*\.lub$/i.test(e.entry))
    .map(e => dir + sep + e.entry);

  for (const path of candidates) {
    try {
      const text = await Neutralino.filesystem.readFile(path);
      // Already patched AND has the latest entry [11] AddMaxWeight stub?
      // Skip. If [11] is missing (old v1 patch), fall through to re-patch
      // so the user gets the new tooltip render rules.
      if (text.includes(RDL_ORDER_MARKER) && /func\s*=\s*\{\s*"AddMaxWeight"/.test(text)) {
        result.skipped.push(path);
        continue;
      }
      // Old-version patch detected — strip the previous RDL block first so
      // we don't end up with duplicate entries (which the kRO validator
      // rejects with "invalid 'uniq2' field").
      let strippedText = text;
      if (text.includes(RDL_ORDER_MARKER)) {
        // Drop the stub block and the entries [7]..[N]
        strippedText = strippedText.replace(
          /\s*-- =+\s*\n--\s+RDL custom stubs[\s\S]*?-- =+\s*\nfunction AddAutoSpell[\s\S]*?\nend\s*\n(?:end\s*\n)?/m,
          ""
        );
        strippedText = strippedText.replace(
          /,\s*\n\s*-- RDL custom: skill grant[\s\S]*?\}\s*(?=\n\s*\}\s*\n\s*\},)/m,
          ""
        );
      }
      // Step 1: inject stub block after `EnumVAR = EnumVAR or {}` (or at
      // the very top if no such line exists). Use the strippedText so we
      // don't double-up on an existing (older) RDL block.
      let patched = strippedText;
      const enumMarker = "EnumVAR = EnumVAR or {}";
      if (patched.includes(enumMarker)) {
        patched = patched.replace(enumMarker, enumMarker + RDL_ORDER_STUB_BLOCK);
      } else {
        patched = RDL_ORDER_STUB_BLOCK + "\n" + patched;
      }
      // Step 2: inject Order entries after the AddDamage_SKID entry in
      // section [6] (Skill). Match the closing `}` of that entry, optionally
      // followed by a "Removed [7]" comment block.
      const orderPattern = /(sep\s*=\s*\{\s*\[2\]\s*=\s*"GetAddDamageSkillName"\s*\}\s*\})(\s*--\s*Removed\s*\[7\][^\n]*\n\s*--[^\n]*)?/;
      if (orderPattern.test(patched)) {
        patched = patched.replace(orderPattern, "$1" + RDL_ORDER_ENTRIES);
        // Write a backup + the new content.
        await Neutralino.filesystem.writeFile(path + ".pre-rdl-custom.bak", text);
        await Neutralino.filesystem.writeFile(path, patched);
        result.patched.push(path);
      } else {
        result.errors.push({ path, msg: "AddDamage_SKID anchor not found — Order file may use a different layout." });
      }
    } catch (e) {
      result.errors.push({ path, msg: String(e.message || e) });
    }
  }

  // Report what happened so the user can see Order file activity in the log.
  if (typeof logFn === "function") {
    if (result.patched.length) {
      logFn(`Order files: patched ${result.patched.length} (RDL custom entries added).`);
      for (const p of result.patched) logFn(`  + ${p}`);
    }
    if (result.skipped.length) {
      logFn(`Order files: ${result.skipped.length} already up-to-date.`);
    }
    if (result.errors.length) {
      for (const err of result.errors) {
        logFn(`Order file warning: ${err.path} — ${err.msg}`);
      }
    }
    if (!result.patched.length && !result.skipped.length && !result.errors.length) {
      logFn(`Order files: none found alongside source (looked in ${srcLubPath}'s directory).`);
    }
  }
  return result;
}

function applyEntries(sourceText, yamlItems, logFn, options) {
  const newCombiEntries = (options && options.newCombiEntries) || [];
  let lines = sourceText.split(/\r?\n/);

  // ---- Orphan cleanup (top of pipeline) ----
  // Previous broken runs sometimes appended `[N] = { ... }` items at the very
  // END of the file, after every top-level table closed. The kRO Lua loader
  // chokes on those with "unexpected symbol near '['". Detect that condition
  // here and trim back to the last properly-closed top-level table so the
  // rest of the pipeline starts from a sane state.
  const orphanTrimmed = trimOrphanItemsAtEOF(lines);
  if (orphanTrimmed.removed > 0) {
    lines = orphanTrimmed.lines;
    logFn(`Cleanup: removed ${orphanTrimmed.removed} orphan line(s) appended after the last top-level table by a previous run.`);
  }

  const [itemOpen] = findItemTableRange(lines);
  if (itemOpen == null) {
    const hint = looksLikePresetLub(sourceText)
      ? "\n\nThis file looks like the preset/order .lub (FunctionPreset, Operation, etc.), not the item table. Pick the matching EquipmentProperties.lub (without the `_order` / `order` suffix)."
      : "";
    throw new Error("Could not locate `Item = {` table in source .lub." + hint);
  }

  const spans = parseItemSpans(lines);

  const modifyList = [];   // existing items: [id, newBlockLines|null, item]
  const appendList = [];   // new items: [id, fullEntryLines]

  for (const item of yamlItems) {
    const id = parseInt(item.Id, 10);
    if (!Number.isFinite(id)) continue;
    if (spans.has(id)) {
      modifyList.push([id, buildOnStartEquipBlock(item), item]);
    } else {
      const [newId, entryLines] = buildFullEntry(item);
      appendList.push([newId, entryLines]);
    }
  }

  // Counters for a summary line at the end.
  let cnt_replaced = 0, cnt_added_block = 0, cnt_removed_block = 0, cnt_noop = 0, cnt_appended = 0;
  let cnt_combi_updated = 0, cnt_combi_added = 0;
  let cnt_stat_repaired = 0, cnt_stat_added = 0;

  // ---- Apply modifications bottom-up so line indices stay valid ----
  modifyList.sort((a, b) => spans.get(b[0])[0] - spans.get(a[0])[0]);
  let cnt_expanded = 0;
  for (let [id, newBlock, item] of modifyList) {
    let [spanS, spanE] = spans.get(id);

    // ---- Expand inline entries to multi-line BEFORE any modification ----
    // Single-line entries like `[18738] = { Type = "armor", Stat = {...} },`
    // can't have OnStartEquip / Combiitem / a repaired Stat block injected
    // in-place — the splice would land in the middle of the line. Convert
    // to multi-line form here so the rest of the modifier code can rely
    // on its usual one-field-per-line invariant. Bottom-up iteration keeps
    // earlier spans' line indices valid even after we add lines here.
    if (spanS === spanE) {
      const newEnd = expandInlineItemEntry(lines, spanS);
      if (newEnd != null) {
        spanE = newEnd;
        cnt_expanded++;
      }
    }

    // ---- Auto-repair broken Stat tables before any other modification ----
    // kRO's equipment scanner needs exactly 17 entries (slot 0 = DEF, slot 10
    // = Refineable, rest = 0). A `Stat = {}` (count 0) or any wrong count
    // throws "Item[N] has invalid 'Stat' table" at game start and discards
    // the whole entry — which in turn breaks any Combiitem that references
    // it. Rebuild from the YAML/conf's Def/Refineable fields so the entry
    // is loadable again.
    //
    // Cards: canonical kRO entries omit the Stat field entirely when the
    // card has no defensive stats (DEF=0, Refineable=false). Emitting an
    // all-zero Stat triggers the client warning "Item[N] has invalid 'Stat'
    // table(count: 0)" even though the table is syntactically 17 entries.
    // For card entries with no defensive value, drop the Stat field instead
    // of repairing or inserting it.
    // The Stat block's expected length is dictated by the `Type` field the
    // client will actually see at load time. If the .lub entry already has
    // a Type (most existing items do), use it as authoritative — that way
    // we never rebuild Stat to a count that disagrees with Type and trips
    // the kRO loader's "Item[N] has invalid 'Stat' table" error.
    const yamlLubType = resolveLubType(item);
    const existingType = readExistingType(lines, spanS, spanE);
    const lubTypeHere = existingType || yamlLubType;
    const isCard = lubTypeHere === "card";
    const expectedCount = statArraySize(lubTypeHere);
    const newStatArr = buildStatArray(item, lubTypeHere);
    // A card needs a Stat block ONLY if it has a real defensive value (DEF in
    // slot 0). buildStatArray() always sets the slot-10 "is equippable" flag,
    // so the old `newStatArr.some(v => v !== 0)` test was ALWAYS true for cards
    // — the drop branch below could never fire. The kRO client rejects a card
    // whose only non-zero slot is that flag with "invalid 'Stat' table(count:
    // 0)", so such cards must have the Stat field omitted entirely. Armor and
    // weapons always keep their Stat (they genuinely need the flag).
    const cardHasDef = (parseInt(item.Defense || 0, 10) || 0) !== 0;
    const needsStat = !isCard || cardHasDef;
    const statRange = findStatRange(lines, spanS, spanE);
    const statCount = countStatEntries(lines, statRange);
    if (isCard && !needsStat && statRange) {
      // Card with no defensive stats but file has a Stat block → drop it.
      lines.splice(statRange[0], statRange[1] - statRange[0] + 1);
      logFn(`  modified [${id}] - dropped all-zero Stat from card`);
      cnt_stat_repaired++;
      [spanS, spanE] = [spanS, findMatchingBrace(lines, spanS)];
    } else if (statRange && statCount !== expectedCount && needsStat) {
      const fixedLine = `    Stat = ${formatStatArray(newStatArr)},`;
      const fixedBlock = fixedLine.split("\n");
      lines.splice(statRange[0], statRange[1] - statRange[0] + 1, ...fixedBlock);
      logFn(`  modified [${id}] - repaired Stat table (was count=${statCount}, now ${expectedCount}; type=${lubTypeHere}, DEF=${parseInt(item.Defense || 0, 10) || 0}, Refineable=${item.Refineable ? 1 : 0})`);
      cnt_stat_repaired++;
      [spanS, spanE] = [spanS, findMatchingBrace(lines, spanS)];
    } else if (!statRange && needsStat) {
      // No Stat field at all and the item actually needs one → insert it.
      const spanEnd = findMatchingBrace(lines, spanS);
      const fixedLine = `    Stat = ${formatStatArray(newStatArr)},`;
      let k = spanEnd - 1;
      while (k > spanS && !lines[k].trim()) k--;
      const trimmed = lines[k].replace(/\s+$/, "");
      if (!trimmed.endsWith(",")) lines[k] = trimmed + ",";
      lines.splice(spanEnd, 0, ...fixedLine.split("\n"));
      logFn(`  modified [${id}] - added missing Stat table`);
      cnt_stat_added++;
      [spanS, spanE] = [spanS, findMatchingBrace(lines, spanS)];
    }

    // ---- Dedup against the Stat block ----
    // The kRO Stat block already carries stat bonuses in specific slots
    // (slot 2 = STR, 3 = INT, 4 = VIT, 5 = DEX, 6 = AGI, 7 = LUK, 10 = MDEF).
    // If newBlock emits the same AddExtParam(0, EID, V) the Stat already
    // provides, the tooltip will double-count. Strip the duplicates.
    if (newBlock) {
      const statRangeAfter = findStatRange(lines, spanS, findMatchingBrace(lines, spanS));
      const statValuesAfter = parseStatValues(lines, statRangeAfter);
      newBlock = dedupAgainstStatBlock(newBlock, statValuesAfter);
      newBlock = compactOnStartEquipBlock(newBlock);
      if (!newBlock.length) newBlock = null;
    }

    const existing = findOnStartEquipRange(lines, spanS, spanE);

    if (existing && newBlock) {
      lines.splice(existing[0], existing[1] - existing[0] + 1, ...newBlock);
      logFn(`  modified [${id}] - replaced OnStartEquip`);
      cnt_replaced++;
    } else if (existing && !newBlock) {
      lines.splice(existing[0], existing[1] - existing[0] + 1);
      logFn(`  modified [${id}] - removed OnStartEquip (no bonuses in YAML)`);
      cnt_removed_block++;
    } else if (!existing && newBlock) {
      const spanEnd = findMatchingBrace(lines, spanS);
      let k = spanEnd - 1;
      while (k > spanS && !lines[k].trim()) k--;
      const trimmed = lines[k].replace(/\s+$/, "");
      if (!trimmed.endsWith(",")) lines[k] = trimmed + ",";
      lines.splice(spanEnd, 0, ...newBlock);
      logFn(`  modified [${id}] - added OnStartEquip`);
      cnt_added_block++;
    } else {
      // Existing item has no OnStartEquip and the YAML item has no bonuses
      // either - silently skip (no log spam for potentially hundreds of these)
      cnt_noop++;
    }

    // ---- Update Combiitem if YAML has combo data ----
    const combo = item.Combo || item.Combos;
    if (combo && Array.isArray(combo)) {
      const ids = [];
      for (const c of combo) {
        if (c && typeof c === "object" && "Id" in c) ids.push(c.Id);
        else ids.push(c);
      }
      if (ids.length) {
        const currentEnd = findMatchingBrace(lines, spanS);
        const existingCombi = findCombiitemRange(lines, spanS, currentEnd);
        // MERGE with existing set IDs already in the source's Combiitem field
        // (an item can belong to multiple combo sets — e.g. Valkyrie Manteau
        // is in 2000000052, 2000000455, 2000000566, 2000000567 in stock).
        // Replacing instead of merging would silently destroy stock combos.
        let mergedIds = [...ids];
        if (existingCombi) {
          // Extract only numbers BETWEEN the field's `{` and matching `}`.
          // CRITICAL filter: keep only real combo set IDs (>= 2_000_000_000).
          // Older broken runs wrote *partner item IDs* (small numbers like
          // 2357, 5171) into Combiitem — those aren't valid set IDs and
          // the kRO client ignores them, so the (C) suffix never appears.
          // Dropping them on every Apply is how the field self-heals.
          const fieldText = lines.slice(existingCombi[0], existingCombi[1] + 1).join("\n");
          const braceMatch = fieldText.match(/\{([\s\S]*?)\}/);
          const inner = braceMatch ? braceMatch[1] : "";
          const existingNums = (inner.match(/\d+/g) || [])
            .map(Number).filter(n => Number.isFinite(n) && n >= 2000000000);
          mergedIds = [...new Set([...existingNums, ...ids])].sort((a, b) => a - b);
        }
        // Filter out DANGLING set IDs — references to combo entries that
        // don't actually exist in the global Combiitem table. The kRO client
        // bails on the entire Combiitem field when one ref can't be
        // resolved, so dangling IDs silently break OTHER (valid) combos
        // on the same item.
        const validSetIds = (options && options.validSetIds) || null;
        if (validSetIds) {
          mergedIds = mergedIds.filter(n => validSetIds.has(n));
        }
        if (mergedIds.length === 0) {
          // Nothing valid to write — skip the field entirely so we don't
          // leave an empty `Combiitem = {}` lying around.
          continue;
        }
        const combiLine = `    Combiitem = ${formatCombiitem(mergedIds)},`;
        const newCombiBlock = combiLine.split("\n");
        if (existingCombi) {
          lines.splice(existingCombi[0], existingCombi[1] - existingCombi[0] + 1, ...newCombiBlock);
          logFn(`  modified [${id}] - merged Combiitem set IDs (${mergedIds.length} total)`);
          cnt_combi_updated++;
        } else {
          let k = currentEnd - 1;
          while (k > spanS && !lines[k].trim()) k--;
          const trimmed = lines[k].replace(/\s+$/, "");
          if (!trimmed.endsWith(",")) lines[k] = trimmed + ",";
          lines.splice(currentEnd, 0, ...newCombiBlock);
          logFn(`  modified [${id}] - added Combiitem (${ids.length} set ID(s))`);
          cnt_combi_added++;
        }
      }
    }
  }

  // ---- Append new combo set definitions to the global Combiitem table ----
  let cnt_new_combi_global = 0;
  if (newCombiEntries.length) {
    const combi = parseExistingCombiTable(lines);
    if (combi.openLine != null) {
      const closeLine = findMatchingBrace(lines, combi.openLine);
      let k = closeLine - 1;
      while (k > combi.openLine && !lines[k].trim()) k--;
      // Ensure prior last entry ends with a comma before we splice in more.
      if (k > combi.openLine && lines[k].replace(/\s+$/, "").endsWith("}")) {
        lines[k] = lines[k].replace(/\s+$/, "") + ",";
      }
      const insertBlock = [];
      for (let n = 0; n < newCombiEntries.length; n++) {
        const e = newCombiEntries[n];
        const entryLines = formatCombiTableEntry(e.setId, e.partnerIds, e.script, "\t");
        // Add trailing comma to every entry except the last (Lua tolerates
        // trailing commas, but keep diffs minimal vs. the stock format).
        const isLast = n === newCombiEntries.length - 1;
        if (!isLast) entryLines[entryLines.length - 1] += ",";
        insertBlock.push(...entryLines);
        cnt_new_combi_global++;
      }
      lines.splice(closeLine, 0, ...insertBlock);
    } else {
      logFn(`Warning: could not locate global Combiitem table; ${newCombiEntries.length} new combo(s) not written.`);
    }
  }

  // ---- Append brand-new items before the Item table's closing brace ----
  if (appendList.length) {
    const [, itemClose2] = findItemTableRange(lines);
    let k = itemClose2 - 1;
    while (k > 0 && !lines[k].trim()) k--;
    if (k > 0 && lines[k].replace(/\s+$/, "").endsWith("}")) {
      lines[k] = lines[k].replace(/\s+$/, "") + ",";
    }
    const insertBlock = [];
    for (const [id, entryLines] of appendList) {
      insertBlock.push(...entryLines);
      cnt_appended++;
    }
    lines.splice(itemClose2, 0, ...insertBlock);
  }

  // Final summary so the user can always see what actually happened.
  const totalChanges = cnt_replaced + cnt_added_block + cnt_removed_block
    + cnt_appended + cnt_combi_updated + cnt_combi_added
    + cnt_stat_repaired + cnt_stat_added;
  logFn(`Summary: ${totalChanges} change(s) total`);
  logFn(`  - ${cnt_replaced} OnStartEquip replaced`);
  logFn(`  - ${cnt_added_block} OnStartEquip added`);
  logFn(`  - ${cnt_removed_block} OnStartEquip removed`);
  logFn(`  - ${cnt_appended} new item entries appended`);
  logFn(`  - ${cnt_combi_updated} Combiitem updated`);
  logFn(`  - ${cnt_combi_added} Combiitem added`);
  logFn(`  - ${cnt_new_combi_global} new combo set(s) appended to global Combiitem table`);
  logFn(`  - ${cnt_stat_repaired} Stat table repaired (was wrong count)`);
  logFn(`  - ${cnt_stat_added} Stat table inserted (was missing)`);
  logFn(`  - ${cnt_expanded} inline entries expanded to multi-line`);
  logFn(`  - ${cnt_noop} existing items without bonuses (skipped)`);

  return lines.join("\n") + (sourceText.endsWith("\n") ? "\n" : "");
}

// ============================================================================
// UI wiring
// ============================================================================

async function pickFile(title, filters) {
  try {
    const res = await Neutralino.os.showOpenDialog(title, { filters, multiSelections: false });
    if (res && res.length) return res[0];
  } catch (e) { log("Dialog error: " + (e.message || e)); }
  return null;
}

document.getElementById("browse-src").onclick = async () => {
  const p = await pickFile("Select source EquipmentProperties.lub",
    [{ name: "Lua/Lub files", extensions: ["lub", "lua"] }, { name: "All files", extensions: ["*"] }]);
  if (p) $src.value = p;
};
// (multi-DB picker is wired in setupDbList() below)
document.getElementById("browse-combo").onclick = async () => {
  const filters = FORMAT_MODE === "hercules"
    ? [{ name: "Hercules item_combo_db", extensions: ["conf", "txt"] }, { name: "All files", extensions: ["*"] }]
    : [{ name: "rAthena item_combos YAML", extensions: ["yml", "yaml"] }, { name: "All files", extensions: ["*"] }];
  const title = FORMAT_MODE === "hercules"
    ? "Select Hercules item_combo_db.conf"
    : "Select rAthena item_combos.yml";
  const p = await pickFile(title, filters);
  if (p) $combo.value = p;
};


document.getElementById("clear-log").onclick = () => { $log.textContent = ""; };

document.getElementById("new-session").onclick = async () => {
  const hasContent =
    ($src.value || "").trim() ||
    ($combo.value || "").trim() ||
    ITEM_DBS.some(p => (p || "").trim());
  if (hasContent) {
    const res = await Neutralino.os.showMessageBox(
      "ItemEquipGen",
      "Start a new session?\nAll current paths will be cleared.",
      "YES_NO", "QUESTION"
    );
    if (res !== "YES") return;
  }
  $src.value = "";
  $combo.value = "";
  ITEM_DBS = [""];
  saveItemDbs();
  renderDbList();
  autosaveSession();
  log("New session — all paths cleared.");
  toast("New session", "info");
};

document.getElementById("save-session").onclick = async () => {
  try {
    const path = await Neutralino.os.showSaveDialog("Save Session", {
      filters: [
        { name: "Session", extensions: ["epgsession", "json"] },
        { name: "All files", extensions: ["*"] },
      ],
      defaultPath: "session.epgsession",
    });
    if (!path) return;
    await Neutralino.filesystem.writeFile(path, JSON.stringify(getSession(), null, 2));
    log("Saved session: " + path);
    toast("Session saved", "success");
  } catch (e) {
    log("Save session failed: " + (e.message || e));
    toast("Save session failed", "error");
  }
};

document.getElementById("load-session").onclick = async () => {
  const picked = await pickFile("Load Session",
    [{ name: "Session", extensions: ["epgsession", "json"] },
     { name: "All files", extensions: ["*"] }]);
  if (!picked) return;
  try {
    const txt = await Neutralino.filesystem.readFile(picked);
    const s = JSON.parse(txt);
    if (!s || typeof s !== "object") throw new Error("not a session file");
    applySession(s);
    log("Loaded session: " + picked);
    toast("Session loaded", "success");
  } catch (e) {
    log("Load session failed: " + (e.message || e));
    toast("Load session failed", "error");
  }
};

document.getElementById("open-folder").onclick = async () => {
  const src = $src.value.trim();
  if (!src) return;
  const idx = Math.max(src.lastIndexOf("\\"), src.lastIndexOf("/"));
  const folder = idx >= 0 ? src.slice(0, idx) : "";
  if (!folder) return;
  try { await Neutralino.os.open(folder); }
  catch (e) { log("Open folder failed: " + (e.message || e)); }
};

// Parse one item-DB file's text into the rAthena-shaped item list the
// downstream pipeline expects. Returns an array (possibly empty).
function parseItemDbText(text) {
  if (FORMAT_MODE === "hercules") {
    const herc = parseHerculesConf(text);
    const EQUIP_TYPES = new Set([
      "IT_WEAPON", "IT_ARMOR", "IT_CARD", "IT_AMMO",
      "IT_PETARMOR", "IT_SHADOWGEAR",
    ]);
    return herc
      .filter(h => EQUIP_TYPES.has(h.Type))
      .filter(h => (h.Script && h.Script.trim()) || (h.OnEquipScript && h.OnEquipScript.trim()))
      .map(normalizeHerculesItem);
  }
  const data = loadItemYamlTolerant(text);
  return (data && data.Body) || [];
}

// js-yaml's default loader throws on the first duplicate mapping key, which
// aborts the entire DB. Real-world item_db override files often have a stray
// repeated key (e.g. `View:` listed twice in one item). Parse strictly first;
// if the only problem is a duplicated key, retry in JSON-compatible mode where
// the last value wins — matching how the server itself would resolve it — and
// warn so the user can fix the source.
function loadItemYamlTolerant(text) {
  try {
    return jsyaml.load(text);
  } catch (e) {
    const isDup = e && (e.reason === "duplicated mapping key" ||
                        /duplicated mapping key/i.test(e.message || ""));
    if (!isDup) throw e;
    const where = e.mark ? ` near line ${e.mark.line + 1}` : "";
    log(`  ! Duplicate key in YAML${where} — using the last value (please fix the source).`);
    return jsyaml.load(text, { json: true });
  }
}

document.getElementById("run").onclick = async () => {
  const src = $src.value.trim();
  const dbPaths = ITEM_DBS.map(p => (p || "").trim()).filter(Boolean);
  if (!src) return Neutralino.os.showMessageBox("ItemEquipGen", "Please pick a source .lub.", "OK", "ERROR");
  if (!dbPaths.length) return Neutralino.os.showMessageBox("ItemEquipGen",
    FORMAT_MODE === "hercules" ? "Please add at least one input .conf." : "Please add at least one input YAML.",
    "OK", "ERROR");

  const confirmRes = await Neutralino.os.showMessageBox(
    "ItemEquipGen",
    "This will write directly to:\n\n" + src + "\n\nA backup (.bak) will be created next to it. Continue?",
    "OK_CANCEL",
    "QUESTION"
  );
  if (confirmRes !== "OK") { log("Cancelled."); return; }

  $runBtn.disabled = true;
  setStatus("Working…", true);
  try {
    log(`Reading source:  ${src}`);
    let sourceText = await Neutralino.filesystem.readFile(src);
    let effectiveSrc = src;

    // Wrong-file guard: the user often picks the sibling preset/order .lub
    // (no Item table). If so, try the obvious sibling and switch silently
    // with a clear log line so they know what happened.
    const [maybeItemOpen] = findItemTableRange(sourceText.split(/\r?\n/));
    if (maybeItemOpen == null && looksLikePresetLub(sourceText)) {
      for (const candidate of siblingItemLubCandidates(src)) {
        const txt = await tryReadFile(candidate);
        if (!txt) continue;
        const [openLine] = findItemTableRange(txt.split(/\r?\n/));
        if (openLine != null) {
          log(`Selected file has no Item table - switching to sibling: ${candidate}`);
          $src.value = candidate;
          effectiveSrc = candidate;
          sourceText = txt;
          break;
        }
      }
    }

    // (Re)load skill DB relative to the source path so skill names resolve
    // in descriptions for this Apply (e.g. WZ_STORMGUST → "Storm Gust").
    try { await loadSkillDb(effectiveSrc); } catch (e) { log("Skill DB reload error: " + (e.message || e)); }

    // Merge all DBs in load order: LATER files OVERRIDE earlier ones for the
    // same Id. This matches rAthena/Hercules server semantics — when multiple
    // item_db files define the same Id, the last one loaded wins. So if
    // item_db_official.conf has [20860] with Script: <""> and a later file
    // item_db_official2.conf has [20860] with a real refine-scaled Script,
    // the later file's definition is what the server applies in-game — and
    // therefore what the tooltip should reflect too.
    const fmtLabel = FORMAT_MODE === "hercules" ? "CONF" : "YAML";
    const itemsById = new Map();      // id -> winning item entry
    const winnerSource = new Map();   // id -> winning DB path (for logs)
    const NO_BONUS_LOG_CAP = 10;
    let totalConflicts = 0;
    let totalNoBonus = 0;
    for (let p = 0; p < dbPaths.length; p++) {
      const dbPath = dbPaths[p];
      log(`Reading ${fmtLabel} [load order ${p + 1}]: ${dbPath}`);
      const dbText = await Neutralino.filesystem.readFile(dbPath);
      const items = parseItemDbText(dbText);
      log(`  Parsed ${items.length} item(s).`);
      let added = 0, overridden = 0, noBonus = 0;
      const overrideLog = [];
      for (const item of items) {
        const id = parseInt(item.Id, 10);
        if (!Number.isFinite(id)) continue;
        if (itemsById.has(id)) {
          overridden++;
          totalConflicts++;
          if (overrideLog.length < 5) {
            overrideLog.push(`  [${id}] overrides earlier definition from ${winnerSource.get(id)}`);
          }
        }
        if (!itemHasTranslatableBonuses(item)) {
          noBonus++;
          totalNoBonus++;
          if (noBonus <= NO_BONUS_LOG_CAP) {
            const label = item.AegisName || item.Name || "";
            log(`  ! No bonuses for [${id}]${label ? " " + label : ""} in this DB`);
          }
        }
        itemsById.set(id, item);
        winnerSource.set(id, dbPath);
        added++;
      }
      for (const ln of overrideLog) log(ln);
      if (overridden > 5) log(`  …and ${overridden - 5} more override(s) from this DB.`);
      if (noBonus > NO_BONUS_LOG_CAP) log(`  …and ${noBonus - NO_BONUS_LOG_CAP} more item(s) with no bonuses from this DB.`);
      log(`  +${added} merged (${overridden} overrode earlier files, ${noBonus} with no bonuses).`);
    }
    const body = [...itemsById.values()];
    log(`Merged total: ${body.length} item(s) across ${dbPaths.length} DB(s); ${totalConflicts} override(s) (later file wins); ${totalNoBonus} item(s) with no bonuses.`);

    if (!body.length) {
      const msg = FORMAT_MODE === "hercules"
        ? "No equipment items with bonus scripts were found in any input .conf."
        : "No items found under 'Body:' in any input YAML - nothing to do.";
      log(msg);
      await Neutralino.os.showMessageBox("ItemEquipGen", msg, "OK", "WARNING");
      return;
    }
    // ---- Optional: inject Combiitem data from item_combo file ----
    // Per kRO/FreyjaRO convention, an item's `Combiitem = { ... }` field
    // lists *combo set IDs* (not partner item IDs). Each combo set ID has a
    // matching entry in the global Combiitem table at the bottom of the .lub
    // (`Combiitem = { [set_id] = { Item = {...}, OnStartEquip = ... } }`).
    // For every combo in the user's combo DB we:
    //   1. resolve aegis names → item IDs
    //   2. look up an existing set_id by partner-id signature (so stock combos
    //      like Valkyrie 2000000052 get reused, no duplicates)
    //   3. if no match, allocate a new id and queue a global entry to append
    //   4. attach the chosen set_ids to each member item's Combo field
    // applyEntries() then writes them as Combiitem = { set_id, ... } and
    // appends the queued global entries to the bottom-of-file Combiitem table.
    const comboPath = $combo.value.trim();
    let pendingCombiEntries = [];   // { setId, partnerIds, script } to append
    if (comboPath) {
      try {
        log(`Reading combo DB: ${comboPath}`);
        const comboText = await Neutralino.filesystem.readFile(comboPath);
        let comboSets;
        if (FORMAT_MODE === "hercules") {
          comboSets = parseHerculesComboDb(comboText);
        } else {
          comboSets = parseRathenaComboDb(jsyaml.load(comboText));
        }
        log(`Parsed ${comboSets.length} combo set(s).`);
        const aegisToId = new Map();
        for (const item of body) {
          if (item.AegisName && item.Id != null) aegisToId.set(item.AegisName, parseInt(item.Id, 10));
        }

        // Parse the existing global Combiitem table so we can reuse stock IDs
        // when our combo's partner set matches one already defined there.
        const existingCombi = parseExistingCombiTable(sourceText.split(/\r?\n/));
        const allocId = makeIdAllocator(existingCombi.usedIds, existingCombi.maxId);

        // setId → list of member-item IDs (so we can attach the same set_id to
        // every member via item.Combo below).
        const setIdToMembers = new Map();
        const queuedEntries = [];

        for (const set of comboSets) {
          const names = set.names || [];
          const memberIds = names.map(n => aegisToId.get(n)).filter(id => id != null);
          if (memberIds.length < 2) continue;
          const key = combiPartnerKey(memberIds);
          let setId = existingCombi.partnersToId.get(key);
          if (setId == null) {
            setId = allocId();
            queuedEntries.push({
              setId,
              partnerIds: [...memberIds].sort((a, b) => a - b),
              script: set.script || "",
            });
            existingCombi.partnersToId.set(key, setId);
          }
          setIdToMembers.set(setId, [...new Set([...(setIdToMembers.get(setId) || []), ...memberIds])]);
        }

        // Attach set_ids to each member item. An item that's in multiple combos
        // gets all relevant set_ids; the applyEntries Combiitem writer merges
        // these with any set_ids already present in the source.
        const idToSets = new Map();
        for (const [setId, memberIds] of setIdToMembers) {
          for (const memberId of memberIds) {
            if (!idToSets.has(memberId)) idToSets.set(memberId, []);
            idToSets.get(memberId).push(setId);
          }
        }
        let injected = 0;
        for (const item of body) {
          const itemId = parseInt(item.Id, 10);
          const sets = idToSets.get(itemId);
          if (sets && sets.length) {
            item.Combo = [...new Set(sets)].sort((a, b) => a - b);
            injected++;
          }
        }
        pendingCombiEntries = queuedEntries;
        log(`Linked ${injected} item(s) to combo set IDs.`);
        log(`Reused ${setIdToMembers.size - queuedEntries.length} existing combo set(s); ${queuedEntries.length} new combo set(s) to append.`);
      } catch (e) {
        log(`Warning: could not load combo DB - ${e.message || e}`);
      }
    }

    // Compute the set of "known good" combo set IDs the kRO client will be
    // able to resolve after this Apply: every ID already in the source's
    // global Combiitem table plus every ID we're about to append. The
    // per-item Combiitem writer drops references not in this set (dangling
    // refs make kRO bail on the whole field, hiding OTHER valid combos).
    const validSetIds = new Set();
    try {
      const srcLines = sourceText.split(/\r?\n/);
      const existing = parseExistingCombiTable(srcLines);
      for (const id of existing.usedIds) validSetIds.add(id);
    } catch {}
    for (const e of pendingCombiEntries) validSetIds.add(e.setId);

    // Write a fresh EquipmentPropertiesOrder.lub from the bundled template.
    // The template ships pre-patched with RDL custom Order entries, so this
    // makes the kRO tooltip renderer consistent with what we're about to
    // emit into EquipmentProperties.lub — even if the user's GRF patcher
    // overwrote Order.lub since the last Apply.
    try { await writeOrderFromTemplate(effectiveSrc, log); }
    catch (e) { log(`Order-template write error: ${e.message || e}`); }

    // Also patch any OTHER sibling Order*.lub files (Order2.lub, etc.) that
    // we don't fully replace. Idempotent — files already marked are skipped.
    try { await patchOrderFiles(effectiveSrc, log); }
    catch (e) { log(`Order-file patch error: ${e.message || e}`); }

    log(`Applying ${body.length} item(s)…`);
    const updated = applyEntries(sourceText, body, log, {
      newCombiEntries: pendingCombiEntries,
      validSetIds,
    });

    // Write a backup next to the source before overwriting.
    const bakPath = effectiveSrc + ".bak";
    log(`Writing backup:  ${bakPath}`);
    await Neutralino.filesystem.writeFile(bakPath, sourceText);

    log(`Writing source:  ${effectiveSrc}`);
    await Neutralino.filesystem.writeFile(effectiveSrc, updated);

    log(`Done.`);
    setStatus(`Applied ${body.length} item(s) to source`, false);
    await Neutralino.os.showMessageBox("ItemEquipGen",
      `Applied ${body.length} item(s) to the source .lub.\n\nBackup saved to:\n${bakPath}`, "OK", "INFO");
  } catch (e) {
    log("ERROR: " + (e.message || JSON.stringify(e)));
    if (e.stack) log(e.stack);
    setStatus("Error - see log", false);
    await Neutralino.os.showMessageBox("ItemEquipGen",
      (e.message || JSON.stringify(e)), "OK", "ERROR");
  } finally {
    $runBtn.disabled = false;
  }
};

// ============================================================================
// Custom bonuses — persistence + modal UI
// ============================================================================

const CUSTOM_BONUSES_FILE_NAME = "custom_bonuses.json";

function getExeDir() {
  // NL_PATH is the runtime directory where the exe + resources.neu live.
  // Falls back to "." during unexpected environments.
  return (typeof NL_PATH === "string" && NL_PATH) ? NL_PATH : ".";
}

async function loadCustomBonuses() {
  const path = getExeDir() + "/" + CUSTOM_BONUSES_FILE_NAME;
  try {
    const txt = await Neutralino.filesystem.readFile(path);
    const data = JSON.parse(txt);
    if (Array.isArray(data)) {
      CUSTOM_BONUSES = data.filter(r => r && r.name);
      log(`Loaded ${CUSTOM_BONUSES.length} custom bonus rule(s) from ${CUSTOM_BONUSES_FILE_NAME}.`);
    }
  } catch (e) {
    // Missing file is fine.
  }
}

async function saveCustomBonuses() {
  const path = getExeDir() + "/" + CUSTOM_BONUSES_FILE_NAME;
  await Neutralino.filesystem.writeFile(path, JSON.stringify(CUSTOM_BONUSES, null, 2));
}

function renderCustomBonusList() {
  const list = document.getElementById("cb-list");
  list.innerHTML = "";
  if (!CUSTOM_BONUSES.length) {
    const empty = document.createElement("div");
    empty.className = "cb-empty";
    empty.textContent = "No custom rules yet. Add one below.";
    list.appendChild(empty);
    return;
  }
  CUSTOM_BONUSES.forEach((rule, idx) => {
    const row = document.createElement("div");
    row.className = "cb-item";
    row.innerHTML =
      `<div class="cb-item-main">` +
        `<div class="cb-name">${escapeHtml(rule.name)}` +
          `<span class="cb-args">(${rule.args || 0} arg${(rule.args || 0) === 1 ? "" : "s"})</span>` +
        `</div>` +
        `<div class="cb-lua">${escapeHtml(rule.lua || "")}</div>` +
        (rule.description ? `<div class="cb-desc">${escapeHtml(rule.description)}</div>` : ``) +
      `</div>` +
      `<button class="cb-del" data-idx="${idx}">Remove</button>`;
    list.appendChild(row);
  });
  for (const btn of list.querySelectorAll(".cb-del")) {
    btn.onclick = async () => {
      const i = parseInt(btn.getAttribute("data-idx"), 10);
      CUSTOM_BONUSES.splice(i, 1);
      await saveCustomBonuses();
      renderCustomBonusList();
    };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

document.getElementById("custom-bonuses").onclick = () => {
  renderCustomBonusList();
  document.getElementById("cb-modal").classList.add("show");
};
document.getElementById("cb-close").onclick = () => {
  document.getElementById("cb-modal").classList.remove("show");
};
document.getElementById("cb-add").onclick = async () => {
  const name = document.getElementById("cb-name").value.trim();
  const args = parseInt(document.getElementById("cb-args").value, 10) || 0;
  const lua  = document.getElementById("cb-lua").value.trim();
  const desc = document.getElementById("cb-desc").value.trim();
  if (!name) { await Neutralino.os.showMessageBox("ItemEquipGen", "Bonus name is required.", "OK", "WARNING"); return; }
  if (!lua)  { await Neutralino.os.showMessageBox("ItemEquipGen", "Lua template is required.", "OK", "WARNING"); return; }
  // Replace existing rule with same name (case-insensitive), else append
  const idx = CUSTOM_BONUSES.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
  const rule = { name, args, lua, description: desc };
  if (idx >= 0) CUSTOM_BONUSES[idx] = rule;
  else CUSTOM_BONUSES.push(rule);
  await saveCustomBonuses();
  document.getElementById("cb-name").value = "";
  document.getElementById("cb-args").value = "1";
  document.getElementById("cb-lua").value = "";
  document.getElementById("cb-desc").value = "";
  renderCustomBonusList();
};

// ============================================================================
// Tooltip Labels editor — edit EquipmentPropertiesOrder.lub from inside the app
// ============================================================================

let LBL_LINES = null;     // Order.lub lines (array)
let LBL_ITEMS = [];       // parsed editable label entries
let LBL_ORDER_PATH = "";  // resolved Order.lub path

function deriveOrderPath(srcPath) {
  if (!srcPath) return "";
  const idx = Math.max(srcPath.lastIndexOf("\\"), srcPath.lastIndexOf("/"));
  if (idx < 0) return "EquipmentPropertiesOrder.lub";
  return srcPath.slice(0, idx + 1) + "EquipmentPropertiesOrder.lub";
}

const LBL_NAME_RE = /^(\s*name\s*=\s*")([^"]*)(",?.*)$/;

function parseLabelsFromLub(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let currentCategory = "(root)";
  for (let i = 0; i < lines.length; i++) {
    const m = LBL_NAME_RE.exec(lines[i]);
    if (!m) continue;
    const [, prefix, value, suffix] = m;
    // A `name = "..."` without `{` and without `#` is treated as a category
    // header (e.g. `name = "Ability"`), not an editable tooltip label.
    if (!value.includes("{") && !value.includes("#")) {
      currentCategory = value;
      continue;
    }
    items.push({
      lineIdx: i, prefix, text: value, suffix,
      category: currentCategory,
      __originalText: value,
    });
  }
  return { lines, items };
}

async function loadLabelsFromDisk() {
  const src = document.getElementById("src").value.trim();
  const path = deriveOrderPath(src);
  if (!path) throw new Error("Could not derive EquipmentPropertiesOrder.lub path from the Source .lub.");
  LBL_ORDER_PATH = path;
  log(`Reading labels from: ${path}`);
  const text = await Neutralino.filesystem.readFile(path);
  const parsed = parseLabelsFromLub(text);
  LBL_LINES = parsed.lines;
  LBL_ITEMS = parsed.items;
  log(`Labels: loaded ${LBL_ITEMS.length} entries.`);
}

function renderLabelsList(filterText) {
  const list = document.getElementById("lbl-list");
  list.innerHTML = "";
  const filt = (filterText || "").toLowerCase();
  let currentCat = null;
  let shown = 0;
  for (let i = 0; i < LBL_ITEMS.length; i++) {
    const it = LBL_ITEMS[i];
    if (filt && !(
      it.text.toLowerCase().includes(filt) ||
      it.category.toLowerCase().includes(filt)
    )) continue;
    if (it.category !== currentCat) {
      currentCat = it.category;
      const h = document.createElement("div");
      h.className = "lbl-category";
      h.textContent = currentCat;
      list.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "lbl-item";
    const raw = document.createElement("div");
    raw.className = "lbl-raw";
    raw.textContent = it.__originalText;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "lbl-input";
    inp.value = it.text;
    inp.dataset.idx = String(i);
    inp.spellcheck = false;
    if (it.text !== it.__originalText) inp.classList.add("changed");
    inp.oninput = () => {
      const idx = parseInt(inp.dataset.idx, 10);
      LBL_ITEMS[idx].text = inp.value;
      if (LBL_ITEMS[idx].text !== LBL_ITEMS[idx].__originalText) {
        inp.classList.add("changed");
      } else {
        inp.classList.remove("changed");
      }
    };
    row.appendChild(raw);
    row.appendChild(inp);
    list.appendChild(row);
    shown++;
  }
  if (!shown) {
    const empty = document.createElement("div");
    empty.className = "lbl-empty";
    empty.textContent = filt ? "No labels match your filter." : "No labels loaded.";
    list.appendChild(empty);
  }
}

async function saveLabelsToDisk() {
  if (!LBL_LINES || !LBL_ORDER_PATH) return;
  let changed = 0;
  for (const it of LBL_ITEMS) {
    if (it.text === it.__originalText) continue;
    LBL_LINES[it.lineIdx] = it.prefix + it.text + it.suffix;
    changed++;
  }
  if (!changed) {
    await Neutralino.os.showMessageBox("ItemEquipGen", "No changes to save.", "OK", "INFO");
    return;
  }
  const text = LBL_LINES.join("\n");
  log(`Writing backup:  ${LBL_ORDER_PATH}.bak`);
  const original = await Neutralino.filesystem.readFile(LBL_ORDER_PATH);
  await Neutralino.filesystem.writeFile(LBL_ORDER_PATH + ".bak", original);
  log(`Writing labels:  ${LBL_ORDER_PATH}`);
  await Neutralino.filesystem.writeFile(LBL_ORDER_PATH, text);
  for (const it of LBL_ITEMS) it.__originalText = it.text;
  log(`Saved ${changed} label change(s). Restart the client to see them.`);
  await Neutralino.os.showMessageBox("ItemEquipGen",
    `Saved ${changed} label change(s).\n\nBackup saved to:\n${LBL_ORDER_PATH}.bak\n\nRestart the client to see the new labels.`,
    "OK", "INFO");
}

document.getElementById("edit-labels").onclick = async () => {
  try {
    await loadLabelsFromDisk();
    document.getElementById("lbl-search").value = "";
    renderLabelsList("");
    document.getElementById("lbl-modal").classList.add("show");
  } catch (e) {
    await Neutralino.os.showMessageBox("ItemEquipGen",
      "Could not load labels:\n" + (e.message || e), "OK", "ERROR");
  }
};
document.getElementById("lbl-close").onclick = () => {
  document.getElementById("lbl-modal").classList.remove("show");
};
document.getElementById("lbl-reload").onclick = async () => {
  try {
    await loadLabelsFromDisk();
    document.getElementById("lbl-search").value = "";
    renderLabelsList("");
  } catch (e) {
    await Neutralino.os.showMessageBox("ItemEquipGen",
      "Reload failed:\n" + (e.message || e), "OK", "ERROR");
  }
};
document.getElementById("lbl-save").onclick = async () => {
  try { await saveLabelsToDisk(); }
  catch (e) {
    await Neutralino.os.showMessageBox("ItemEquipGen",
      "Save failed:\n" + (e.message || e), "OK", "ERROR");
  }
};
document.getElementById("lbl-search").oninput = (e) => {
  renderLabelsList(e.target.value);
};

// ---- About modal ----
document.getElementById("about").onclick = () => {
  document.getElementById("about-modal").classList.add("show");
};
document.getElementById("about-close").onclick = () => {
  document.getElementById("about-modal").classList.remove("show");
};
document.getElementById("about-open-site").onclick = async () => {
  try { await Neutralino.os.open("https://ragnarokdeveloperslounge.com/"); }
  catch (e) { log("Could not open website: " + (e.message || e)); }
};

// ---- Menu bar (File / Edit dropdowns) ----
(function setupMenuBar() {
  const menubar = document.getElementById("menubar");
  if (!menubar) return;
  const menus = menubar.querySelectorAll(".menu");

  function closeAll() {
    for (const m of menus) m.classList.remove("open");
  }

  // Open the dropdown for the clicked button; toggle if already open.
  for (const btn of menubar.querySelectorAll(".menu-btn")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const parent = btn.parentElement;
      const wasOpen = parent.classList.contains("open");
      closeAll();
      if (!wasOpen) parent.classList.add("open");
    });
    // Hover-to-switch once a menu is open (classic menubar behaviour)
    btn.addEventListener("mouseenter", () => {
      const anyOpen = menubar.querySelector(".menu.open");
      if (anyOpen) {
        closeAll();
        btn.parentElement.classList.add("open");
      }
    });
  }

  // Clicking any menu item runs its onclick (wired elsewhere) and closes.
  for (const item of menubar.querySelectorAll(".menu-item")) {
    item.addEventListener("click", () => closeAll());
  }

  // Click anywhere outside the menu bar closes all dropdowns.
  document.addEventListener("click", (e) => {
    if (!menubar.contains(e.target)) closeAll();
  });

  // Esc closes all dropdowns.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll();
  });
})();

// ---- Format toggle (rAthena / Hercules) ----
(function setupFormatToggle() {
  const toggle = document.getElementById("format-toggle");
  if (!toggle) return;
  // Apply persisted mode without showing a toast on first paint
  setFormatMode(FORMAT_MODE, false);
  for (const opt of toggle.querySelectorAll(".format-opt")) {
    opt.addEventListener("click", () => {
      const mode = opt.getAttribute("data-mode");
      if (mode === FORMAT_MODE) return;
      setFormatMode(mode, true);
    });
  }
})();

// ============================================================================
// Item DB priority list — UI rendering and event wiring
// ============================================================================
function renderDbList() {
  const list = document.getElementById("db-list");
  if (!list) return;
  list.innerHTML = "";
  ITEM_DBS.forEach((pathVal, idx) => {
    const row = document.createElement("div");
    row.className = "db-row";
    row.dataset.idx = String(idx);
    row.innerHTML =
      `<span class="db-prio">${idx + 1}</span>` +
      `<input class="db-path" type="text" spellcheck="false" value="${escapeHtml(pathVal || "")}" />` +
      `<button class="db-btn db-up"     title="Move up"   type="button" ${idx === 0 ? "disabled" : ""}>▲</button>` +
      `<button class="db-btn db-down"   title="Move down" type="button" ${idx === ITEM_DBS.length - 1 ? "disabled" : ""}>▼</button>` +
      `<button class="db-btn db-browse" title="Browse…"   type="button">…</button>` +
      `<button class="db-btn db-remove" title="Remove"    type="button" ${ITEM_DBS.length === 1 ? "disabled" : ""}>×</button>`;
    list.appendChild(row);
  });
}

function dbBrowseFilters() {
  return FORMAT_MODE === "hercules"
    ? [{ name: "Hercules item_db", extensions: ["conf", "txt"] }, { name: "All files", extensions: ["*"] }]
    : [{ name: "rAthena YAML",     extensions: ["yml", "yaml"]  }, { name: "All files", extensions: ["*"] }];
}
function dbBrowseTitle() {
  return FORMAT_MODE === "hercules"
    ? "Select Hercules item_db.conf"
    : "Select rAthena item_db YAML";
}

(function setupDbList() {
  const list = document.getElementById("db-list");
  const addBtn = document.getElementById("add-db");
  if (!list || !addBtn) return;

  renderDbList();

  // Delegated event handler for all in-row controls + path edits.
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest(".db-btn");
    if (!btn) return;
    const row = btn.closest(".db-row");
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    if (btn.classList.contains("db-up") && idx > 0) {
      [ITEM_DBS[idx - 1], ITEM_DBS[idx]] = [ITEM_DBS[idx], ITEM_DBS[idx - 1]];
      saveItemDbs(); renderDbList();
    } else if (btn.classList.contains("db-down") && idx < ITEM_DBS.length - 1) {
      [ITEM_DBS[idx + 1], ITEM_DBS[idx]] = [ITEM_DBS[idx], ITEM_DBS[idx + 1]];
      saveItemDbs(); renderDbList();
    } else if (btn.classList.contains("db-remove") && ITEM_DBS.length > 1) {
      ITEM_DBS.splice(idx, 1);
      saveItemDbs(); renderDbList();
    } else if (btn.classList.contains("db-browse")) {
      const picked = await pickFile(dbBrowseTitle(), dbBrowseFilters());
      if (picked) {
        ITEM_DBS[idx] = picked;
        saveItemDbs(); renderDbList();
      }
    }
  });

  list.addEventListener("input", (e) => {
    const inp = e.target.closest(".db-path");
    if (!inp) return;
    const row = inp.closest(".db-row");
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    ITEM_DBS[idx] = inp.value;
    saveItemDbs();
  });

  addBtn.addEventListener("click", async () => {
    // Add a new empty slot, then immediately invite the user to pick a file.
    // If they cancel, the empty slot remains so they can paste a path manually.
    ITEM_DBS.push("");
    saveItemDbs(); renderDbList();
    const picked = await pickFile(dbBrowseTitle(), dbBrowseFilters());
    if (picked) {
      ITEM_DBS[ITEM_DBS.length - 1] = picked;
      saveItemDbs(); renderDbList();
    }
  });
})();

Neutralino.events.on("windowClose", () => Neutralino.app.exit());
Neutralino.events.on("ready", async () => {
  await loadBonusTemplates();
  await loadCustomBonuses();
  // Best-effort skill DB load on startup using the default source path.
  // Will be re-loaded with the actual source on every Apply.
  try { await loadSkillDb($src.value.trim()); } catch {}
});

// Build marker — if you don't see this exact tag in the log on startup,
// the running app is still loading an older resources.neu and needs a
// full restart (close the window AND make sure the process has exited).
const BUILD_TAG = "build-2026-05-22-card-stat-r23";
log(`Ready. [${BUILD_TAG}]`);