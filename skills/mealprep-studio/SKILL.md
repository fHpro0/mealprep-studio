---
name: mealprep-studio
description: Plans a week of meal prep with the Meal Prep Studio CLI (npx mealprep-studio). Use when the user wants a meal prep plan, weekly menu, shopping list, supermarket offers or prices, or to rate last week's food. Also German - Essensplan, Wochenplan, Meal Prep, Einkaufsliste, Angebote, Rezepte, Woche bewerten.
---

# Meal Prep Studio

Meal Prep Studio suggests dishes, calculates macros and prices, and writes recipes, a shopping list and a
prep-day timeline. All data lives in one "household folder" on the user's machine. Run the tool with
`npx -y mealprep-studio` (Node 22+; `bunx mealprep-studio` works too).

## When to use

Trigger on: meal prep plan, weekly menu, what to cook this week, shopping list, supermarket offers or
prices, rate or give feedback on last week's meals. German: Essensplan, Wochenplan, Meal Prep,
Einkaufsliste, Angebote, Rezepte, Woche bewerten, Feedback zur letzten Woche.

## Find or create the household folder

1. Ask where the household folder is. A folder is valid if it contains `household.toml`.
2. If there is none, create one (use `--lang de` for German):
   `npx -y mealprep-studio init ~/my-kitchen --lang en`
3. Help the user edit `household.toml` (people, kcal targets, budget, postcode) and `profile.md`.
   Ask before writing personal details such as allergies or health notes.
4. Verify: `npx -y mealprep-studio check ~/my-kitchen`. It needs the `claude` CLI, logged in. If it
   reports `claude cli: NOT FOUND`, tell the user to install Claude Code and stop.

## Commands

| Goal | Command |
|---|---|
| New dish suggestions | `npx -y mealprep-studio run <dir> neue_runde` |
| Revise after reactions | `npx -y mealprep-studio run <dir> ueberarbeiten <round-id>` |
| Write the week plan | `npx -y mealprep-studio run <dir> plan_erstellen <round-id>` |
| Take in feedback | `npx -y mealprep-studio run <dir> feedback_uebernehmen <round-id>` |
| Recalculate after hand edits | `npx -y mealprep-studio calc <dir> <round-id>` |
| Phone UI on the LAN | `npx -y mealprep-studio serve <dir> [--port N]` |

`<round-id>` is the first eating day, `YYYY-MM-DD`: the new file name in `<dir>/rounds/` after
`neue_runde`. Each action makes one `claude` call and takes 10 to 90 seconds.

## Typical flow

1. `check`, then `run <dir> neue_runde`. Read the new `rounds/<id>.json` and show the candidates
   (title, kcal, cost) to the user.
2. The user picks one dish per meal and reacts. The choice goes into `mailbox/<id>.json`
   (`auswahl`: `{meal id: dish id}`, plus `reaktionen`, `wuensche`). The web app writes this file when
   the user taps; for a chat flow, write it yourself, then run `ueberarbeiten` as needed.
3. `run <dir> plan_erstellen <id>` writes `weeks/<id>.json` and the printable `plans/woche-<id>.md`.
   Show the Markdown: recipes, shopping list with prices, prep timeline.
4. After cooking, collect ratings and run `feedback_uebernehmen <id>`. It updates `feedback.md`.

For the phone UI, run `serve` in the background and give the user the printed URL. Tell them to set
`pin` in `[server]` when other people share the Wi-Fi.

## Files in the household folder

| File | Content |
|---|---|
| `household.toml` | persons, kcal targets, meals, schedule, budget, offers (zip, shops), model, port, PIN |
| `profile.md` | free text Claude reads: goals, likes, dislikes, intolerances, equipment |
| `feedback.md` | ratings, blocked categories, rules (the app appends; the user may edit) |
| `pantry.md` | what the user already has at home |
| `ingredients.json` | own ingredients and real prices, overriding the package defaults |
| `kitchen.json` | kitchen equipment (pots, trays, sizes) |
| `rounds/`, `weeks/`, `plans/`, `mailbox/`, `img/`, `jobs/` | generated data; `jobs/backups/` keeps overwritten plans |

## Rules

- Personal data stays in the household folder. Never copy it into the repository, a gist or an issue.
- Supermarket offers (Germany and Austria only) come from marktguru.de. Set `[offers] enabled = false` for
  other countries; prices then come from the ingredient database.
- Calories and macros are estimates, not medical advice. Do not invent numbers: the tool calculates them.
- Never edit a generated `rounds/*.json` by hand without running `calc` afterwards.
- If an action fails, read `jobs/last-error.txt` and report the message instead of retrying blindly.
