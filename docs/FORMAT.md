# Data formats

All data is plain JSON/Markdown inside the household folder. Field names are German for
historical reasons (the project started as a German household's planner); they are stable.

## Folder layout (defaults, override with `[paths]` in household.toml)

| Key | Default | Content |
|---|---|---|
| `profile` | `profile.md` | free text for Claude |
| `feedback` | `feedback.md` | ratings table + blocked + rules (sections matched by heading: *Bewertungen/Ratings*, *Gesperrt/Blocked*, *Regeln/Rules*) |
| `pantry` | `pantry.md` | long-life items at home |
| `ingredients` | `ingredients.json` | household ingredients, merged over `data/ingredients.json` |
| `kitchen` | `kitchen.json` | kitchen equipment inventory (optional, edited in the web app) |
| `rounds` | `rounds/` | `<first-day>.json` suggestion rounds + `<id>-preise.json` store comparison |
| `mailbox` | `mailbox/` | what the web app writes: `<round>.json`, `feedback-<week>.json` |
| `weeks` | `weeks/` | `<first-day>.json` finished plans (the Menu/Shopping/Prep views) |
| `plans` | `plans/` | `woche-<first-day>.md` printable plan |
| `images` | `img/` | photos + `credits.json` |
| `jobs` | `jobs/` | status, offer cache, backups of overwritten plans, last error |

## Ingredient (`ingredients.json`)

```json
"haehnchenbrust": {
  "name": "Hähnchenbrustfilet", "name_en": "Chicken breast",
  "kcal": 105, "p": 23.5, "kh": 0,            // per 100 g
  "eur_kg": 7.99, "pack_g": 1000,             // price and usual pack (shopping rounds up to packs)
  "regulaer_eur_kg": 9.90,                    // optional: shelf price if eur_kg is an offer
  "laden": "Netto", "aisle": "chilled",       // aisle: chilled | produce | dry | frozen | pantry
  "pantry": false,                            // true = assumed at home, not on the shopping list
  "suche": "hähnchenbrust", "muss": "brust", "nicht": "curry|marin",  // offer search + filters (regex)
  "stueck_g": 60,                             // optional: weight of one piece (per-piece offers; "ca. N pcs" on produce rows of the shopping list)
  "quelle": "schaetzung"                      // where the price comes from
}
```

## Kitchen inventory (`kitchen.json`)

Optional, not created automatically. Edited in the web app (pot icon in the header) or by hand.
Claude plans only with these items and respects the notes (size, depth, capacity).

```json
{"items": [{"name": "Backblech / Fettpfanne", "anz": 1, "notiz": "nur ca. 2 cm Rand – keine flüssige Sauce"}],
 "aktualisiert": "2026-10-11T12:00:00"}
```

`name` 1–80 characters, `anz` integer 0–99, `notiz` up to 200 characters, max 100 items.
Without the file Claude assumes a normal home kitchen (1 oven with 1 baking tray, 2 pots, 1 pan).

## Round candidate (`rounds/<id>.json` → `kandidaten[]`)

```json
{
  "id": "moussaka", "slot": "abend",          // slot = meal id from household.toml
  "titel": "…", "untertitel": "…", "tags": ["…"], "aktiv": 25,
  "pitch": "…", "warum": "…", "risiko": "…", "antwort": "reply to your note",
  "bild": "img/kandidaten/moussaka.jpg", "bild_suche": "moussaka", "neu": true,
  "rechnung": {"haupt": {"hack_gemischt": 1500, "aubergine": 1050}, "pro_portion": {"reis": 40}},
  "berechnet": {"mengen": {}, "anteil": {"a": 0.14}, "makros": {}, "kosten": {}, "einkaufsliste": [], "skalierung": 1.03},
  "makros": {"a": {"kcal": 1110, "p": 76, "kh": 47}}, "kosten": 29.86
}
```

`haupt` = cooked once for everybody and split by weight (`anteil` per person and box);
`pro_portion` = identical per portion. `berechnet` is always written by the calculator.

## Mailbox (`mailbox/<round>.json`)

```json
{"auswahl": {"mittag": "caesar", "abend": "moussaka"},
 "reaktionen": {"caesar": {"daumen": 1, "notiz": "less parmesan"}},
 "wuensche": ["cheaper"], "idee": "something with salmon",
 "nachrichten": [{"zeit": "2026-10-05T17:42:54", "text": "…"}]}
```

## Week plan (`weeks/<id>.json`)

`titel, zeitraum, einkaufstag, preptag, budget{summe,limit}, hero, personen{}, fruehstueck,
rezepte[{id, slot, titel, untertitel, bild, tags, aktiv, portionen, makros{}, zutaten[{gruppe, items[]}],
kipppunkt, anrichten[], portion{person:[…]}, reihenfolge, rechner{label, <person>: share}, zusammenbau{wann, min}}],
vorbereitung[{datum, wann, text}],
einkauf[{bereich, items[{name, anz, preis, a, laden}]}], vorrat[], nicht_kaufen[], geraete[],
prep[{t, text, timer, neben, wichtig}], warum[{titel, text}], feedback[], feedback_antwort`
