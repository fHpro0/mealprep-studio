"""Household configuration (household.toml) and resolved paths."""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

PKG = Path(__file__).resolve().parent
REPO = PKG.parent

DEFAULT_PATHS = {
    "profile": "profile.md",
    "feedback": "feedback.md",
    "pantry": "pantry.md",
    "plans": "plans",
    "rounds": "rounds",
    "mailbox": "mailbox",
    "weeks": "weeks",
    "images": "img",
    "jobs": "jobs",
    "ingredients": "ingredients.json",
    "kitchen": "kitchen.json",
}

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


@dataclass
class Household:
    root: Path
    raw: dict
    paths: dict[str, Path] = field(default_factory=dict)

    # --- convenience accessors -------------------------------------------------
    @property
    def name(self) -> str:
        return self.raw.get("name", "Meal Prep Studio")

    @property
    def language(self) -> str:
        return self.raw.get("language", "en")

    @property
    def persons(self) -> list[dict]:
        return self.raw["persons"]

    @property
    def meals(self) -> list[dict]:
        return self.raw["meals"]

    @property
    def fixed_meals(self) -> list[dict]:
        return self.raw.get("fixed_meals", [])

    @property
    def days(self) -> int:
        return int(self.raw.get("schedule", {}).get("days", 4))

    @property
    def freeze_days(self) -> int:
        """The last N eating days are frozen on prep day and thawed the evening before."""
        return max(0, min(int(self.raw.get("schedule", {}).get("freeze_days", 0)), self.days - 1))

    @property
    def schedule(self) -> dict:
        s = {"days": 4, "shopping_day": "sat", "prep_day": "sun", "first_day": "mon"}
        s.update(self.raw.get("schedule", {}))
        return s

    @property
    def budget(self) -> float:
        return float(self.raw.get("budget", {}).get("per_round", 50))

    @property
    def currency(self) -> str:
        return self.raw.get("budget", {}).get("currency", "€")

    @property
    def offers(self) -> dict:
        o = {"enabled": False, "provider": "marktguru", "zip": "", "retailers": [], "markup": {},
             "second_store_min_saving": 3.0}
        o.update(self.raw.get("offers", {}))
        return o

    @property
    def agent(self) -> dict:
        a = {"command": "claude", "model": "sonnet", "effort": "", "timeout_min": 8, "candidates_per_meal": 4}
        a.update(self.raw.get("agent", {}))
        return a

    @property
    def server(self) -> dict:
        s = {"host": "0.0.0.0", "port": 8090, "pin": ""}
        s.update(self.raw.get("server", {}))
        return s

    @property
    def exclusions(self) -> list[str]:
        """Words that must never appear in a suggestion (allergies, intolerances, hard dislikes)."""
        return [w.lower() for w in self.raw.get("exclusions", [])]

    def meal_target(self, meal_id: str, person_id: str) -> float:
        meal = next(m for m in self.meals if m["id"] == meal_id)
        if "targets" in meal:
            return float(meal["targets"][person_id])
        person = next(p for p in self.persons if p["id"] == person_id)
        fixed = sum(f.get("kcal", 0) for f in self.fixed_meals)
        return (person["kcal"] - fixed) * float(meal["share"])

    def public(self) -> dict:
        """What the web app may see (no pin, no paths)."""
        return {
            "name": self.name, "language": self.language, "persons": self.persons, "meals": self.meals,
            "fixed_meals": self.fixed_meals, "days": self.days, "freeze_days": self.freeze_days, "budget": self.budget, "currency": self.currency,
            "offers": {"enabled": self.offers["enabled"], "zip": self.offers["zip"]},
            "pin": bool(self.server["pin"]),
            "meal_targets": {m["id"]: {p["id"]: round(self.meal_target(m["id"], p["id"])) for p in self.persons}
                             for m in self.meals},
        }


def load(data_dir: str | Path) -> Household:
    root = Path(data_dir).expanduser().resolve()
    cfg_file = root / "household.toml"
    if not cfg_file.exists():
        raise SystemExit(f"No household.toml in {root}. Run:  mealprep init {root}")
    raw = tomllib.loads(cfg_file.read_text(encoding="utf-8"))
    for key in ("persons", "meals"):
        if not raw.get(key):
            raise SystemExit(f"household.toml: [[{key}]] is missing")
    paths = {k: root / v for k, v in {**DEFAULT_PATHS, **raw.get("paths", {})}.items()}
    for k in ("plans", "rounds", "mailbox", "weeks", "images", "jobs"):
        paths[k].mkdir(parents=True, exist_ok=True)
    return Household(root=root, raw=raw, paths=paths)
