// JSON schemas for the structured Claude calls (`claude -p --json-schema`). Key order matters: it is part of the CLI argument.

/** new round / revise: dishes with ingredient amounts in grams */
export const ROUND_SCHEMA = {
  "type": "object",
  "required": [
    "nachricht",
    "kandidaten"
  ],
  "properties": {
    "nachricht": {
      "type": "string",
      "description": "1–4 sentences to the household: what changed and why"
    },
    "kandidaten": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "slot"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "kebab-case; reuse the old id to keep or modify a dish"
          },
          "slot": {
            "type": "string"
          },
          "keep": {
            "type": "boolean",
            "description": "true = keep this existing dish unchanged; omit all other fields"
          },
          "titel": {
            "type": "string"
          },
          "untertitel": {
            "type": "string"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "aktiv": {
            "type": "integer",
            "description": "active prep minutes for this dish"
          },
          "pitch": {
            "type": "string"
          },
          "warum": {
            "type": "string"
          },
          "risiko": {
            "type": "string"
          },
          "antwort": {
            "type": "string",
            "description": "reply to the household's note on this dish, if any"
          },
          "bild_suche": {
            "type": "string",
            "description": "short English Wikimedia Commons query for a photo"
          },
          "rechnung": {
            "type": "object",
            "required": [
              "haupt"
            ],
            "properties": {
              "haupt": {
                "type": "object",
                "additionalProperties": {
                  "type": "number"
                }
              },
              "pro_portion": {
                "type": "object",
                "additionalProperties": {
                  "type": "number"
                }
              }
            }
          }
        }
      }
    },
    "neue_zutaten": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": [
          "name",
          "kcal",
          "p",
          "kh",
          "eur_kg",
          "pack_g",
          "laden",
          "aisle"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "kcal": {
            "type": "number"
          },
          "p": {
            "type": "number"
          },
          "kh": {
            "type": "number"
          },
          "eur_kg": {
            "type": "number"
          },
          "pack_g": {
            "type": "number"
          },
          "laden": {
            "type": "string"
          },
          "aisle": {
            "type": "string",
            "enum": [
              "chilled",
              "produce",
              "dry",
              "frozen",
              "pantry"
            ]
          },
          "suche": {
            "type": "string"
          }
        }
      }
    }
  }
};

/** cooking plan for the chosen dishes */
export const PLAN_SCHEMA = {
  "type": "object",
  "required": [
    "titel",
    "rezepte",
    "prep",
    "geraete",
    "warum",
    "feedback"
  ],
  "properties": {
    "titel": {
      "type": "string",
      "description": "short catchy week title"
    },
    "rezepte": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "zutaten",
          "schritte",
          "kipppunkt",
          "anrichten",
          "portion"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "kurz": {
            "type": "string",
            "description": "one-word label for prep steps, e.g. 'Gulasch'"
          },
          "zutaten": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "gruppe",
                "items"
              ],
              "properties": {
                "gruppe": {
                  "type": "string"
                },
                "items": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              }
            }
          },
          "schritte": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "how to cook this dish on its own: 3–6 short steps, one action each, amounts inside"
          },
          "kipppunkt": {
            "type": "string"
          },
          "anrichten": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "portion": {
            "type": "object",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "description": "per person id: what goes into one box/plate"
          },
          "reihenfolge": {
            "type": "boolean",
            "description": "true if salad/veg first, starch last matters"
          },
          "rechner_label": {
            "type": "string",
            "description": "e.g. 'cooked chicken, total weight' if the main part is portioned by weight"
          },
          "zusammenbau_wann": {
            "type": "string",
            "description": "when to assemble one portion, e.g. 'morning, for the lunch box' / 'evening, before eating'"
          },
          "zusammenbau_min": {
            "type": "integer",
            "description": "minutes per day to assemble"
          },
          "packen_titel": {
            "type": "string",
            "description": "'Einpacken' for a packed lunch, 'Auf den Teller' at home (household language)"
          },
          "packen": {
            "type": "array",
            "description": "the daily routine as 2–3 rows of verb → action, e.g. 'Nimm' → 'deine Dose', 'Leg drauf' → '5 Salatblätter, 6 Tomaten'. Very short.",
            "items": {
              "type": "object",
              "required": [
                "wo",
                "was"
              ],
              "properties": {
                "wo": {
                  "type": "string",
                  "description": "container, e.g. 'Große Dose', 'Becher', 'Form A/B', 'Salatkopf'"
                },
                "was": {
                  "type": "string"
                }
              }
            }
          },
          "essen": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "0–2 tiny words-only steps at the table, e.g. 'umrühren', 'Reis zuletzt'"
          }
        }
      }
    },
    "vorbereitung": {
      "type": "array",
      "description": "everything outside the prep-day timeline, by day",
      "items": {
        "type": "object",
        "required": [
          "tag",
          "text"
        ],
        "properties": {
          "tag": {
            "type": "integer",
            "description": "day offset from the first eating day: -2 = two days before, 0 = first eating day"
          },
          "wann": {
            "type": "string",
            "description": "e.g. 'after shopping', 'evening', 'before the prep starts'"
          },
          "text": {
            "type": "string"
          }
        }
      }
    },
    "extras": {
      "type": "array",
      "description": "sides or components eaten with more than one dish (e.g. a pickled salad for lunch and dinner) — written once here with the amounts for all portions, never repeated inside each recipe",
      "items": {
        "type": "object",
        "required": [
          "id",
          "titel",
          "zutaten",
          "schritte"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "kebab-case"
          },
          "titel": {
            "type": "string"
          },
          "kurz": {
            "type": "string",
            "description": "one-word label"
          },
          "untertitel": {
            "type": "string"
          },
          "zutaten": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "gruppe",
                "items"
              ],
              "properties": {
                "gruppe": {
                  "type": "string"
                },
                "items": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              }
            }
          },
          "schritte": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "haltbar": {
            "type": "string",
            "description": "e.g. '7–10 Tage im Kühlschrank'"
          }
        }
      }
    },
    "zusatz_einkauf": {
      "type": "array",
      "description": "small items the recipes need that are neither in the calculated shopping list nor in the pantry file (vinegar, fresh herbs …). Never list what the pantry file already has.",
      "items": {
        "type": "object",
        "required": [
          "name",
          "menge",
          "preis"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "menge": {
            "type": "string",
            "description": "e.g. '1 Flasche (1 l)'"
          },
          "preis": {
            "type": "number",
            "description": "rough estimate in the household currency"
          }
        }
      }
    },
    "prep": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "t",
          "titel",
          "text"
        ],
        "properties": {
          "t": {
            "type": "string",
            "description": "offset like 0:00"
          },
          "titel": {
            "type": "string",
            "description": "2–4 word headline, e.g. 'Bällchen formen'"
          },
          "text": {
            "type": "string"
          },
          "gericht": {
            "type": "string",
            "description": "id of the recipe or extra this step belongs to; empty for general steps (preheating, cleaning, packing)"
          },
          "timer": {
            "type": "integer"
          },
          "neben": {
            "type": "boolean"
          },
          "wichtig": {
            "type": "boolean"
          }
        }
      }
    },
    "behaelter": {
      "type": "array",
      "description": "what goes into which container on prep day — max 3 rows, as few container types as possible",
      "items": {
        "type": "object",
        "required": [
          "name",
          "inhalt"
        ],
        "properties": {
          "name": {
            "type": "string",
            "description": "e.g. 'Große Dose (750 ml)'"
          },
          "anzahl": {
            "type": "integer"
          },
          "inhalt": {
            "type": "string"
          },
          "hinweis": {
            "type": "string",
            "description": "e.g. split per person"
          }
        }
      }
    },
    "geraete": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "vorrat": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "nicht_kaufen": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "feedback": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "warum": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "titel",
          "text"
        ],
        "properties": {
          "titel": {
            "type": "string"
          },
          "text": {
            "type": "string"
          }
        }
      }
    },
    "lagerung": {
      "type": "string"
    }
  }
};

/** ratings, blocked categories and rules from a week's feedback */
export const FEEDBACK_SCHEMA = {
  "type": "object",
  "required": [
    "bewertungen",
    "antwort"
  ],
  "properties": {
    "bewertungen": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "gericht",
          "note",
          "kommentar"
        ],
        "properties": {
          "gericht": {
            "type": "string"
          },
          "note": {
            "type": "string"
          },
          "kommentar": {
            "type": "string"
          }
        }
      }
    },
    "gesperrt": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "regeln": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "antwort": {
      "type": "string",
      "description": "2–4 sentences back to the household"
    }
  }
};
